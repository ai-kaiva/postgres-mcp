// Resource addresses, as the archived server made them: the connection URL with scheme
// postgres: and no password, and <table>/schema resolved against it (which replaces the
// database name in the path). A table outside public is <schema>.<table>. Dots and other
// specials in names are percent-encoded so the split back is unambiguous. No database here,
// so the tests import it anywhere.
const encName = (s) => encodeURIComponent(s).replace(/\./g, '%2E');

export function resourceBase(url) {
  const base = new URL(url);
  base.protocol = 'postgres:';
  base.password = '';
  return base;
}

export function resourceUri(base, schema, table) {
  const name = schema === 'public' ? encName(table) : `${encName(schema)}.${encName(table)}`;
  return new URL(`${name}/schema`, base).href;
}

export function parseResourceUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return null; }
  const parts = u.pathname.split('/');
  if (parts.pop() !== 'schema') return null;
  const name = parts.pop() || '';
  const dot = name.indexOf('.');
  try {
    if (dot === -1) return { schema: 'public', table: decodeURIComponent(name) };
    return { schema: decodeURIComponent(name.slice(0, dot)), table: decodeURIComponent(name.slice(dot + 1)) };
  } catch {
    return null;
  }
}
