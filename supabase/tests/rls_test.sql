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

-- Fréquentation (page_views)
begin;
select set_config('role', 'anon', true);
select public.track_page_view('/', 'a1b2c3d4-0000-4000-8000-000000000001');
select public.track_page_view('/', 'a1b2c3d4-0000-4000-8000-000000000001');
select public.track_page_view('/historique', 'a1b2c3d4-0000-4000-8000-000000000001');
select public.track_page_view('/methode', 'pas un identifiant !');
select public.track_page_view('/admin/acces', 'a1b2c3d4-0000-4000-8000-000000000002');
select tests.fails($$select * from public.page_views$$, 'anon ne lit pas la fréquentation');
select tests.fails($$insert into public.page_views (path) values ('/')$$, 'anon n''écrit pas directement la fréquentation');
select tests.fails($$select public.admin_page_views_hourly(24)$$, 'anon n''a pas les statistiques');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}', true);
select tests.fails($$select public.admin_page_views_hourly(24)$$, 'viewer n''a pas les statistiques');
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
select tests.ok((select (s ->> 'views')::int = 3 and (s ->> 'visitors')::int = 2
  and jsonb_array_length(s -> 'hours') = 24
  and (select sum((h ->> 1)::int) from jsonb_array_elements(s -> 'hours') h) = 3
  from public.admin_page_views_hourly(24) s),
  'statistiques horaires : anti-rebond, pages admin ignorées, visiteur invalide anonymisé');
select tests.ok(jsonb_array_length(public.admin_page_views_hourly(100000) -> 'hours') = 24 * 92, 'période plafonnée à 92 jours');
rollback;

-- Notifications : préférences, abonnements, événements, distribution
select tests.ok(tests.count('select 1 from public.notification_types') = 14, 'catalogue des notifications');
select tests.ok(tests.count($$select 1 from public.notification_events where type = 'security'$$) = 2,
  'rôles du jeu de données notifiés aux admins');

begin;
select set_config('role', 'anon', true);
select tests.fails($$select * from public.notification_prefs$$, 'anon ne lit pas les préférences');
select tests.fails($$select public.push_subscribe('https://push.example.org/x', repeat('a', 87), repeat('b', 22))$$,
  'anon ne s''abonne pas');
rollback;

begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}', true);
select tests.ok(tests.count('select 1 from public.notification_types') = 14, 'viewer lit le catalogue');
insert into public.notification_settings (user_id, enabled) values ('00000000-0000-0000-0000-00000000000b', true);
insert into public.notification_prefs (user_id, type, enabled, params)
  values ('00000000-0000-0000-0000-00000000000b', 'price_alert', true, '{"above": 130}');
select tests.ok(tests.count('select 1 from public.notification_prefs') = 1, 'viewer enregistre ses préférences');
select tests.fails($$insert into public.notification_prefs (user_id, type, enabled)
  values ('00000000-0000-0000-0000-00000000000a', 'estimate_move', false)$$, 'viewer ne règle pas les préférences d''un autre');
select tests.fails($$update public.notification_settings set webhook_url = 'https://hooks.example.org/x', webhook_enabled = true$$,
  'webhook réservé aux admins');
select tests.fails($$select * from public.notification_state$$, 'mémoire des alertes réservée aux fonctions');
select tests.ok(tests.count('select 1 from public.admin_config') = 0, 'viewer ne lit pas les réglages admin');
select tests.ok(public.push_subscribe('https://push.example.org/viewer', repeat('a', 87), repeat('b', 22), 'test') > 0,
  'viewer s''abonne au Web Push');
select tests.fails($$select public.push_subscribe('http://push.example.org/x', repeat('a', 87), repeat('b', 22))$$,
  'abonnement en clair refusé');
select tests.ok(tests.count('select 1 from public.push_subscriptions') = 1, 'viewer voit son abonnement');
select tests.ok(tests.count('select 1 from public.notification_events') = 0, 'viewer ne lit pas les événements des autres');
select tests.fails($$select public.notification_emit('security', 'x', 'y')$$, 'viewer ne crée pas d''événement');
select tests.fails($$select public.notification_claim(10)$$, 'viewer ne réserve pas d''envoi');
rollback;

begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}', true);
insert into public.notification_settings (user_id, webhook_enabled, webhook_url, webhook_format)
  values ('00000000-0000-0000-0000-00000000000a', true, 'https://hooks.example.org/castor', 'ntfy');
select tests.ok(tests.count('select 1 from public.notification_settings where webhook_enabled') = 1, 'admin configure son webhook');
update public.admin_config set heartbeat_url = 'https://kuma.example.org/api/push/abc';
select tests.ok(tests.count('select 1 from public.admin_config where heartbeat_url is not null') = 1, 'admin règle le moniteur externe');
select tests.ok(tests.count('select 1 from public.v_notification_log') >= 2, 'admin lit le journal des notifications');
rollback;

begin;
-- abonnements et préférences (comme les ferait la PWA)
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-00000000000a', 'https://push.example.org/a', repeat('a', 87), repeat('b', 22)),
  ('00000000-0000-0000-0000-00000000000b', 'https://push.example.org/b', repeat('a', 87), repeat('b', 22));
insert into public.notification_settings (user_id, quiet_hours, webhook_enabled, webhook_url)
  values ('00000000-0000-0000-0000-00000000000a', false, true, 'https://hooks.example.org/castor');
update public.notification_events set fanned_out_at = now();
-- date du CA connue (quadrimestre à venir) et prix officiel
update public.quadrimesters set board_date = '2026-10-15', board_status = 'known' where code = '2027/1';
select tests.ok(tests.count($$select 1 from public.notification_events where dedup_key = 'board:2027/1:2026-10-15'$$) = 1,
  'date du CA connue notifiée');
update public.quadrimesters set board_date = '2025-10-16' where code = '2026/1';
select tests.ok(tests.count($$select 1 from public.notification_events where dedup_key like 'board:2026/1%'$$) = 0,
  'quadrimestre passé : pas de notification');
update public.quadrimesters set official_price = 106.50, computed_price = 106.40, computed_missing = 0 where code = '2027/1';
select tests.ok((select body like 'Prix de souscription 2027/1 : 106,50 €.%(121,95 €) : +14,5 \%%.' from public.notification_events
  where dedup_key = 'official:2027/1'), 'prix officiel notifié avec la plus-value');
select tests.ok(tests.count($$select 1 from public.notification_events where dedup_key = 'mismatch:2027/1'$$) = 1,
  'écart au centime signalé aux admins');
select tests.ok(public.notification_emit('board_date', 'doublon', 'x', null, 'board:2027/1:2026-10-15') is null,
  'déduplication');
-- préférences : le viewer coupe le prix officiel, l'admin coupe tout
insert into public.notification_prefs (user_id, type, enabled) values ('00000000-0000-0000-0000-00000000000b', 'official_price', false);
insert into public.notification_settings (user_id, quiet_hours) values ('00000000-0000-0000-0000-00000000000b', false);
select tests.ok(public.notification_fanout() = 7, 'distribution : push et webhook selon les préférences');
select tests.ok(tests.count($$select 1 from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
  where e.type = 'official_price' and d.user_id = '00000000-0000-0000-0000-00000000000b'$$) = 0, 'type désactivé : rien');
select tests.ok(tests.count($$select 1 from public.notification_deliveries d join public.notification_events e on e.id = d.event_id
  where e.type = 'price_mismatch' and d.user_id = '00000000-0000-0000-0000-00000000000b'$$) = 0, 'type admin : pas pour le viewer');
select tests.ok(tests.count($$select 1 from public.notification_deliveries where channel = 'webhook'$$) = 3, 'webhook de l''admin');
update public.notification_settings set enabled = false where user_id = '00000000-0000-0000-0000-00000000000a';
select public.notification_emit('board_date', 'test', 'x', null, 'board:test');
select tests.ok(public.notification_fanout() = 1, 'interrupteur général coupé : l''admin ne reçoit plus rien');
select tests.ok(public.notification_due() = 8, 'envois en attente');
select tests.ok(jsonb_array_length(public.notification_claim(100)) = 8, 'envois dus réservés');
select tests.ok(tests.count($$select 1 from public.notification_deliveries where status = 'sending' and attempts = 1$$) = 8,
  'envois marqués en cours');
select tests.ok(jsonb_array_length(public.notification_claim(100)) = 0, 'pas de double réservation');
-- heures calmes
select tests.ok(public.notification_not_before(true, false, '2026-10-08 22:30+02') = '2026-10-09 08:00+02', 'heures calmes : soir');
select tests.ok(public.notification_not_before(true, false, '2026-12-08 06:10+01') = '2026-12-08 08:00+01', 'heures calmes : matin');
select tests.ok(public.notification_not_before(true, true, '2026-10-08 22:30+02') = '2026-10-08 22:30+02', 'urgence : immédiat');
select tests.ok(public.notification_not_before(false, false, '2026-10-08 22:30+02') = '2026-10-08 22:30+02', 'heures calmes désactivées');
-- deux échecs de suite
insert into public.job_runs (job, status) values ('session', 'running'), ('session', 'running');
update public.job_runs set status = 'error', message = 'Yahoo indisponible', finished_at = now() where job = 'session';
select tests.ok(tests.count($$select 1 from public.notification_events where type = 'job_failure' and urgent$$) = 1,
  'deux échecs de suite : alerte urgente');
-- clés VAPID : la première écriture gagne
select public.castor_push_keys_init('pub1', 'priv1');
select tests.ok((public.castor_push_keys_init('pub2', 'priv2') ->> 'public') = 'pub1', 'clés VAPID conservées');
select tests.ok((select vapid_public_key from public.app_config) = 'pub1', 'clé publique VAPID lisible par la PWA');
rollback;

\o
\echo 'Tous les tests SQL sont passés.'

