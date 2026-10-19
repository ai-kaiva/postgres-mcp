// MCP over stdio: one JSON-RPC message per line on stdin, one per line on stdout. Nothing
// else is ever written to stdout; logs go to stderr.
//
// Written by hand rather than with the SDK so the package depends on pg alone. The SDK
// brings an HTTP server, OAuth and schema libraries with it, none of which a stdio server
// uses, and a smaller tree is less to trust. The official SDK client and Claude Code are
// used to test it (scripts/postgres-mcp-client-check.mjs).
//
// Both eras of the protocol are served, the way Kaiva Bridge's gateway serves them
// (src/features/bridge/server/mcpToolShape.js):
//
//   legacy (2024-11-05 to 2025-11-25)  the client opens with initialize; the version agreed
//                                      there applies to the rest of the session
//   modern (2026-07-28)                no handshake; every request carries its version in
//                                      _meta, results carry resultType, lists and reads
//                                      carry ttlMs and cacheScope, and server/discover
//                                      answers what is supported. A modern version we do not
//                                      speak is refused with -32022, never downgraded.
//
// Fields a revision added are sent only to clients on that revision or later, so an older
// client receives exactly what it understands.

export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MODERN_VERSIONS = ['2026-07-28'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const LATEST_LEGACY = LEGACY_VERSIONS[0];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
export const isModernEra = (v) => isDate(v) && v >= MODERN_VERSIONS[0];
const since = (version, revision) => isDate(version) && version >= revision; // ISO dates order lexically

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const RESOURCE_NOT_FOUND = -32002;
export const UNSUPPORTED_VERSION = -32022;

export const MAX_LINE_CHARS = 8 * 1024 * 1024;
// A JSON-RPC batch (2025-03-26 allowed it; later revisions dropped it; a lenient server still
// answers one) is bounded, so one line cannot start thousands of statements at once.
export const MAX_BATCH = 100;

const TTL_STATIC_MS = 3_600_000; // the tool list and capabilities never change while running
const TTL_SCHEMA_MS = 60_000; // tables can be added or altered at any time

const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false } };

export function toolDefinitions(version, limits) {
  const seconds = Math.round(limits.timeoutMs / 1000);
  const rows = Number(limits.maxRows).toLocaleString('en-US');
  const annotate = (title) => (since(version, '2025-03-26')
    ? { annotations: { title, readOnlyHint: true, openWorldHint: false } } : {});
  const titled = (title) => (since(version, '2025-06-18') ? { title } : {});
  return [
    {
      name: 'query',
      ...titled('Query'),
      description: 'Run one read-only SQL statement against the PostgreSQL database and get the rows back as JSON. '
        + 'Allowed: SELECT, WITH, VALUES, TABLE, SHOW and EXPLAIN. '
        + `The statement runs in a read-only transaction that is always rolled back, stops after ${seconds} seconds, and returns at most ${rows} rows.`,
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'One SQL statement, for example SELECT id, total FROM orders ORDER BY created_at DESC LIMIT 20' } },
        required: ['sql'],
      },
      ...annotate('Query'),
    },
    {
      name: 'list_tables',
      ...titled('List tables'),
      description: 'List the tables and views this login can read, with their schema, type, estimated row count and comment.',
      inputSchema: {
        type: 'object',
        properties: { schema: { type: 'string', description: 'Only list this schema. Leave out to list every schema.' } },
      },
      ...annotate('List tables'),
    },
    {
      name: 'describe_table',
      ...titled('Describe table'),
      description: 'Describe one table or view: its columns (type, nullable, default, comment), primary key, unique and foreign keys, the tables that reference it, and its indexes. Use it before writing a query, to get column names and joins right.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table or view name, for example orders.' },
          schema: { type: 'string', description: 'The schema, when the name exists in more than one.' },
        },
        required: ['table'],
      },
      ...annotate('Describe table'),
    },
  ];
}

export function instructions(limits) {
  const rows = Number(limits.maxRows).toLocaleString('en-US');
  const chars = Number(limits.maxChars).toLocaleString('en-US');
  return 'Read-only access to one PostgreSQL database. Start with list_tables, then describe_table to see a table\'s columns and how it joins to others. '
    + 'Then use query with one statement per call. '
    + `Answers are capped at ${rows} rows and about ${chars} characters, so filter, aggregate or add LIMIT rather than reading whole tables.`;
}

// handlers: { callTool(name, args), listResources(cursor), readResource(uri) } (lib/service.js)
// write(message): sends one message. log(text): one line to stderr.
export function createServer({ handlers, name, version, limits, write, log = () => {} }) {
  let sessionVersion = null; // agreed by initialize
  const toolNames = new Set(toolDefinitions(LATEST_LEGACY, limits).map((t) => t.name));

  function implementation(v) {
    return {
      name,
      version,
      ...(since(v, '2025-06-18') ? { title: 'Kaiva Postgres MCP' } : {}),
      ...(since(v, '2025-11-25') ? {
        description: 'A maintained, read-only PostgreSQL MCP server. Drop-in replacement for the archived @modelcontextprotocol/server-postgres.',
        websiteUrl: 'https://kaiv.ai/bridge',
      } : {}),
    };
  }

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  async function dispatch(method, params, v, modern) {
    // Results in the modern era carry resultType and the producing server; lists and reads
    // carry how long they stay fresh. Legacy results are left exactly as they were.
    const shape = (result, ttlMs) => (modern
      ? { resultType: 'complete', ...result, ...(ttlMs !== undefined ? { ttlMs, cacheScope: 'private' } : {}), _meta: { [META_SERVER]: { name, version } } }
      : result);

    switch (method) {
      case 'initialize': {
        // Always a legacy opening: a modern client never sends it.
        const requested = params && params.protocolVersion;
        sessionVersion = LEGACY_VERSIONS.includes(requested) ? requested : LATEST_LEGACY;
        return {
          protocolVersion: sessionVersion,
          capabilities: CAPABILITIES,
          serverInfo: implementation(sessionVersion),
          ...(since(sessionVersion, '2025-03-26') ? { instructions: instructions(limits) } : {}),
        };
      }
      case 'server/discover':
        return shape({ supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES, instructions: instructions(limits) }, TTL_STATIC_MS);
      case 'ping':
        return shape({});
      case 'tools/list':
        return shape({ tools: toolDefinitions(v, limits) }, TTL_STATIC_MS);
      case 'tools/call': {
        const toolName = params && params.name;
        if (!toolNames.has(toolName)) return { error: [INVALID_PARAMS, `Unknown tool: ${String(toolName).slice(0, 100)}. The tools are query, list_tables and describe_table.`] };
        const result = await handlers.callTool(toolName, params.arguments);
        return shape(result);
      }
      case 'resources/list':
        return shape(await handlers.listResources(params && params.cursor), TTL_SCHEMA_MS);
      case 'resources/templates/list':
        return shape({ resourceTemplates: [] }, TTL_STATIC_MS);
      case 'resources/read': {
        const uri = params && typeof params.uri === 'string' ? params.uri : '';
        const found = uri ? await handlers.readResource(uri) : null;
        if (!found) return { error: [RESOURCE_NOT_FOUND, 'Resource not found. Use resources/list, or the list_tables tool, to see what exists.', { uri: uri.slice(0, 500) }] };
        return shape(found, TTL_SCHEMA_MS);
      }
      default:
        return { error: [METHOD_NOT_FOUND, `Method not found: ${String(method).slice(0, 100)}`] };
    }
  }

  // One message in, at most one message out (null for notifications and replies).
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail(null, INVALID_REQUEST, 'Invalid request');
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const id = hasId ? msg.id : null;
    if (typeof msg.method !== 'string') {
      // A reply to a request we never send, or a malformed message.
      if (hasId && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) return null;
      return fail(id, INVALID_REQUEST, 'Invalid request');
    }
    if (!hasId) return null; // notifications: initialized, cancelled, progress; nothing to answer

    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
    const declared = meta[META_VERSION];
    const modern = msg.method !== 'initialize' && isModernEra(declared);
    if (modern && !MODERN_VERSIONS.includes(declared)) {
      return fail(id, UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: String(declared) });
    }
    const v = modern ? declared : (sessionVersion || LATEST_LEGACY);
    try {
      const out = await dispatch(msg.method, params, v, modern);
      if (out && out.error) return fail(id, ...out.error);
      return ok(id, out);
    } catch (e) {
      log(`Internal error in ${msg.method}: ${e && e.message ? e.message : String(e)}`);
      return fail(id, INTERNAL_ERROR, 'Internal error');
    }
  }

  async function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { write(fail(null, PARSE_ERROR, 'Parse error')); return; }
    if (Array.isArray(msg)) { // a JSON-RPC batch
      if (!msg.length) { write(fail(null, INVALID_REQUEST, 'Invalid request')); return; }
      if (msg.length > MAX_BATCH) { write(fail(null, INVALID_REQUEST, `Batch too large: at most ${MAX_BATCH} messages`)); return; }
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (out.length) write(out);
      return;
    }
    const out = await handle(msg);
    if (out) write(out);
  }

  // Splits stdin into lines. A line longer than MAX_LINE_CHARS is answered with a parse
  // error and dropped up to its newline, so one huge message cannot exhaust memory.
  let buffer = '';
  let dropping = false;
  const pending = new Set();
  function feed(chunk) {
    let text = String(chunk);
    for (;;) {
      const nl = text.indexOf('\n');
      if (nl === -1) {
        if (!dropping) {
          buffer += text;
          if (buffer.length > MAX_LINE_CHARS) { buffer = ''; dropping = true; write(fail(null, PARSE_ERROR, 'Message too large')); }
        }
        return;
      }
      const piece = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (dropping) { dropping = false; continue; }
      const line = (buffer + piece).replace(/\r$/, '');
      buffer = '';
      if (!line.trim()) continue;
      const p = handleLine(line).catch((e) => log(`Failed to answer a message: ${e && e.message ? e.message : String(e)}`)).finally(() => pending.delete(p));
      pending.add(p);
    }
  }

  // Resolves when every message received so far has been answered.
  const settled = () => Promise.all([...pending]);

  return { handle, handleLine, feed, settled };
}
