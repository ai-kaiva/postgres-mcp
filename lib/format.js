// How rows become the text a model reads.
//
// The archived server returned JSON.stringify(rows, null, 2): every row, pretty-printed.
// A model's context is the scarce resource here (Claude Code, for one, refuses a tool
// answer over about 25,000 tokens), so this keeps the same shape, a JSON array of row
// objects, and adds three limits, each stated in the answer when it applies:
//
//   rows       at most maxRows rows are read from the database at all (lib/db.js)
//   size       the answer stops before maxChars characters (a first row that is alone longer
//              than that is cut, and the note says the text is not complete JSON)
//   one value  a value longer than maxCell characters is cut, and says so
//
// One row per line: still valid JSON, readable, and about a third smaller than
// indentation.

export const DEFAULTS = { maxRows: 1000, maxChars: 80_000, maxCell: 5_000 };

const fmt = (n) => Number(n).toLocaleString('en-US');

// Column names as keys. Two columns with the same name (SELECT a.id, b.id) would collapse
// into one key and lose a value, so a repeat gets _2, _3 and so on.
export function uniqueNames(fields) {
  const seen = new Map();
  const taken = new Set(fields.map((f) => f.name));
  return fields.map((f) => {
    const base = f.name;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n === 1) return base;
    let k = n;
    let name = `${base}_${k}`;
    while (taken.has(name)) name = `${base}_${++k}`;
    taken.add(name);
    return name;
  });
}

// A value as it goes into the answer. Long text is cut with a marker that says how long it
// was; a long JSON or array value becomes a cut string, since half an object is not JSON.
function cell(v, maxCell, state) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v); // NaN and Infinity would become null in JSON
  if (typeof v === 'string') {
    if (v.length <= maxCell) return v;
    state.cut = true;
    return `${v.slice(0, maxCell)}… [cut: ${fmt(v.length)} characters in total]`;
  }
  if (typeof v === 'object') {
    const text = JSON.stringify(v);
    if (text.length <= maxCell) return v;
    state.cut = true;
    return `${text.slice(0, maxCell)}… [cut: ${fmt(text.length)} characters in total]`;
  }
  return v;
}

// rows: arrays of values (rowMode 'array'), at most maxRows + 1 of them; the extra one only
// says that more exist. Returns the content blocks of a tool result.
export function formatRows(fields, rows, opts = {}) {
  const { maxRows, maxChars, maxCell } = { ...DEFAULTS, ...opts };
  const names = uniqueNames(fields);
  const state = { cut: false };
  const moreRows = rows.length > maxRows;
  const lines = [];
  let size = 4; // "[\n" and "\n]"
  let stoppedAtSize = false;
  let cutFirst = false;
  for (const raw of rows.slice(0, maxRows)) {
    const obj = {};
    names.forEach((name, i) => { obj[name] = cell(raw[i], maxCell, state); });
    const line = JSON.stringify(obj);
    if (!lines.length && size + line.length > maxChars) { // one row alone is over the cap
      lines.push(line.slice(0, Math.max(0, maxChars - size)));
      cutFirst = true;
      break;
    }
    if (lines.length && size + line.length + 2 > maxChars) { stoppedAtSize = true; break; }
    lines.push(line);
    size += line.length + 2;
  }
  const text = lines.length ? `[\n${lines.join(',\n')}\n]` : '[]';
  const notes = [];
  if (cutFirst) {
    notes.push(`The first row alone is longer than ${fmt(maxChars)} characters and was cut, so this is not complete JSON. Select fewer columns.`);
  } else if (stoppedAtSize) {
    notes.push(`Showing the first ${fmt(lines.length)} rows: the answer was cut at ${fmt(maxChars)} characters. Select fewer columns, add WHERE or LIMIT, or aggregate.`);
  } else if (moreRows) {
    notes.push(`Showing the first ${fmt(maxRows)} rows; the query returned more. Add WHERE or LIMIT, or aggregate, to see the rest.`);
  }
  if (state.cut) notes.push(`Values longer than ${fmt(maxCell)} characters were cut. Use substring() or left() to read a part of a long value.`);
  return [{ type: 'text', text }, ...(notes.length ? [{ type: 'text', text: notes.join(' ') }] : [])];
}

// A Postgres error, written so the model can correct the statement. Only the server's own
// message, detail, hint and position: never the connection string.
const SQLSTATE_HINT = {
  25006: 'This server is read-only: statements that change data, schema or settings are refused.',
  57014: null, // filled in with the time limit by the caller
  '0A000': null,
  42501: 'The database login has no permission for this. Ask for it to be granted, or query something else.',
  '42P01': 'Use list_tables to see the tables that exist, and describe_table for their columns.',
  42703: 'Use describe_table to see the columns this table has.',
  '42P02': 'Values cannot be passed as $1 here. Write them into the statement.',
  '55P03': 'Another session is holding a lock this statement needs. Try again shortly, or read a different table.',
};

export function describeDbError(err, { timeoutMs } = {}) {
  const e = err || {};
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === '57014') {
    const secs = Math.round((timeoutMs || 0) / 1000);
    return `The query ran longer than ${secs} second${secs === 1 ? '' : 's'} and was stopped. Add filters or LIMIT, or check the plan with EXPLAIN.`;
  }
  if (code === '42601' && /multiple commands/i.test(String(e.message || ''))) {
    return 'Send one statement per call. This server runs a single read-only statement each time.';
  }
  const sentence = (t) => { const x = String(t).trim(); return /[.!?]$/.test(x) ? x : `${x}.`; };
  const parts = [sentence(`${code ? `ERROR ${code}: ` : 'ERROR: '}${String(e.message || 'the database refused the statement')}`)];
  if (e.detail) parts.push(sentence(`Detail: ${e.detail}`));
  if (e.hint) parts.push(sentence(`Hint: ${e.hint}`));
  if (e.position) parts.push(`At character ${e.position}.`);
  if (SQLSTATE_HINT[code]) parts.push(SQLSTATE_HINT[code]);
  return parts.join(' ');
}

// A failure about reaching the database, rather than about a statement: no answer at all
// (no severity from the server), or the server's own codes for connections (class 08),
// logins (class 28), a database that does not exist, too many connections, and a server
// shutting down or ending this session.
const CONNECTION_CODES = new Set(['3D000', '53300', '57P01', '57P02', '57P03']);
export function isConnectionError(e) {
  if (!e || typeof e.severity !== 'string' || typeof e.code !== 'string') return true;
  return e.code.startsWith('08') || e.code.startsWith('28') || CONNECTION_CODES.has(e.code);
}

// Connection failures: say what to check without repeating the address or password.
export function describeConnectError(err) {
  const e = err || {};
  const code = String(e.code || '');
  if (code === 'ECONNREFUSED') return 'Could not connect: nothing is accepting connections at the database address. Check the host and port, and that PostgreSQL is running.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Could not connect: the database host name was not found. Check the host in the connection URL.';
  if (code === 'ETIMEDOUT' || /timeout/i.test(String(e.message || ''))) return 'Could not connect: the database did not answer in time. Check the host, port and any firewall between this machine and the database.';
  if (code === '28P01' || code === '28000') return 'Could not connect: the database refused the user name or password in the connection URL.';
  if (code === '3D000') return 'Could not connect: the database named in the connection URL does not exist.';
  if (/certificate|self[- ]signed|SSL|TLS/i.test(String(e.message || ''))) {
    return `Could not connect: the encrypted connection failed (${String(e.message || '').slice(0, 200)}). Add sslrootcert=<path to your provider's CA file> to the URL, or check sslmode.`;
  }
  return `Could not connect to the database: ${String(e.message || 'unknown error').slice(0, 300)}`;
}

// Tool answers spend the model's context, so: one array item per line, and an object's
// fields one per line with arrays inside it the same way. Still plain JSON.
export function compactJson(v) {
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => JSON.stringify(x)).join(',\n')}\n]` : '[]';
  if (v && typeof v === 'object') {
    const lines = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${Array.isArray(x) ? compactJson(x) : JSON.stringify(x)}`);
    return `{\n${lines.join(',\n')}\n}`;
  }
  return JSON.stringify(v);
}
