// What a statement is allowed to be, decided before anything reaches the database.
//
// The database is the real guard: every statement runs alone (the extended query protocol
// refuses a second one), inside a READ ONLY transaction that is always rolled back. This
// file is the layer in front of it, for the things a read-only transaction does not stop:
//
//   - commands that are not reads but still act, such as COPY ... TO PROGRAM (runs a shell
//     command as a superuser), LOAD (loads a library), DO and CALL;
//   - functions that reach past the transaction: dblink opens a second connection that is
//     not read-only; pg_read_file and lo_export touch the server's disk; pg_terminate_backend
//     ends other sessions; session advisory locks outlive the rollback;
//   - functions that run SQL handed to them as text (query_to_xml, ts_stat, crosstab), which
//     would carry any of the above past this check inside a string.
//
// To decide this it reads the text the way PostgreSQL's lexer does (src/backend/parser/scan.l):
// comments, the string forms, quoted names and dollar quoting. A reader that disagreed with
// the server about where a string ends could be shown a function call hidden "inside" a
// string, so the one setting that changes string lexing, standard_conforming_strings, is
// forced on for every statement (lib/db.js), and this reader assumes it.
//
// One pass, no backtracking: the cost is linear in the length of the text.

export const MAX_SQL_CHARS = 100_000;

// Commands a statement may start with. Each of these is a read; anything they could do
// beyond reading is either refused by the READ ONLY transaction or listed below.
export const ALLOWED_COMMANDS = ['select', 'with', 'values', 'table', 'show', 'explain'];
const ALLOWED = new Set(ALLOWED_COMMANDS);

// Functions this server never calls, with what each group would do. Matched only in call
// position (a name followed by an opening parenthesis), so a column that happens to share a
// prefix is not refused. Names are compared in lower case; PostgreSQL's own functions are
// all lower case, and a quoted upper-case name would not resolve to them anyway.
const DENIED_GROUPS = [
  {
    reason: 'opens a second connection, which is not read-only',
    exact: [],
    prefixes: ['dblink', 'pg_background'],
  },
  {
    reason: 'reads or writes files on the database server',
    exact: ['pg_stat_file', 'pg_logdir_ls'],
    prefixes: ['pg_read_', 'pg_ls_', 'pg_file_', 'lo_'],
  },
  {
    reason: 'runs SQL given to it as text, which this server cannot check',
    exact: ['query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'cursor_to_xml',
      'cursor_to_xmlschema', 'ts_stat', 'connectby'],
    prefixes: ['crosstab'],
  },
  {
    reason: 'acts on other sessions or on the server itself',
    exact: ['pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
      'pg_promote', 'pg_log_backend_memory_contexts', 'pg_log_standby_snapshot',
      'pg_import_system_collations', 'pg_start_backup', 'pg_stop_backup', 'pg_stat_statements_reset'],
    prefixes: ['pg_switch_', 'pg_create_', 'pg_drop_', 'pg_copy_', 'pg_replication_', 'pg_logical_',
      'pg_wal_replay_', 'pg_xlog_replay_', 'pg_backup_', 'pg_stat_reset'],
  },
  {
    reason: 'takes a lock that can outlive the transaction',
    exact: [],
    prefixes: ['pg_advisory_', 'pg_try_advisory_'],
  },
];

export function deniedReason(name) {
  const n = String(name).toLowerCase();
  for (const g of DENIED_GROUPS) {
    if (g.exact.includes(n) || g.prefixes.some((p) => n.startsWith(p))) return g.reason;
  }
  return null;
}

// Character classes from scan.l. Bytes 0x80 and up start and continue identifiers there; in
// JavaScript that is every code unit from U+0080.
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isIdentStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isIdentCont = (c) => isIdentStart(c) || (c >= 48 && c <= 57) || c === 36;
const isDigit = (c) => c >= 48 && c <= 57;
const QUOTE = 39; // '
const DQUOTE = 34; // "

// Where a single-quoted string that started at `i` (pointing at the opening quote) ends, or -1.
//   standard  '' is a quote inside the string; a backslash is an ordinary character
//   escape    E'...': as standard, and a backslash also escapes the next character
//   bits      B'...' and X'...': the first quote ends it (scan.l has no '' rule there)
function endOfString(s, i, mode) {
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (mode === 'escape' && c === 92) { j++; continue; }
    if (c === QUOTE) {
      if (mode !== 'bits' && s.charCodeAt(j + 1) === QUOTE) { j++; continue; }
      return j + 1;
    }
  }
  return -1;
}

// A double-quoted name; "" inside it is a literal quote. Returns [end, name] or [-1].
function endOfQuotedName(s, i) {
  let name = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === DQUOTE) {
      if (s.charCodeAt(j + 1) === DQUOTE) { name += '"'; j++; continue; }
      return [j + 1, name];
    }
    name += s[j];
  }
  return [-1];
}

// $tag$ ... $tag$. `i` points at the first $. Returns the end, -1 if unterminated, or null
// if this $ does not start a dollar quote (a parameter such as $1, or a lone $). The tag is
// empty or an identifier without $, as in scan.l's dolqdelim.
function endOfDollarQuote(s, i) {
  let j = i + 1;
  if (j < s.length && isIdentStart(s.charCodeAt(j))) {
    j++;
    while (j < s.length && (isIdentStart(s.charCodeAt(j)) || isDigit(s.charCodeAt(j)))) j++;
  }
  if (s.charCodeAt(j) !== 36) return null;
  const tag = s.slice(i, j + 1);
  const close = s.indexOf(tag, j + 1);
  return close === -1 ? -1 : close + tag.length;
}

// Skips whitespace and comments from `i`. Returns the next position, or -1 for a comment
// that never closes. Block comments nest in PostgreSQL.
function skipGap(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 45 && s.charCodeAt(i + 1) === 45) { // --
      i += 2;
      while (i < s.length && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (c === 47 && s.charCodeAt(i + 1) === 42) { // /*
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s.charCodeAt(i) === 47 && s.charCodeAt(i + 1) === 42) { depth++; i += 2; continue; }
        if (s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47) { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) return -1;
      continue;
    }
    break;
  }
  return i;
}

const refuse = (code, message) => ({ ok: false, code, message });

const UNTERMINATED = 'The SQL has an unterminated string, quoted name, comment or dollar-quoted block.';

// Checks one SQL text. Returns { ok: true, command } or { ok: false, code, message }, where
// message is written for the model that sent the SQL: what was refused and what to send.
export function checkSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    return refuse('empty', 'The sql argument is empty. Send one SQL statement.');
  }
  if (sql.length > MAX_SQL_CHARS) {
    return refuse('too_long', `The SQL is longer than ${MAX_SQL_CHARS.toLocaleString('en-US')} characters. Send a shorter statement.`);
  }

  const s = sql;
  let i = 0;
  let command = null; // the first token, lower case: an identifier, or "(" for a parenthesised query
  let ended = false; // a ; has been seen at the top level
  let pendingName = null; // the last identifier read, until we know whether a ( follows it

  for (;;) {
    i = skipGap(s, i);
    if (i === -1) return refuse('unterminated', UNTERMINATED);
    if (i >= s.length) break;
    const c = s.charCodeAt(i);

    if (ended) {
      return refuse('multiple_statements', 'Send one statement per call. This server runs a single read-only statement each time.');
    }

    // The string forms with a one-letter prefix: E'..' (backslash escapes), B'..' and X'..'
    // (bit strings), N'..'. This loop is always at the start of a token, because identifiers
    // are read whole below, so a letter followed by a quote here is the prefix, as in scan.l.
    // That includes a prefix straight after a number: PostgreSQL 14 reads 1e'..' as 1 followed
    // by an E string (15 and later refuse it as junk after a number).
    const next = s.charCodeAt(i + 1);
    if (next === QUOTE && (c === 69 || c === 101 || c === 66 || c === 98 || c === 88 || c === 120 || c === 78 || c === 110)) {
      const mode = (c === 69 || c === 101) ? 'escape' : (c === 78 || c === 110) ? 'standard' : 'bits';
      const end = endOfString(s, i + 1, mode);
      if (end === -1) return refuse('unterminated', UNTERMINATED);
      if (command === null) command = 'string';
      pendingName = null;
      i = end;
      continue;
    }
    // U&'..' and U&".."
    if ((c === 85 || c === 117) && next === 38 && (s.charCodeAt(i + 2) === QUOTE || s.charCodeAt(i + 2) === DQUOTE)) {
      if (s.charCodeAt(i + 2) === DQUOTE) {
        return refuse('unicode_name', 'Names written with Unicode escapes (U&"...") are not accepted. Write the name directly.');
      }
      const end = endOfString(s, i + 2, 'standard');
      if (end === -1) return refuse('unterminated', UNTERMINATED);
      if (command === null) command = 'string';
      pendingName = null;
      i = end;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < s.length && isIdentCont(s.charCodeAt(j))) j++;
      const word = s.slice(i, j).toLowerCase();
      if (command === null) command = word;
      pendingName = word;
      i = j;
      continue;
    }
    if (c === DQUOTE) {
      const [end, name] = endOfQuotedName(s, i);
      if (end === -1) return refuse('unterminated', UNTERMINATED);
      if (command === null) command = 'quoted name';
      pendingName = name.toLowerCase();
      i = end;
      continue;
    }
    if (c === QUOTE) {
      const end = endOfString(s, i, 'standard');
      if (end === -1) return refuse('unterminated', UNTERMINATED);
      if (command === null) command = 'string';
      pendingName = null;
      i = end;
      continue;
    }
    if (c === 36) { // $
      const end = endOfDollarQuote(s, i);
      if (end === -1) return refuse('unterminated', UNTERMINATED);
      if (end !== null) {
        if (command === null) command = 'string';
        pendingName = null;
        i = end;
        continue;
      }
      i++; // a parameter such as $1, or a lone $
      while (i < s.length && isDigit(s.charCodeAt(i))) i++;
      pendingName = null;
      continue;
    }
    if (c === 40) { // (
      if (command === null) command = '(';
      if (pendingName) {
        const why = deniedReason(pendingName);
        if (why) return refuse('denied_function', `${pendingName}() is not allowed: it ${why}. This server only reads data.`);
      }
      pendingName = null;
      i++;
      continue;
    }
    if (c === 46) { // . between parts of a qualified name: keep the name being read
      i++;
      continue;
    }
    if (c === 59) { // ;
      if (command === null) return refuse('empty', 'The sql argument is empty. Send one SQL statement.');
      ended = true;
      pendingName = null;
      i++;
      continue;
    }
    if (command === null) command = s[i];
    pendingName = null;
    i++;
  }

  if (command === null) return refuse('empty', 'The sql argument is empty. Send one SQL statement.');
  if (command !== '(' && !ALLOWED.has(command)) {
    const shown = /^[a-z_][a-z0-9_]{0,30}$/.test(command) ? command.toUpperCase() : 'This statement';
    return refuse('not_read', `${shown} is not allowed. This server runs read-only statements only: SELECT, WITH, VALUES, TABLE, SHOW and EXPLAIN.`);
  }
  return { ok: true, command };
}
