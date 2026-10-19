#!/usr/bin/env node
// Kaiva Postgres MCP: a read-only PostgreSQL MCP server over stdio.
//
//   npx -y @kaiva/postgres-mcp postgresql://user:password@localhost:5432/mydb
//
// The same command shape as the archived @modelcontextprotocol/server-postgres, so
// switching is one package name in the client's settings.

/* global process */
import fs from 'node:fs';
import { createPool } from '../lib/db.js';
import { createService } from '../lib/service.js';
import { createServer } from '../lib/server.js';
import { validateUrl, redactUrl } from '../lib/policy.js';
import { describeConnectError, isConnectionError, DEFAULTS } from '../lib/format.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Text for the terminal, with control characters and bidirectional overrides replaced: a
// value from a database or a URL cannot move the cursor or recolour the terminal.
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they are replaced before printing
function plain(s) { return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '?'); }
const log = (text) => process.stderr.write(`[kaiva-postgres-mcp] ${plain(text)}\n`);

const HELP = `Kaiva Postgres MCP ${VERSION}
A read-only PostgreSQL MCP server. Drop-in replacement for @modelcontextprotocol/server-postgres.

Usage
  npx -y @kaiva/postgres-mcp <postgresql://user:password@host:5432/database> [options]
  (or set DATABASE_URL instead of giving the URL)

Options
  --max-rows <n>       rows returned per query, 1 to 10000 (default ${DEFAULTS.maxRows})
  --timeout <seconds>  time limit per statement, 1 to 300 (default 15)
  --allow-superuser    allow a superuser login on a database on another machine
  --check              connect once, report what this login can do, and exit
  --version            print the version
  --help               print this help

Every statement runs alone, in a read-only transaction that is always rolled back.
Allowed: SELECT, WITH, VALUES, TABLE, SHOW and EXPLAIN.

Need this database in Claude.ai or ChatGPT, or shared with your team, behind sign-in?
Kaiva Bridge serves it as a managed MCP server: https://kaiv.ai/bridge
`;

function parseArgs(argv) {
  const opts = { url: null, maxRows: DEFAULTS.maxRows, timeoutMs: 15_000, allowSuperuser: false, check: false };
  const number = (flag, value, min, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} takes a whole number from ${min} to ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--version' || a === '-v') return { version: true };
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--allow-superuser') { opts.allowSuperuser = true; continue; }
    if (a === '--max-rows') { opts.maxRows = number(a, argv[++i], 1, 10_000); continue; }
    if (a === '--timeout') { opts.timeoutMs = number(a, argv[++i], 1, 300) * 1000; continue; }
    if (a.startsWith('--')) throw new Error(`Unknown option ${a}. Run with --help to see the options.`);
    if (opts.url) throw new Error('Give one connection URL.');
    opts.url = a;
  }
  if (!opts.url && process.env.DATABASE_URL) opts.url = process.env.DATABASE_URL;
  return opts;
}

async function runCheck(service, opts) {
  try {
    const { login, local, policy } = await service.check();
    process.stdout.write(`${plain(`Connected to ${login.database} as ${login.user}, PostgreSQL ${login.version}.`)}\n`);
    process.stdout.write(`${plain(`Database on this machine: ${local ? 'yes' : 'no'}. Superuser: ${login.superuser ? 'yes' : 'no'}. Server file, program or signal roles: ${login.superuser ? 'all, as a superuser' : (login.server_roles.length ? login.server_roles.join(', ') : 'none')}. Can change data: ${login.can_write ? 'yes' : 'no'}.`)}\n`);
    process.stdout.write(`${plain(`Every statement runs read-only: at most ${opts.maxRows} rows, ${opts.timeoutMs / 1000} seconds.`)}\n`);
    if (policy.refuse) {
      process.stdout.write(`\n${plain(policy.refuse)}\n`);
      return 2;
    }
    for (const note of policy.notes) process.stdout.write(`\n${plain(note)}\n`);
    process.stdout.write('\nReady.\n');
    return 0;
  } catch (e) {
    process.stdout.write(`${plain(isConnectionError(e) ? describeConnectError(e) : `The database refused the check: ${e.message}`)}\n`);
    return 1;
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { log(e.message); return 1; }
  if (opts.help) { process.stdout.write(plain(HELP)); return 0; }
  if (opts.version) { process.stdout.write(`${plain(VERSION)}\n`); return 0; }
  const bad = validateUrl(opts.url);
  if (bad) { log(bad); log('Run with --help to see the options.'); return 1; }

  const pool = createPool(opts.url);
  const service = createService({
    pool,
    url: opts.url,
    limits: { maxRows: opts.maxRows, timeoutMs: opts.timeoutMs },
    allowSuperuser: opts.allowSuperuser,
    log,
    env: process.env,
  });

  if (opts.check) {
    const code = await runCheck(service, opts);
    await pool.end().catch(() => {});
    return code;
  }

  const server = createServer({
    handlers: service,
    name: 'kaiva-postgres-mcp',
    version: VERSION,
    limits: service.limits,
    write: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
    log,
  });

  let closing = false;
  const close = async (code) => {
    if (closing) return;
    closing = true;
    // Answer what has already arrived, then let go of the database.
    const upTo = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });
    await Promise.race([server.settled(), upTo(2000)]);
    await Promise.race([pool.end().catch(() => {}), upTo(2000)]);
    process.exit(code);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => server.feed(chunk));
  process.stdin.on('end', () => { close(0); });
  process.stdin.on('error', () => { close(0); });
  process.stdout.on('error', () => { close(0); }); // the client went away (EPIPE)
  process.on('SIGINT', () => { close(0); });
  process.on('SIGTERM', () => { close(0); });

  log(`Kaiva Postgres MCP ${VERSION}: serving ${redactUrl(opts.url)} read-only.`);
  // Connect once at start, so a wrong URL or a refused login shows in the client's log
  // straight away rather than on the first call. A failure here is not fatal: the database
  // may come up later, and each call reconnects.
  service.warmUp().catch((e) => { log(isConnectionError(e) ? describeConnectError(e) : `The database refused the first check: ${e.message}`); });
  return null;
}

main().then((code) => {
  if (code !== null) process.exitCode = code;
}, (e) => {
  log(`Stopped: ${e && e.message ? e.message : String(e)}`);
  process.exitCode = 1;
});
