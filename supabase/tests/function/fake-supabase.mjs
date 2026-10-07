// Doublure de test : sous-ensemble de PostgREST (/rest/v1) et de GoTrue (/auth/v1)
// adossé à un vrai Postgres, pour exécuter l'Edge Function de bout en bout en local.
// Les requêtes passent avec le rôle du JWT (RLS active), comme avec PostgREST.
// Usage : PGHOST=… PGPORT=… node fake-supabase.mjs <port>
import http from 'node:http';
import pg from 'pg';

const port = Number(process.argv[2] ?? 54400);
const pool = new pg.Pool({ max: 4 });

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function claimsOf(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return { role: 'anon' };
  }
}

async function asRole(claims, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)", [
      claims.role ?? 'anon',
      JSON.stringify(claims),
    ]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function where(params, values, alias = '') {
  const parts = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = raw.slice(0, dot);
    const val = raw.slice(dot + 1);
    const col = alias ? `${alias}.${q(key)}` : q(key);
    const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    if (ops[op]) {
      values.push(val);
      parts.push(`${col} ${ops[op]} $${values.length}`);
    } else if (op === 'is') {
      parts.push(`${col} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`);
    } else if (op === 'in') {
      const list = val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''));
      values.push(list);
      parts.push(`${col}::text = any($${values.length})`);
    } else throw Object.assign(new Error(`opérateur non géré : ${op}`), { status: 400 });
  }
  return parts.length ? `where ${parts.join(' and ')}` : '';
}

function orderBy(params) {
  const o = params.get('order');
  if (!o) return '';
  return `order by ${o
    .split(',')
    .map((p) => {
      const [col, dir, nulls] = p.split('.');
      return `${q(col)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`;
    })
    .join(', ')}`;
}

function columnsOf(params) {
  const s = params.get('select');
  if (!s || s === '*') return '*';
  return s
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map(q)
    .join(', ');
}

async function primaryKey(client, table) {
  const r = await client.query(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary`,
    [`public.${table}`],
  );
  return r.rows.map((x) => x.attname);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, prefer, accept, accept-profile, content-profile, range, x-client-info',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, x-total-count',
};

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...headers });
  res.end(text);
}

function shape(req, rows) {
  const accept = req.headers.accept ?? '';
  if (accept.includes('vnd.pgrst.object')) {
    if (rows.length !== 1) {
      return [406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `${rows.length} rows` }];
    }
    return [200, rows[0]];
  }
  return [200, rows];
}

async function rest(req, res, url, body) {
  const claims = claimsOf(req);
  const path = url.pathname.replace(/^\/rest\/v1\//, '');
  const params = url.searchParams;
  const prefer = req.headers.prefer ?? '';
  const wantRows = prefer.includes('return=representation');

  if (path.startsWith('rpc/')) {
    const fn = path.slice(4);
    const args = req.method === 'GET' ? Object.fromEntries(params) : body ?? {};
    const out = await asRole(claims, async (client) => {
      const info = await client.query(
        `select format_type(p.prorettype, null) as ret, p.proretset from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      if (info.rowCount === 0) throw Object.assign(new Error(`fonction ${fn} introuvable`), { status: 404 });
      const names = Object.keys(args);
      const values = names.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
      const call = `public.${q(fn)}(${names.map((k, i) => `${q(k)} => $${i + 1}`).join(', ')})`;
      const { ret, proretset } = info.rows[0];
      if (ret === 'void') {
        await client.query(`select ${call}`, values);
        return null;
      }
      if (proretset) {
        const r = await client.query(`select coalesce(jsonb_agg(x), '[]') as r from ${call} x`, values);
        return r.rows[0].r;
      }
      const r = await client.query(`select to_jsonb(${call}) as r`, values);
      return r.rows[0].r;
    });
    return out === null ? send(res, 204) : send(res, 200, out);
  }

  const table = `public.${q(path)}`;
  const values = [];
  if (req.method === 'GET' || req.method === 'HEAD') {
    const filter = where(params, values);
    const sql = `select coalesce(json_agg(row_to_json(t)), '[]') as rows from (
      select ${columnsOf(params)} from ${table} ${filter} ${orderBy(params)}
      ${params.get('limit') ? `limit ${Number(params.get('limit'))}` : ''}
      ${params.get('offset') ? `offset ${Number(params.get('offset'))}` : ''}) t`;
    const { rows, total } = await asRole(claims, async (c) => ({
      rows: (await c.query(sql, values)).rows[0].rows,
      total: prefer.includes('count=') ? Number((await c.query(`select count(*) as n from ${table} ${filter}`, values)).rows[0].n) : null,
    }));
    const headers = total === null ? {} : { 'Content-Range': `${rows.length ? `0-${rows.length - 1}` : '*'}/${total}` };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...CORS, ...headers });
      return res.end();
    }
    const [status, out] = shape(req, rows);
    return send(res, status, out, headers);
  }

  if (req.method === 'POST') {
    const list = Array.isArray(body) ? body : [body];
    const cols = [...new Set(list.flatMap((o) => Object.keys(o)))];
    values.push(JSON.stringify(list));
    const rows = await asRole(claims, async (client) => {
      let conflict = '';
      if (prefer.includes('resolution=')) {
        const target = params.get('on_conflict')?.split(',') ?? (await primaryKey(client, path));
        conflict = prefer.includes('ignore-duplicates')
          ? `on conflict (${target.map(q).join(', ')}) do nothing`
          : `on conflict (${target.map(q).join(', ')}) do update set ${cols
              .filter((c) => !target.includes(c))
              .map((c) => `${q(c)} = excluded.${q(c)}`)
              .join(', ') || `${q(target[0])} = excluded.${q(target[0])}`}`;
      }
      const sql = `with ins as (insert into ${table} (${cols.map(q).join(', ')})
        select ${cols.map(q).join(', ')} from json_populate_recordset(null::${table}, $1::json)
        ${conflict} returning ${columnsOf(params)}) select coalesce(json_agg(row_to_json(ins)), '[]') as rows from ins`;
      return (await client.query(sql, values)).rows[0].rows;
    });
    if (!wantRows) return send(res, 201);
    const [status, out] = shape(req, rows);
    return send(res, status === 200 ? 201 : status, out);
  }

  if (req.method === 'PATCH') {
    const cols = Object.keys(body ?? {});
    values.push(JSON.stringify(body));
    const filter = where(params, values, 't');
    const returning = columnsOf(params) === '*' ? 't.*' : columnsOf(params).split(', ').map((c) => `t.${c}`).join(', ');
    const sql = `with up as (update ${table} as t set ${cols.map((c) => `${q(c)} = r.${q(c)}`).join(', ')}
      from json_populate_record(null::${table}, $1::json) r ${filter} returning ${returning})
      select coalesce(json_agg(row_to_json(up)), '[]') as rows from up`;
    const rows = await asRole(claims, async (c) => (await c.query(sql, values)).rows[0].rows);
    if (!wantRows) return send(res, 204);
    const [status, out] = shape(req, rows);
    return send(res, status, out);
  }

  if (req.method === 'DELETE') {
    const sql = `with del as (delete from ${table} ${where(params, values)} returning ${columnsOf(params)})
      select coalesce(json_agg(row_to_json(del)), '[]') as rows from del`;
    const rows = await asRole(claims, async (c) => (await c.query(sql, values)).rows[0].rows);
    if (!wantRows) return send(res, 204);
    const [status, out] = shape(req, rows);
    return send(res, status, out);
  }
  return send(res, 405, { message: 'méthode non gérée' });
}

function userJson(u) {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.created_at,
    created_at: u.created_at,
    last_sign_in_at: null,
    app_metadata: {},
    user_metadata: {},
    factors: [],
  };
}

async function auth(req, res, url, body) {
  const path = url.pathname.replace(/^\/auth\/v1/, '');
  const client = await pool.connect();
  try {
    if (path === '/user') {
      const claims = claimsOf(req);
      const r = await client.query('select * from auth.users where id = $1', [claims.sub ?? null]);
      return r.rowCount ? send(res, 200, userJson(r.rows[0])) : send(res, 401, { msg: 'invalid JWT' });
    }
    if (claimsOf(req).role !== 'service_role') return send(res, 403, { msg: 'service_role requis' });
    if (path === '/admin/users' && req.method === 'GET') {
      const r = await client.query('select * from auth.users order by created_at');
      return send(res, 200, { users: r.rows.map(userJson), aud: 'authenticated' }, { 'x-total-count': String(r.rowCount) });
    }
    if (path === '/admin/users' && req.method === 'POST') {
      const r = await client.query('insert into auth.users (email) values ($1) returning *', [String(body.email).toLowerCase()]);
      return send(res, 200, userJson(r.rows[0]));
    }
    if (path.startsWith('/admin/users/') && req.method === 'DELETE') {
      await client.query('delete from auth.users where id = $1', [path.split('/').pop()]);
      return send(res, 200, {});
    }
    if (path === '/invite' || path === '/admin/generate_link') {
      const email = String(body.email).toLowerCase();
      const r = await client.query(
        'insert into auth.users (email) values ($1) on conflict (email) do update set email = excluded.email returning *',
        [email],
      );
      const user = userJson(r.rows[0]);
      if (path === '/invite') return send(res, 200, user);
      return send(res, 200, {
        ...user,
        action_link: `http://localhost/verify?token=fake&type=${body.type}`,
        email_otp: '000000',
        hashed_token: 'fake',
        redirect_to: body.redirect_to ?? null,
        verification_type: body.type,
      });
    }
    return send(res, 404, { msg: `route auth non gérée : ${path}` });
  } finally {
    client.release();
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    try {
      if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, body);
      if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, body);
      return send(res, 404, { message: 'route inconnue' });
    } catch (e) {
      const status = e.status ?? (e.code === '42501' ? 403 : 400);
      return send(res, status, { message: e.message, code: e.code ?? null, details: e.detail ?? null, hint: e.hint ?? null });
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`fake-supabase sur http://127.0.0.1:${port}`));
