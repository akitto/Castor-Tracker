-- Décrit le schéma public (tables, vues, fonctions) en JSON pour scripts/gen-db-types.mjs.
\pset format unaligned
\pset tuples_only on
with cols as (
  select
    c.relname as rel,
    c.relkind as kind,
    a.attname as col,
    a.attnum as num,
    format_type(a.atttypid, null) as type,
    not a.attnotnull as nullable,
    (a.atthasdef or a.attidentity <> '') as has_default
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped
),
fns as (
  select
    p.proname as name,
    pg_get_function_identity_arguments(p.oid) as identity,
    coalesce(p.proargnames, '{}') as arg_names,
    (select coalesce(json_agg(format_type(t, null) order by i), '[]'::json)
       from unnest(p.proargtypes::oid[]) with ordinality as x(t, i)) as arg_types,
    p.pronargdefaults as n_defaults,
    format_type(p.prorettype, null) as returns,
    p.proretset as returns_set
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and format_type(p.prorettype, null) <> 'trigger'
)
select json_build_object(
  'relations', (
    select json_agg(json_build_object('name', rel, 'kind', kind, 'columns', columns) order by rel)
    from (
      select rel, kind,
        json_agg(json_build_object('name', col, 'type', type, 'nullable', nullable, 'hasDefault', has_default) order by num) as columns
      from cols group by rel, kind
    ) r
  ),
  'functions', (select json_agg(row_to_json(fns) order by name) from fns)
);
