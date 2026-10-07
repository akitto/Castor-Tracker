-- Doublures minimales de Supabase pour rejouer les migrations sur un Postgres nu
-- (tests locaux et CI) : rôles PostgREST, schéma auth, Vault simplifié.
-- Ne jamais appliquer sur une vraie instance Supabase.

do $$
begin
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role authenticator login noinherit;
  grant anon, authenticated, service_role to authenticator;
exception when duplicate_object then
  null; -- rôles déjà créés dans la grappe (deuxième base de test)
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claim.sub', true), (auth.jwt() ->> 'sub')),
    ''
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$ select auth.jwt() ->> 'role' $$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  secret text not null,
  description text
);
create view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid
language sql
as $$
  insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null)
returns void
language sql
as $$
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id
$$;
