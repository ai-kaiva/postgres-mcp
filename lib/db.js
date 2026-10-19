// Everything that talks to PostgreSQL.
//
// Every statement, ours or the model's, goes through runReadOnly():
//
//   BEGIN TRANSACTION READ ONLY, with a statement time limit, a lock time limit and
//   standard_conforming_strings forced on (lib/sql.js reads strings assuming it)
//   -> the statement, through a cursor: the extended query protocol, so the server itself
//      refuses a second statement, and only maxRows + 1 rows are ever fetched
//   -> ROLLBACK, awaited
//   -> DISCARD ALL, so nothing a statement set up outlives it on a pooled connection
//
// If anything in the clean-up fails, the connection is destroyed rather than returned to
// the pool. A connection that stops answering is destroyed by a watchdog a few seconds
// after the statement time limit, so a dead network cannot hold a call open for ever.

import pg from 'pg';
import Cursor from 'pg-cursor';

// Values Postgres prints as text are returned as that text. pg turns dates and timestamps
// into JavaScript Dates, which serialise in UTC: a `date` of 2026-03-01 read on a machine
// east of UTC comes back as the previous day, and a timestamp loses its stated zone. bytea
// would become {"type":"Buffer","data":[...]}, one number per byte. These are the type
// OIDs from pg_type: date, time, timestamp, timestamptz, interval, timetz, bytea.
const AS_TEXT = new Set([1082, 1083, 1114, 1184, 1186, 1266, 17]);
// ...and their array types, which become arrays of that text.
const ARRAY_AS_TEXT = new Set([1182, 1183, 1115, 1185, 1187, 1270, 1001]);
const identity = (v) => v;
// bigint (int8) is a string in pg, so that no value loses precision. Most are counts and
// ids well inside JavaScript's exact range, and a model reads 2 more reliably than "2", so
// those become numbers; a value beyond 2^53 stays a string.
const int8 = (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; };

export const TYPES = {
  getTypeParser(oid, format) {
    if (format !== 'binary') {
      if (AS_TEXT.has(oid)) return identity;
      if (ARRAY_AS_TEXT.has(oid)) return (v) => pg.types.arrayParser.create(v, identity).parse();
      if (oid === 20) return int8;
      if (oid === 1016) return (v) => pg.types.arrayParser.create(v, int8).parse();
    }
    return pg.types.getTypeParser(oid, format);
  },
};

const LOCK_TIMEOUT_MS = 3000;
export const POOL_SIZE = 4;

export function createPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: POOL_SIZE,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    application_name: 'kaiva-postgres-mcp',
    types: TYPES,
  });
  // An idle connection the server closed (a restart, an idle timeout) is reported here.
  // Without a listener Node treats it as an unhandled error and the whole process exits,
  // taking the MCP server down with it. The pool has already dropped that connection.
  pool.on('error', () => {});
  return pool;
}

// Ends the socket under a client without waiting for the server, for a connection that has
// stopped answering. Pending queries on it fail, and the caller destroys the client.
function cut(client) {
  try { client.connection && client.connection.stream && client.connection.stream.destroy(); } catch { /* already gone */ }
}

// Calls wait their turn here rather than in the pool. pg counts a wait in the pool's queue
// against connectionTimeoutMillis, so a fifth call behind four slow ones would fail as if the
// database could not be reached. Each turn is bounded by the statement limit and the
// watchdog, so a wait here always ends.
const turns = new WeakMap();
function takeTurn(pool) {
  let t = turns.get(pool);
  if (!t) { t = { free: POOL_SIZE, waiting: [] }; turns.set(pool, t); }
  if (t.free > 0) { t.free--; return Promise.resolve(() => giveBack(t)); }
  return new Promise((resolve) => { t.waiting.push(() => resolve(() => giveBack(t))); });
}
function giveBack(t) {
  const next = t.waiting.shift();
  if (next) next(); else t.free++;
}

export async function runReadOnly(pool, timeoutMs, work) {
  const done = await takeTurn(pool);
  try {
    return await runOnClient(pool, timeoutMs, work);
  } finally {
    done();
  }
}

async function runOnClient(pool, timeoutMs, work) {
  const client = await pool.connect();
  let broken = null;
  const watchdog = setTimeout(() => {
    broken = new Error('The database stopped answering.');
    cut(client);
  }, timeoutMs + 5000);
  try {
    const ms = Math.max(1, Math.floor(timeoutMs));
    await client.query(
      'BEGIN TRANSACTION READ ONLY; '
      + `SET LOCAL statement_timeout = ${ms}; `
      + `SET LOCAL lock_timeout = ${Math.min(LOCK_TIMEOUT_MS, ms)}; `
      + `SET LOCAL idle_in_transaction_session_timeout = ${ms + 30_000}; `
      + 'SET LOCAL standard_conforming_strings = on',
    );
    return await work(client);
  } finally {
    clearTimeout(watchdog);
    let cleanupError = broken;
    if (!cleanupError) {
      try {
        await client.query('ROLLBACK');
        await client.query('DISCARD ALL');
      } catch (e) {
        cleanupError = e;
      }
    }
    client.release(cleanupError || undefined); // an error destroys the connection
  }
}

// Reads at most maxRows + 1 rows of one statement. Resolves { fields, rows } with rows as
// arrays of values; a statement that returns nothing gives empty fields and rows.
export function readRows(client, sql, maxRows) {
  return new Promise((resolve, reject) => {
    const cursor = client.query(new Cursor(sql, null, { rowMode: 'array', types: TYPES }));
    cursor.read(maxRows + 1, (err, rows, result) => {
      // On an error the cursor has already asked the server to resynchronise; closing it as
      // well would wait for a second ready signal that never comes.
      if (err) { reject(err); return; }
      const fields = ((result && result.fields) || []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
      cursor.close((closeErr) => (closeErr ? reject(closeErr) : resolve({ fields, rows: rows || [] })));
    });
  });
}

// Our own fixed SQL with parameters, through the same read-only transaction.
async function q(client, text, values = []) {
  const res = await client.query({ text, values, rowMode: 'array' });
  const fields = res.fields.map((f) => f.name);
  return res.rows.map((r) => Object.fromEntries(fields.map((n, i) => [n, r[i]])));
}

const NOT_SYSTEM = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";
const KINDS = "c.relkind IN ('r', 'p', 'v', 'm', 'f')";
const KIND_NAME = "CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END";

export const MAX_TABLES = 1000;

// Tables and views this login can read at least one column of. Partitions are left out:
// their parent is the table to query.
export async function listTables(client, schema) {
  const rows = await q(client, `
    SELECT n.nspname AS schema, c.relname AS name, ${KIND_NAME} AS type,
           CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS estimated_rows,
           obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${KINDS} AND ${NOT_SYSTEM} AND NOT c.relispartition
       AND ($1::text IS NULL OR n.nspname = $1)
       AND has_any_column_privilege(c.oid, 'SELECT')
     ORDER BY n.nspname, c.relname
     LIMIT ${MAX_TABLES + 1}`, [schema || null]);
  return { tables: rows.slice(0, MAX_TABLES), more: rows.length > MAX_TABLES };
}

// Finds a table by name, preferring the schemas on the search path. Exact name first, then
// the lower-case form (an unquoted name in SQL is folded to lower case).
async function findTable(client, table, schema) {
  for (const name of [...new Set([table, table.toLowerCase()])]) {
    const rows = await q(client, `
      SELECT c.oid, n.nspname AS schema, c.relname AS name, ${KIND_NAME} AS type
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${KINDS} AND ${NOT_SYSTEM} AND c.relname = $1 AND ($2::text IS NULL OR n.nspname = $2)
         AND has_any_column_privilege(c.oid, 'SELECT')
       ORDER BY (n.nspname = ANY (current_schemas(false))) DESC, n.nspname
       LIMIT 20`, [name, schema || null]);
    if (rows.length) return rows;
  }
  return [];
}

export async function describeTable(client, table, schema) {
  const found = await findTable(client, table, schema);
  if (!found.length) return null;
  const t = found[0];
  const oid = t.oid;
  const columns = await q(client, `
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
           pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`, [oid]);
  const constraints = await q(client, `
    SELECT conname AS name, CASE contype WHEN 'p' THEN 'primary key' WHEN 'u' THEN 'unique' WHEN 'f' THEN 'foreign key' END AS type,
           pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = $1 AND contype IN ('p', 'u', 'f')
     ORDER BY contype, conname`, [oid]);
  const referencedBy = await q(client, `
    SELECT conrelid::regclass::text AS "table", conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE confrelid = $1 AND contype = 'f'
     ORDER BY 1, 2 LIMIT 100`, [oid]);
  const indexes = await q(client, `
    SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     WHERE x.indrelid = $1 ORDER BY i.relname LIMIT 100`, [oid]);
  const [meta] = await q(client, `
    SELECT CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS estimated_rows,
           obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c WHERE c.oid = $1`, [oid]);
  return {
    schema: t.schema,
    name: t.name,
    type: t.type,
    estimated_rows: meta ? meta.estimated_rows : null,
    comment: meta ? meta.comment : null,
    columns,
    constraints,
    referenced_by: referencedBy,
    indexes,
    ...(found.length > 1 ? { also_in_schemas: found.slice(1).map((f) => f.schema) } : {}),
  };
}

// For resources/read, in exactly the archived server's shape: [{column_name, data_type}].
export async function tableColumnsLegacy(client, schema, table) {
  return q(client, `
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]);
}

// Who this connection is, and what it could do beyond reading.
export async function assessLogin(client) {
  const [row] = await q(client, `
    SELECT current_user AS "user", current_database() AS database, r.rolsuper AS superuser,
           current_setting('server_version') AS version, current_setting('server_version_num')::int AS version_num,
           ARRAY(SELECT b.rolname::text FROM pg_roles b
                  WHERE b.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_signal_backend')
                    AND pg_has_role(current_user, b.oid, 'MEMBER') ORDER BY 1) AS server_roles,
           EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relkind IN ('r', 'p') AND ${NOT_SYSTEM}
                      AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) AS can_write
      FROM pg_roles r WHERE r.rolname = current_user`);
  return row;
}
