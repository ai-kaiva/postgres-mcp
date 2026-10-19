// The tools and resources, wired to the database. lib/server.js speaks the protocol and
// calls into this; nothing here knows about JSON-RPC.

import { checkSql } from './sql.js';
import { formatRows, describeDbError, describeConnectError, isConnectionError, compactJson, DEFAULTS } from './format.js';
import { resourceBase, resourceUri, parseResourceUri } from './resources.js';
import { runReadOnly, readRows, listTables, describeTable, tableColumnsLegacy, assessLogin, MAX_TABLES } from './db.js';
import { decidePolicy, connectionHost, isLocalHost } from './policy.js';

const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
const pretty = (v) => JSON.stringify(v, null, 2); // resources/read keeps the archived server's layout

export function createService({ pool, url, limits = {}, allowSuperuser = false, log = () => {}, env = {}, local: localOverride }) {
  const lim = { ...DEFAULTS, timeoutMs: 15_000, ...limits };
  const base = resourceBase(url);
  const local = typeof localOverride === 'boolean' ? localOverride : isLocalHost(connectionHost(url, env));
  let policy = null; // decided on the first successful connection, then kept
  let deciding = null; // the check in flight, so calls that arrive together share one

  function ensurePolicy() {
    if (policy) return Promise.resolve(policy);
    if (!deciding) {
      deciding = runReadOnly(pool, lim.timeoutMs, assessLogin).then((login) => {
        policy = decidePolicy(login, { local, allowSuperuser });
        log(`Connected as ${login.user} to ${login.database}, PostgreSQL ${login.version}.`);
        for (const note of policy.notes) log(note);
        return policy;
      }).finally(() => { deciding = null; }); // a failure is not kept: the next call tries again
    }
    return deciding;
  }

  // Runs one piece of database work for a tool, turning every failure into a tool error the
  // model can read: the statement's own error, or what to check about the connection.
  async function guarded(work) {
    try {
      const p = await ensurePolicy();
      if (p.refuse) return toolError(p.refuse);
      return await work();
    } catch (e) {
      if (!isConnectionError(e)) return toolError(describeDbError(e, { timeoutMs: lim.timeoutMs }));
      log(`Database connection problem: ${describeConnectError(e)}`);
      return toolError(describeConnectError(e));
    }
  }

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  // A very wide table or a database with hundreds of tables could answer more than a model's
  // context takes; the same size cap as query answers, with a note.
  const capped = (text, advice) => (text.length <= lim.maxChars
    ? [{ type: 'text', text }]
    : [{ type: 'text', text: text.slice(0, lim.maxChars) }, { type: 'text', text: `The answer was cut at ${Number(lim.maxChars).toLocaleString('en-US')} characters, so it is not complete JSON. ${advice}` }]);

  const tools = {
    async query(args) {
      const sql = typeof args.sql === 'string' ? args.sql : '';
      if (!sql.trim()) return toolError('The sql argument is required: one SQL statement such as SELECT * FROM orders LIMIT 10.');
      const verdict = checkSql(sql);
      if (!verdict.ok) return toolError(verdict.message);
      return guarded(async () => {
        const { fields, rows } = await runReadOnly(pool, lim.timeoutMs, (c) => readRows(c, sql, lim.maxRows));
        return { content: formatRows(fields, rows, lim) };
      });
    },

    async list_tables(args) {
      return guarded(async () => {
        const { tables, more } = await runReadOnly(pool, lim.timeoutMs, (c) => listTables(c, str(args.schema)));
        const content = capped(compactJson(tables), 'Pass a schema to narrow the list.');
        if (!tables.length) {
          content.push({ type: 'text', text: str(args.schema)
            ? `No tables or views this login can read in schema ${str(args.schema)}. Call list_tables without a schema to see them all.`
            : 'This login cannot read any tables or views in this database.' });
        } else if (more) {
          content.push({ type: 'text', text: `Showing the first ${MAX_TABLES.toLocaleString('en-US')}. Pass a schema to narrow the list.` });
        }
        return { content };
      });
    },

    async describe_table(args) {
      const table = str(args.table);
      if (!table) return toolError('The table argument is required: a table or view name, such as orders.');
      return guarded(async () => {
        const found = await runReadOnly(pool, lim.timeoutMs, (c) => describeTable(c, table, str(args.schema)));
        if (!found) {
          return toolError(`No table or view named ${table}${str(args.schema) ? ` in schema ${str(args.schema)}` : ''} that this login can see. Use list_tables to see what exists.`);
        }
        return { content: capped(compactJson(found), 'Query information_schema.columns for the rest.') };
      });
    },
  };

  return {
    limits: lim,

    async callTool(name, args) {
      return tools[name](args && typeof args === 'object' && !Array.isArray(args) ? args : {});
    },

    // Every readable table and view, as the archived server listed them (it listed public
    // only), one page at a time.
    async listResources(cursor, pageSize = 500) {
      const p = await ensurePolicy();
      if (p.refuse) return { resources: [] };
      const { tables } = await runReadOnly(pool, lim.timeoutMs, (c) => listTables(c, null));
      const start = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
      const page = tables.slice(start, start + pageSize);
      return {
        resources: page.map((t) => ({
          uri: resourceUri(base, t.schema, t.name),
          mimeType: 'application/json',
          name: `"${t.schema === 'public' ? t.name : `${t.schema}.${t.name}`}" database schema`,
        })),
        ...(start + pageSize < tables.length ? { nextCursor: String(start + pageSize) } : {}),
      };
    },

    // null when the address is not one of ours or names nothing.
    async readResource(uri) {
      const ref = parseResourceUri(uri);
      if (!ref) return null;
      const p = await ensurePolicy();
      if (p.refuse) return null;
      const columns = await runReadOnly(pool, lim.timeoutMs, (c) => tableColumnsLegacy(c, ref.schema, ref.table));
      if (!columns.length) return null;
      return { contents: [{ uri, mimeType: 'application/json', text: pretty(columns) }] };
    },

    // At start-up: connect once, so problems reach the client's log before the first call.
    async warmUp() { await ensurePolicy(); },

    // For --check: the login and the decision, without a tool call.
    async check() {
      const login = await runReadOnly(pool, lim.timeoutMs, assessLogin);
      return { login, local, policy: decidePolicy(login, { local, allowSuperuser }) };
    },
  };
}
