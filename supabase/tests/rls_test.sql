-- Tests des droits (REC-10), des RPC et des vues, sur les migrations rejouées.
-- Lancement : scripts/test-db.sh (Postgres local + doublures Supabase).
\set ON_ERROR_STOP 1
set client_min_messages = notice;
\o /dev/null

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.ok(p boolean, p_label text) returns void
language plpgsql as $$
begin
  if p is not true then
    raise exception 'ÉCHEC : %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

create function tests.count(p_sql text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into n;
  return n;
end;
$$;

create function tests.affected(p_sql text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function tests.fails(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_label, sqlerrm;
    return;
  end;
  raise exception 'ÉCHEC : % (aucune erreur)', p_label;
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Jeu de données
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.org'),
  ('00000000-0000-0000-0000-00000000000b', 'viewer@example.org'),
  ('00000000-0000-0000-0000-00000000000c', 'inconnu@example.org');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'viewer');
insert into public.stock_prices (trade_date, open, close, source) values
  ('2026-10-05', 120.1, 120.6, 'yahoo'),
  ('2026-10-06', 120.5, 121.0, 'yahoo'),
  ('2026-10-07', 121.2, null, 'yahoo');
insert into public.quote_live (price, prev_close, change_pct, quote_time, source)
  values (121.95, 121.0, 0.007851, now(), 'yahoo');
insert into public.estimates (quadrimester_code, kind, as_of, state, central, p05, p25, p75, p95,
  reliability, prob_below, reference_price, known_sessions)
  values ('2027/1', 'scheduled', '2026-10-07', 'window', 106.90, 105.00, 106.00, 107.80, 108.80, 64, 0.99, 119.33, 12);
insert into public.estimates (quadrimester_code, kind, as_of, state, central, p05, p25, p75, p95, reliability)
  values ('2026/3', 'replay', '2026-08-15', 'frozen', 119.30, 118.90, 119.10, 119.33, 119.60, 91);
insert into public.job_runs (job, trigger, status, message, finished_at) values ('open', 'cron', 'success', 'ok', now());

select tests.ok(tests.count('select 1 from public.audit_log') = 0, 'écritures SQL hors JWT non journalisées');
select tests.ok(tests.count('select 1 from public.market_holidays') = 96, 'jours fériés 2015–2027 chargés');
select tests.ok(tests.count('select 1 from public.calc_params where active') = 1, 'une version de paramètres active');
select tests.ok(public.castor_setup_cron() like '%pg_cron absent%' or public.castor_setup_cron() like '%planifiées', 'planification sans erreur');

-- Visiteur anonyme, mode restreint
begin;
select set_config('role', 'anon', true);
select tests.ok(tests.count('select 1 from public.app_config') = 1, 'anon lit les réglages');
select tests.ok(tests.count('select 1 from public.stock_prices') = 0, 'anon ne lit pas les cours (mode restreint)');
select tests.ok(tests.count('select 1 from public.quadrimesters') = 0, 'anon ne lit pas les quadrimestres');
select tests.ok((select current_code from public.v_dashboard) is null, 'anon : tableau de bord vide');
select tests.ok((public.my_access() ->> 'can_read')::boolean = false, 'anon : my_access sans lecture');
select tests.fails($$insert into public.stock_prices (trade_date, open) values ('2026-10-08', 1)$$, 'anon ne peut pas écrire');
select tests.fails($$select * from public.job_runs$$, 'anon ne lit pas le journal');
select tests.fails($$select public.admin_import_prices('[]'::jsonb, 'x', false)$$, 'anon ne peut pas importer');
select tests.fails($$select public.upsert_prices('[]'::jsonb, 'x')$$, 'anon ne peut pas collecter');
rollback;

-- Lecteur invité
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}', true);
select tests.ok(tests.count('select 1 from public.stock_prices') = 3, 'viewer lit les cours');
select tests.ok((select current_code from public.v_dashboard) = '2026/3', 'viewer : quadrimestre en cours');
select tests.ok((select next_code from public.v_dashboard) = '2027/1', 'viewer : prochain quadrimestre');
select tests.ok((select central from public.v_dashboard) = 106.90, 'viewer : estimation affichée');
select tests.ok((select quote_price from public.v_dashboard) = 121.95, 'viewer : cours en séance');
select tests.ok(jsonb_array_length(public.price_series()) = 3, 'viewer : série de cours');
select tests.ok(jsonb_array_length(public.price_series('2026-10-06')) = 2, 'viewer : série filtrée');
select tests.ok((select estimate_kind = 'replay' and estimate_diff = -0.03 from public.v_history where code = '2026/3'),
  'historique : prix rejoué et écart');
select tests.ok((select round(gain_pct, 4) = round(121.95 / 119.33 - 1, 4) from public.v_history where code = '2026/3'),
  'historique : plus-value au cours actuel');
select tests.fails($$insert into public.stock_prices (trade_date, open) values ('2026-10-08', 1)$$, 'viewer ne peut pas insérer');
select tests.ok(tests.affected($$update public.quadrimesters set notes = 'x'$$) = 0, 'viewer ne modifie aucun quadrimestre');
select tests.ok(tests.count('select 1 from public.job_runs') = 0, 'viewer ne lit pas le journal');
select tests.ok(tests.count('select 1 from public.user_roles') = 1, 'viewer ne voit que son rôle');
select tests.fails($$select public.admin_set_official_price('2027/1', 100)$$, 'viewer ne saisit pas de prix officiel');
select tests.fails($$insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-00000000000c', 'admin')$$,
  'viewer ne distribue pas de rôle');
select tests.fails($$select public.castor_verify_cron_secret('x')$$, 'vérification du secret réservée aux fonctions');
rollback;

-- Compte authentifié sans rôle
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal1"}', true);
select tests.ok(tests.count('select 1 from public.stock_prices') = 0, 'compte sans rôle : aucun accès');
select tests.ok(public.my_access() ->> 'role' is null, 'compte sans rôle : my_access');
rollback;

-- Administrateur sans second facteur (TOTP exigé)
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}', true);
select tests.ok(not public.is_admin(), 'admin sans TOTP : pas de droits d''administration');
select tests.ok(tests.count('select 1 from public.stock_prices') = 3, 'admin sans TOTP : lecture');
select tests.fails($$insert into public.dividends (ex_date, amount) values ('2027-04-20', 3)$$, 'admin sans TOTP : écriture refusée');
rollback;

-- Administrateur avec TOTP
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select tests.ok(public.is_admin(), 'admin avec TOTP');
insert into public.dividends (ex_date, amount, kind) values ('2027-04-20', 3.90, 'solde');
select tests.ok(tests.count($$select 1 from public.audit_log where table_name = 'dividends' and action = 'insert'$$) = 1,
  'écriture admin journalisée');
select tests.ok(tests.count('select 1 from public.job_runs') = 1, 'admin lit le journal');
select tests.ok(tests.count('select 1 from public.user_roles') = 2, 'admin voit tous les rôles');
select tests.ok((public.admin_import_prices(
  '[{"date":"2026-10-07","open":121.25,"close":121.9},{"date":"2026-10-08","open":122}]'::jsonb, 'test', false)
  ->> 'inserted')::int = 1, 'import : seules les nouvelles séances sans écrasement');
select tests.ok((select open from public.stock_prices where trade_date = '2026-10-07') = 121.2, 'import : séance existante intacte');
select tests.ok((public.admin_import_prices(
  '[{"date":"2026-10-07","open":121.25,"close":121.9}]'::jsonb, 'correction', true) ->> 'updated')::int = 1,
  'import avec écrasement');
select tests.ok((select is_manual and manual_reason = 'correction' and open = 121.25 from public.stock_prices
  where trade_date = '2026-10-07'), 'séance importée marquée manuelle');
select tests.ok(tests.count($$select 1 from public.audit_log where action = 'import'$$) = 2, 'import journalisé en une ligne');
select tests.ok(public.admin_set_official_price('2027/1', 106.50, '2026-12-20', 'https://example.org/avis.pdf') is not null,
  'prix officiel saisi');
select tests.ok((select estimate_kind = 'final' and estimate_central = 106.90 and estimate_diff = 0.40
  from public.v_history where code = '2027/1'), 'estimation finale archivée, écart affiché');
select tests.ok((select next_code from public.v_dashboard) = '2027/2', 'tableau de bord : passe au quadrimestre suivant');
insert into public.calc_params (label, price_field) values ('Variante clôture', 'close');
select public.activate_calc_params((select id from public.calc_params where label = 'Variante clôture'));
select tests.ok((select count(*) = 1 from public.calc_params where active), 'une seule version active');
select tests.ok((select price_field = 'close' from public.calc_params where active), 'version activée');
select tests.ok(tests.affected($$delete from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000a'$$) = 0,
  'un admin ne retire pas son propre rôle');
update public.app_config set visibility = 'public';
select tests.ok(tests.count($$select 1 from public.audit_log where table_name = 'app_config'$$) = 1, 'réglages journalisés');
rollback;

-- Edge Functions (service_role)
begin;
update public.stock_prices set is_manual = true, manual_reason = 'test' where trade_date = '2026-10-06';
select set_config('role', 'service_role', true);
select public.upsert_prices(
  '[{"date":"2026-10-06","open":99,"close":99},{"date":"2026-10-07","open":121.2,"high":122,"low":120.8,"close":121.9,"volume":1000}]'::jsonb,
  'yahoo', 'full');
select tests.ok((select open = 120.5 from public.stock_prices where trade_date = '2026-10-06'), 'collecte : séance manuelle préservée');
select tests.ok((select close = 121.9 and volume = 1000 from public.stock_prices where trade_date = '2026-10-07'), 'collecte : séance complète');
select public.upsert_prices('[{"date":"2026-10-08","open":122.4,"close":130}]'::jsonb, 'yahoo', 'open');
select tests.ok((select open = 122.4 and close is null from public.stock_prices where trade_date = '2026-10-08'),
  'collecte : ouverture seule');
select public.upsert_prices('[{"date":"2026-10-07","open":121.25,"close":121.9,"vwap":121.6}]'::jsonb, 'euronext', 'control');
select tests.ok((select check_open = 121.25 and vwap = 121.6 and check_source = 'euronext' from public.stock_prices
  where trade_date = '2026-10-07'), 'contrôle croisé enregistré');
select tests.fails($$select public.upsert_prices('[]'::jsonb, 'x', 'autre')$$, 'mode de collecte inconnu refusé');
select tests.ok(tests.count('select 1 from public.audit_log') = 0, 'collecte non journalisée dans l''audit');
rollback;

-- Visibilité publique et privée
begin;
update public.app_config set visibility = 'public';
select set_config('role', 'anon', true);
select tests.ok(tests.count('select 1 from public.stock_prices') = 3, 'mode public : anon lit les cours');
select tests.ok((select next_code from public.v_dashboard) = '2027/1', 'mode public : tableau de bord');
select tests.fails($$insert into public.dividends (ex_date, amount) values ('2027-04-20', 3)$$, 'mode public : écriture refusée');
rollback;

begin;
update public.app_config set visibility = 'private';
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}', true);
select tests.ok(tests.count('select 1 from public.stock_prices') = 0, 'mode privé : viewer exclu');
rollback;

-- Secret des appels planifiés (Vault)
begin;
select public.castor_set_secret('castor_cron_secret', 'abcdefghijklmnopqrstuvwxyz0123456789');
select public.castor_set_secret('castor_cron_secret', 'zyxwvutsrqponmlkjihgfedcba9876543210');
select tests.ok(public.castor_secret('castor_cron_secret') = 'zyxwvutsrqponmlkjihgfedcba9876543210', 'secret remplacé');
select set_config('role', 'service_role', true);
select tests.ok(public.castor_verify_cron_secret('zyxwvutsrqponmlkjihgfedcba9876543210'), 'secret cron reconnu');
select tests.ok(not public.castor_verify_cron_secret('abcdefghijklmnopqrstuvwxyz0123456789'), 'ancien secret refusé');
select tests.ok(not public.castor_verify_cron_secret('court'), 'secret trop court refusé');
select tests.fails($$select public.castor_call('open')$$, 'appel planifié réservé au propriétaire');
rollback;

-- Enregistrement de l'adresse des fonctions par castor-jobs (installation par l'éditeur SQL)
begin;
select set_config('role', 'authenticated', true);
select tests.fails($$select public.castor_register_endpoint('https://pirate.example/functions/v1')$$, 'enregistrement refusé aux comptes');
select set_config('role', 'service_role', true);
select tests.ok(public.castor_register_endpoint('pas une adresse') = 'adresse refusée', 'adresse invalide refusée');
select tests.ok(public.castor_register_endpoint('https://abc.supabase.co/functions/v1/') like 'adresse des fonctions, secret des tâches%', 'premier enregistrement : adresse et secret');
select tests.ok(public.castor_register_endpoint('https://autre.example/functions/v1') = 'déjà en place', 'second enregistrement sans effet');
reset role;
select tests.ok(public.castor_secret('castor_functions_url') = 'https://abc.supabase.co/functions/v1', 'adresse conservée, sans barre finale');
select tests.ok(length(public.castor_secret('castor_cron_secret')) = 64, 'secret aléatoire de 64 caractères');
rollback;

\o
\echo 'Tous les tests SQL sont passés.'
