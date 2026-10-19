// Which logins this server agrees to run as, decided from the connection URL and from what
// the database says about the login. No database access here, so every rule is testable.
//
// Every statement is read-only whatever the login, so a login that can write is fine: it is
// told once, on stderr, that nothing will be written. The question is the logins that can do
// more than change data: a superuser, or a member of pg_execute_server_program,
// pg_read_server_files, pg_write_server_files or pg_signal_backend. They can run programs or
// read files on the database server, or end other sessions. lib/sql.js refuses the commands
// and functions that do that, but a login that cannot do it at all is the stronger guard.
//
//   database on this machine   (localhost, 127.x, ::1, a socket, *.localhost, host.docker.internal:
//                              the Docker host is the developer's own computer)
//                              allowed, with a warning. Most local development databases
//                              have only the postgres superuser, refusing it would make this
//                              useless as a drop-in replacement, and an agent on this machine
//                              usually has a shell here already.
//   database anywhere else     refused unless --allow-superuser: there the login reaches a
//                              server the agent otherwise cannot touch.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::', 'host.docker.internal']);

// The host a URL connects to, as pg would read it: the URL's host, else a host= parameter
// (a socket directory), else PGHOST, else the default socket.
export function connectionHost(url, env = {}) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  let host = '';
  try { host = decodeURIComponent(u.hostname); } catch { host = u.hostname; }
  return host || u.searchParams.get('host') || env.PGHOST || '';
}

export function isLocalHost(host) {
  let h = String(host || '').toLowerCase();
  if (!h) return true; // no host: the default Unix socket on this machine
  if (h.startsWith('/')) return true; // a socket directory
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1); // localhost. is localhost
  if (h.startsWith('::ffff:')) h = h.slice(7); // an IPv4 address written as IPv6
  if (LOCAL_HOSTS.has(h) || h.endsWith('.localhost')) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// The URL with its password removed, for anything shown to a person.
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    for (const k of ['password', 'sslpassword', 'sslkey']) if (u.searchParams.has(k)) u.searchParams.set(k, '****');
    return u.href;
  } catch {
    return '(the connection URL could not be read)';
  }
}

export function validateUrl(url) {
  if (!url) return 'Give a PostgreSQL connection URL, for example postgresql://user:password@localhost:5432/mydb';
  let u;
  try { u = new URL(url); } catch { return 'The connection URL could not be read. It should look like postgresql://user:password@host:5432/database'; }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    return `The connection URL must start with postgresql:// or postgres:// (it starts with ${u.protocol}//).`;
  }
  return null;
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

// The SQL a person runs once to make a login that can only read. PostgreSQL 14 added
// pg_read_all_data, which covers every schema in one line; before that, per schema.
export function readOnlyLoginSql(database, versionNum) {
  const lines = ["CREATE ROLE mcp_readonly LOGIN PASSWORD 'choose-a-password';"];
  lines.push(`GRANT CONNECT ON DATABASE ${quoteIdent(database || 'your_database')} TO mcp_readonly;`);
  if (Number(versionNum) >= 140000) {
    lines.push('GRANT pg_read_all_data TO mcp_readonly;');
  } else {
    lines.push('GRANT USAGE ON SCHEMA public TO mcp_readonly;');
    lines.push('GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;');
    lines.push('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;');
  }
  lines.push('ALTER ROLE mcp_readonly SET default_transaction_read_only = on;');
  return lines.join('\n');
}

// login: what assessLogin() returned. Returns { refuse, notes }: refuse is a message for
// every call when set; notes are lines for stderr at start-up.
export function decidePolicy(login, { local, allowSuperuser }) {
  const roles = Array.isArray(login.server_roles) ? login.server_roles : [];
  const powerful = Boolean(login.superuser) || roles.length > 0;
  const what = login.superuser ? 'a superuser' : `a member of ${roles.join(', ')}`;
  const sql = readOnlyLoginSql(login.database, login.version_num);
  const notes = [];
  if (powerful && !local && !allowSuperuser) {
    return {
      refuse: `This server is connected as ${login.user}, ${what}, on a database on another machine. `
        + 'Such a login can run programs or read files on the database server, so Kaiva Postgres MCP does not use it there. '
        + 'Connect with a login that can only read (run this SQL as an administrator, then put the new login in the connection URL), '
        + `or start the server with --allow-superuser.\n\n${sql}`,
      notes: [`Refusing to run: connected as ${login.user}, ${what}, on a remote database. Every call will say so. Use a read-only login, or --allow-superuser.`],
    };
  }
  if (powerful) {
    notes.push(`${login.user} is ${what}. Statements still run read-only, and commands and functions that reach the server's files, programs or other sessions are refused. What that cannot stop: a view, a foreign table or a function already defined in the database that reads files or runs programs, and system catalogs such as pg_authid (password hashes), which this login can read. A login that can only read closes all of that. To make one:\n${sql}`);
  } else if (login.can_write) {
    notes.push(`The login ${login.user} can change data in some tables. This server never does: every statement runs in a read-only transaction that is rolled back.`);
  }
  return { refuse: null, notes };
}
