# Kaiva Postgres MCP

The Postgres MCP server that stays read-only. A drop-in replacement for the archived
`@modelcontextprotocol/server-postgres`.

## Switch in one line

Where your AI client starts the archived server today:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

change the package name:

```json
      "args": ["-y", "@kaiva/postgres-mcp", "postgresql://localhost/mydb"]
```

In Claude Code:

```sh
claude mcp add postgres -- npx -y @kaiva/postgres-mcp postgresql://localhost/mydb
```

The `query` tool, its `sql` input and the table schema resources are the same, so nothing else
changes.

## Why switch

The archived server is no longer maintained: Anthropic archived it in 2025 as a reference example
rather than production software, and npm marks it "Package no longer supported". It runs whatever
text it is given inside `BEGIN TRANSACTION READ ONLY`, and that is not enough:

- `COMMIT; DROP SCHEMA public CASCADE` ends the read-only transaction and drops the schema
  (reported by Datadog Security Labs in August 2025; the fix never reached npm, where 0.6.2 is
  still the latest version).
- With a superuser login, which is what most local and Docker installs start with, one statement
  can run a shell command on the database server: PostgreSQL runs `COPY ... TO PROGRAM` inside a
  read-only transaction.

We checked both against version 0.6.2 on PostgreSQL 14: both ran. Kaiva Postgres MCP refuses both.

| | Archived 0.6.2 | Kaiva Postgres MCP |
|---|---|---|
| A second statement after `COMMIT` | Runs | Refused: one statement per call, and PostgreSQL itself refuses a second |
| `COPY ... TO PROGRAM`, server file reads, `dblink` | Run, if the login allows | Refused |
| Time limit | None | 15 seconds per statement, 3 seconds waiting for a lock |
| Rows returned | All of them | The first 1,000, and it says so |
| Superuser login | Used as given | Warning on this machine; refused for a database on another machine unless you allow it |
| Tables listed | `public` schema only | Every schema |
| Dates and timestamps | Turned into JavaScript dates, which can shift a date to the day before | Exactly as PostgreSQL prints them |
| Errors | Returned as protocol errors | Returned to the AI with what to fix |
| Maintained | No | Yes |

## Tools

- `query`: run one read-only SQL statement (`SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW` or
  `EXPLAIN`) and get the rows as JSON.
- `list_tables`: the tables and views this login can read, with type, estimated row count and
  comment.
- `describe_table`: one table's columns, primary key, unique and foreign keys, the tables that
  reference it, and its indexes.

Resources: each table's columns, as the archived server listed them.

## How read-only is enforced

On every call:

1. The SQL is checked before it is sent: one statement, starting with `SELECT`, `WITH`, `VALUES`,
   `TABLE`, `SHOW` or `EXPLAIN`, calling no function that reaches past the transaction (`dblink`,
   server file functions, `lo_import` and `lo_export`, `pg_terminate_backend`, advisory locks, and
   functions that run SQL given to them as text).
2. It runs alone, through PostgreSQL's extended query protocol, which refuses a second statement,
   inside a `READ ONLY` transaction with a statement time limit and a lock time limit.
3. The transaction is always rolled back, and `DISCARD ALL` resets the session, so nothing a
   statement sets up outlives it.

Only the first 1,000 rows are fetched from the database (one more is read, to know whether more
exist), so a query over a large table returns quickly.

## Use a login that can only read

The strongest guard is a login that cannot write. Run this once as an administrator, then put
`mcp_readonly` in the connection URL:

```sql
CREATE ROLE mcp_readonly LOGIN PASSWORD 'choose-a-password';
GRANT CONNECT ON DATABASE mydb TO mcp_readonly;
GRANT pg_read_all_data TO mcp_readonly;  -- PostgreSQL 14 and later
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;
```

To see what a login can do:

```sh
npx -y @kaiva/postgres-mcp postgresql://mcp_readonly:...@localhost/mydb --check
```

## Options

| Option | Default | |
|---|---|---|
| `--max-rows <n>` | 1000 | Rows returned per query, 1 to 10000 |
| `--timeout <seconds>` | 15 | Time limit per statement, 1 to 300 |
| `--allow-superuser` | off | Allow a superuser login on a database on another machine. In Docker Compose the database is another container, so this applies there too; a read-only login is the better answer |
| `--check` | | Connect once, report what the login can do, and exit |

Give the connection URL as the first argument, or set `DATABASE_URL`. TLS settings go in the URL
(`sslmode`, `sslrootcert`), as with `psql`.

## What it does not protect

- Anything the login can read, the AI can read: tables, views and foreign tables, and with a
  superuser the system catalogs too (`pg_authid` holds password hashes). Use a login that sees only
  the tables you mean to share.
- The refused-function list is a second guard, not a sandbox. It sees the SQL the AI sends, not what
  a view, a foreign table (`file_fdw`) or a function already defined in your database does when it
  is read. With a superuser login such an object can still read a file on the database server. With
  a login that can only read, PostgreSQL itself refuses (checked: a view over `pg_read_file` reads
  the file as a superuser and is refused as a read-only login).
- "This machine" means localhost, 127.x, ::1, a Unix socket, `*.localhost` and
  `host.docker.internal` (the Docker host). Anywhere else, Docker Compose service names and private
  network addresses included, a superuser is refused unless `--allow-superuser` is given.

## In Claude.ai, ChatGPT or for your team

This package runs on your machine. To use the same database from Claude.ai or ChatGPT, or share it
with your team behind sign-in, Kaiva Bridge serves it as a managed MCP server. In a project folder
whose `.env` holds `DATABASE_URL`:

```sh
npx @kaiva/bridge push mydb --db
```

Your database must be reachable from the internet. https://kaiv.ai/bridge

## License

MIT
