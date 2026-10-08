-- Castor Tracker — base, À COLLER DANS LE SQL EDITOR de Supabase (pas dans Edge Functions).
-- Tableau de bord Supabase › SQL Editor › New query : coller tout ce fichier, puis Run
-- (confirmer si Supabase signale des opérations destructives : elles ne visent que les restes d'une installation
-- interrompue). Créer d'abord le compte administrateur (Authentication › Users › Add user) : s'il est le seul compte
-- du projet, il devient administrateur.
-- Relançable sans risque : seules les migrations manquantes sont appliquées (mises à jour comprises).
-- Fichier généré par scripts/build-cloud-bundle.mjs à partir de supabase/migrations : ne pas modifier.

create schema if not exists castor_meta;
revoke all on schema castor_meta from public;
create table if not exists castor_meta.migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

do $castor$
declare
  v_applied integer := 0;
begin
  perform set_config('client_min_messages', 'warning', true);

  -- Restes d'une installation interrompue : aucune migration enregistrée, mais des objets Castor présents.
  if not exists (select 1 from castor_meta.migrations) then
    drop view if exists public.v_dashboard, public.v_history, public.v_estimate_history, public.v_job_status, public.v_my_notifications, public.v_notification_log cascade;
    drop table if exists public.app_config, public.user_roles, public.stock_prices, public.quote_live, public.market_holidays, public.dividends, public.quadrimesters, public.calc_params, public.estimates, public.backtests, public.job_runs, public.audit_log, public.page_views, public.notification_types, public.notification_settings, public.notification_prefs, public.notification_state, public.push_subscriptions, public.notification_events, public.notification_deliveries, public.admin_config cascade;
    drop function if exists public.paris_today, public.has_role, public.is_admin, public.is_public_site, public.can_read, public.my_access, public.set_updated_at, public.audit_trigger, public.price_series, public.upsert_prices, public.admin_import_prices, public.activate_calc_params, public.admin_set_official_price, public.castor_verify_cron_secret, public.castor_set_secret, public.castor_secret, public.castor_call, public.castor_setup_cron, public.castor_unschedule_cron, public.castor_register_endpoint, public.track_page_view, public.admin_page_views_hourly, public.notification_settings_guard, public.fr_euro, public.fr_signed, public.notification_kick, public.notification_emit, public.quadrimesters_notify, public.user_roles_notify, public.job_runs_notify, public.notification_recipients, public.notification_not_before, public.notification_fanout, public.notification_claim, public.notification_due, public.castor_push_keys, public.castor_push_keys_init, public.push_subscribe, public.push_unsubscribe cascade;
  end if;

  -- ═════ 20261007120000_schema.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261007120000_schema.sql') then
    execute $castor_mig$
-- Castor Tracker — schéma applicatif.
-- Instance Supabase dédiée : tout vit dans le schéma public, exposé tel quel par PostgREST.
-- Lecture : vues et tables sous RLS ; écriture : Edge Functions (service_role) et administrateurs.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.app_config (
  id boolean primary key default true check (id),
  -- public : lecture sans compte ; restricted : comptes invités ; private : administrateurs seuls
  visibility text not null default 'restricted' check (visibility in ('public', 'restricted', 'private')),
  -- TOTP exigé pour les droits d'administration (session aal2)
  admin_mfa_required boolean not null default true,
  site_url text,
  yahoo_symbol text not null default 'DG.PA',
  euronext_code text not null default 'FR0000125486-XPAR',
  -- modèle d'URL du téléchargement Euronext ({code}, {from}, {to}) ; vide = adresse par défaut
  euronext_history_url text,
  -- écart toléré entre sources avant alerte, en points de base (50 = 0,5 %)
  alert_spread_bps integer not null default 50 check (alert_spread_bps > 0),
  updated_at timestamptz not null default now()
);
comment on table public.app_config is 'Réglages de l''application (ligne unique).';

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'viewer')),
  invited_by uuid,
  created_at timestamptz not null default now()
);
comment on table public.user_roles is 'Rôles applicatifs : admin ou viewer. Sans ligne, aucun accès en mode restreint.';

create table public.stock_prices (
  trade_date date primary key,
  open numeric(12, 4) check (open > 0),
  high numeric(12, 4) check (high > 0),
  low numeric(12, 4) check (low > 0),
  close numeric(12, 4) check (close > 0),
  vwap numeric(12, 4) check (vwap > 0),
  volume bigint check (volume >= 0),
  source text not null default 'yahoo',
  fetched_at timestamptz not null default now(),
  -- contrôle croisé (Euronext Live)
  check_open numeric(12, 4),
  check_close numeric(12, 4),
  check_source text,
  check_at timestamptz,
  -- une séance corrigée ou importée à la main n'est plus écrasée par la collecte
  is_manual boolean not null default false,
  manual_reason text,
  updated_by uuid,
  constraint stock_prices_manual_reason check (not is_manual or manual_reason is not null)
);
comment on table public.stock_prices is 'Une ligne par séance Euronext : cours bruts VINCI (DG), jamais ajustés.';

create table public.quote_live (
  id boolean primary key default true check (id),
  price numeric(12, 4) not null check (price > 0),
  prev_close numeric(12, 4),
  change_pct numeric(10, 6),
  day_open numeric(12, 4),
  quote_time timestamptz not null,
  source text not null,
  fetched_at timestamptz not null default now()
);
comment on table public.quote_live is 'Dernier cours connu (différé en séance, clôture sinon) ; ligne unique.';

create table public.market_holidays (
  day date primary key,
  label text not null,
  -- séance courte (24 et 31 décembre) : le marché est ouvert, la séance compte
  half_day boolean not null default false,
  source text not null default 'standard'
);
comment on table public.market_holidays is 'Fermetures Euronext Paris (et séances courtes, pour information).';

create table public.dividends (
  ex_date date primary key,
  amount numeric(10, 4) not null check (amount > 0),
  kind text not null default 'solde' check (kind in ('acompte', 'solde', 'exceptionnel')),
  pay_date date,
  source text,
  note text
);
comment on table public.dividends is 'Détachements de dividende VINCI (date de détachement, montant brut par action).';

create table public.quadrimesters (
  code text primary key check (code ~ '^\d{4}/[1-3]$'),
  start_date date not null,
  end_date date not null,
  payment_close_date date not null,
  board_date date,
  board_slot_start date,
  board_slot_end date,
  board_weights jsonb,
  board_status text not null default 'estimated' check (board_status in ('estimated', 'known', 'inferred')),
  board_source text,
  official_price numeric(12, 2) check (official_price > 0),
  official_published_at date,
  notice_url text,
  -- prix recalculé au centime par la formule active (fenêtre complète et date connue)
  computed_price numeric(12, 2),
  computed_missing integer,
  computed_at timestamptz,
  final_estimate_id bigint,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (payment_close_date between start_date and end_date),
  check (board_slot_start is null or board_slot_end is null or board_slot_end >= board_slot_start),
  check (board_weights is null or jsonb_typeof(board_weights) = 'object')
);
comment on table public.quadrimesters is 'Quadrimestres de souscription : période, CA fixant le prix, prix officiel.';

create table public.calc_params (
  id bigint generated always as identity primary key,
  valid_from timestamptz not null default now(),
  label text not null,
  window_days integer not null default 20 check (window_days between 1 and 60),
  discount_bps integer not null default 500 check (discount_bps between 0 and 5000),
  price_field text not null default 'open' check (price_field in ('open', 'close', 'vwap')),
  rounding text not null default 'nearest' check (rounding in ('nearest', 'up', 'down')),
  exclude_board_day boolean not null default true,
  tolerance_bps integer not null default 100 check (tolerance_bps between 1 and 2000),
  n_sims integer not null default 10000 check (n_sims between 100 and 100000),
  bootstrap_days integer not null default 250 check (bootstrap_days between 20 and 2500),
  model_sigma_bps numeric(8, 2) not null default 0 check (model_sigma_bps >= 0),
  active boolean not null default false,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index calc_params_one_active on public.calc_params (active) where active;
comment on table public.calc_params is 'Paramètres de calcul versionnés ; une seule version active.';

create table public.estimates (
  id bigint generated always as identity primary key,
  quadrimester_code text not null references public.quadrimesters (code) on update cascade on delete cascade,
  -- scheduled : tâche planifiée ; manual : relance admin ; final : archivée à l'annonce ; replay : rejeu historique
  kind text not null default 'scheduled' check (kind in ('scheduled', 'manual', 'final', 'replay')),
  computed_at timestamptz not null default now(),
  as_of date not null,
  last_price numeric(12, 4),
  last_price_date date,
  params_id bigint references public.calc_params (id) on delete set null,
  seed bigint,
  n_sims integer not null default 0,
  state text not null check (state in ('projection', 'window', 'frozen', 'computed', 'official')),
  central numeric(12, 2) not null,
  p05 numeric(12, 2) not null,
  p25 numeric(12, 2) not null,
  p75 numeric(12, 2) not null,
  p95 numeric(12, 2) not null,
  reliability numeric(5, 1) not null check (reliability between 0 and 100),
  prob_below numeric(6, 4),
  reference_price numeric(12, 2),
  known_sessions integer,
  known_min integer,
  known_max integer,
  most_probable_date date,
  window_start date,
  window_end date,
  board jsonb,
  details jsonb not null default '{}'::jsonb
);
create index estimates_quad_time on public.estimates (quadrimester_code, computed_at desc);
create unique index estimates_one_replay on public.estimates (quadrimester_code) where kind = 'replay';
comment on table public.estimates is 'Instantanés d''estimation : paramètres, graine et dernière séance utilisée (ENF-06).';

alter table public.quadrimesters
  add constraint quadrimesters_final_estimate_fk foreign key (final_estimate_id)
  references public.estimates (id) on delete set null;

create table public.backtests (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  kind text not null check (kind in ('formula', 'inference', 'replay')),
  params jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  results jsonb not null default '{}'::jsonb,
  exact_rate numeric(6, 4),
  mae numeric(12, 4),
  coverage numeric(6, 4),
  run_by uuid
);
create index backtests_kind_time on public.backtests (kind, run_at desc);

create table public.job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  trigger text not null default 'cron' check (trigger in ('cron', 'admin', 'system')),
  requested_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'error', 'skipped')),
  message text,
  details jsonb
);
create index job_runs_time on public.job_runs (started_at desc);
create index job_runs_job_time on public.job_runs (job, started_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  row_key text,
  action text not null,
  old jsonb,
  new jsonb,
  user_id uuid
);
create index audit_log_time on public.audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Fonctions d'accès (security definer : lisent user_roles et app_config sans RLS)
-- ---------------------------------------------------------------------------

create function public.paris_today() returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'Europe/Paris')::date $$;

create function public.has_role() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid());
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'admin')
     and (
       not coalesce((select c.admin_mfa_required from public.app_config c where c.id), true)
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     );
$$;

create function public.is_public_site() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select c.visibility = 'public' from public.app_config c where c.id), false);
$$;

create function public.can_read() returns boolean
language sql stable security definer set search_path = ''
as $$
  select case coalesce((select c.visibility from public.app_config c where c.id), 'restricted')
    when 'public' then true
    when 'restricted' then public.has_role()
    else public.is_admin()
  end;
$$;

-- Ce que le front doit savoir de l'utilisateur courant.
create function public.my_access() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'visibility', coalesce((select c.visibility from public.app_config c where c.id), 'restricted'),
    'mfa_required', coalesce((select c.admin_mfa_required from public.app_config c where c.id), true),
    'role', (select r.role from public.user_roles r where r.user_id = auth.uid()),
    'aal', auth.jwt() ->> 'aal',
    'is_admin', public.is_admin(),
    'can_read', public.can_read()
  );
$$;

-- ---------------------------------------------------------------------------
-- Triggers : horodatage et journal d'audit des écritures admin
-- ---------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger quadrimesters_updated_at before update on public.quadrimesters
  for each row execute function public.set_updated_at();
create trigger app_config_updated_at before update on public.app_config
  for each row execute function public.set_updated_at();

-- Journalise les écritures faites avec un JWT utilisateur (admin). Les Edge Functions
-- (service_role, sans utilisateur) et les scripts SQL ne sont pas journalisés ici :
-- leurs traitements le sont dans job_runs. Argument : nom de la colonne clé.
create function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_key text;
begin
  if v_user is null or coalesce(current_setting('castor.skip_audit', true), '') = 'on' then
    return null;
  end if;
  v_key := coalesce(to_jsonb(new) ->> tg_argv[0], to_jsonb(old) ->> tg_argv[0]);
  insert into public.audit_log (table_name, row_key, action, old, new, user_id)
  values (
    tg_table_name,
    v_key,
    lower(tg_op),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end,
    v_user
  );
  return null;
end;
$$;

create trigger audit_quadrimesters after insert or update or delete on public.quadrimesters
  for each row execute function public.audit_trigger('code');
create trigger audit_calc_params after insert or update or delete on public.calc_params
  for each row execute function public.audit_trigger('id');
create trigger audit_dividends after insert or update or delete on public.dividends
  for each row execute function public.audit_trigger('ex_date');
create trigger audit_market_holidays after insert or update or delete on public.market_holidays
  for each row execute function public.audit_trigger('day');
create trigger audit_stock_prices after insert or update or delete on public.stock_prices
  for each row execute function public.audit_trigger('trade_date');
create trigger audit_user_roles after insert or update or delete on public.user_roles
  for each row execute function public.audit_trigger('user_id');
create trigger audit_app_config after insert or update or delete on public.app_config
  for each row execute function public.audit_trigger('id');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.app_config enable row level security;
alter table public.user_roles enable row level security;
alter table public.stock_prices enable row level security;
alter table public.quote_live enable row level security;
alter table public.market_holidays enable row level security;
alter table public.dividends enable row level security;
alter table public.quadrimesters enable row level security;
alter table public.calc_params enable row level security;
alter table public.estimates enable row level security;
alter table public.backtests enable row level security;
alter table public.job_runs enable row level security;
alter table public.audit_log enable row level security;

-- Données publiables : lisibles selon la visibilité du site, modifiables par les admins.
do $$
declare
  t text;
begin
  foreach t in array array[
    'stock_prices', 'quote_live', 'market_holidays', 'dividends',
    'quadrimesters', 'calc_params', 'estimates', 'backtests'
  ] loop
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using ((select public.can_read()))',
      t || '_read', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select public.is_admin()))',
      t || '_admin_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))',
      t || '_admin_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select public.is_admin()))',
      t || '_admin_delete', t);
  end loop;
end;
$$;

-- Réglages : lisibles par tous (le front en a besoin avant connexion), modifiables par les admins.
create policy app_config_read on public.app_config for select to anon, authenticated using (true);
create policy app_config_admin_update on public.app_config for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Rôles : chacun voit le sien, les admins voient et gèrent tout.
create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check ((select public.is_admin()));
create policy user_roles_admin_update on public.user_roles for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy user_roles_admin_delete on public.user_roles for delete to authenticated
  using ((select public.is_admin()) and user_id <> (select auth.uid()));

-- Journaux : lecture admin seulement ; écriture par les fonctions (service_role) et les triggers.
create policy job_runs_admin_read on public.job_runs for select to authenticated using ((select public.is_admin()));
create policy audit_log_admin_read on public.audit_log for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Vues lues par le front (security_invoker : la RLS de l'appelant s'applique)
-- ---------------------------------------------------------------------------

create view public.v_dashboard with (security_invoker = true) as
select
  t.d as today,
  c.code as current_code,
  c.start_date as current_start,
  c.end_date as current_end,
  c.payment_close_date as current_payment_close,
  c.official_price as current_price,
  n.code as next_code,
  n.start_date as next_start,
  n.end_date as next_end,
  n.payment_close_date as next_payment_close,
  n.board_date,
  n.board_slot_start,
  n.board_slot_end,
  n.board_weights,
  n.board_status,
  n.board_source,
  e.id as estimate_id,
  e.kind as estimate_kind,
  e.computed_at,
  e.as_of,
  e.state,
  e.central,
  e.p05,
  e.p25,
  e.p75,
  e.p95,
  e.reliability,
  e.prob_below,
  e.reference_price,
  e.known_sessions,
  e.known_min,
  e.known_max,
  e.most_probable_date,
  e.window_start,
  e.window_end,
  e.last_price as estimate_last_price,
  e.n_sims,
  e.seed,
  e.details,
  ql.price as quote_price,
  ql.prev_close as quote_prev_close,
  ql.change_pct as quote_change_pct,
  ql.day_open as quote_day_open,
  ql.quote_time,
  ql.source as quote_source,
  sp.trade_date as last_session,
  sp.open as last_open,
  sp.close as last_close
from (select public.paris_today() as d) t
left join lateral (
  select q.* from public.quadrimesters q
  where t.d between q.start_date and q.end_date
  order by q.code limit 1
) c on true
left join lateral (
  select q.* from public.quadrimesters q
  where q.start_date > t.d and q.official_price is null
  order by q.start_date limit 1
) n on true
left join lateral (
  select x.* from public.estimates x
  where x.quadrimester_code = n.code and x.kind in ('scheduled', 'manual')
  order by x.computed_at desc limit 1
) e on true
left join public.quote_live ql on true
left join lateral (
  select s.* from public.stock_prices s order by s.trade_date desc limit 1
) sp on true;
comment on view public.v_dashboard is 'Tableau de bord : quadrimestre en cours, prochain prix estimé, CA, cours.';

create view public.v_history with (security_invoker = true) as
select
  q.code,
  q.start_date,
  q.end_date,
  q.payment_close_date,
  q.board_date,
  q.board_slot_start,
  q.board_slot_end,
  q.board_status,
  q.board_source,
  q.official_price,
  q.official_published_at,
  q.notice_url,
  q.computed_price,
  q.computed_missing,
  case when q.computed_price is not null and q.official_price is not null
    then q.computed_price - q.official_price end as computed_diff,
  fe.id as estimate_id,
  fe.kind as estimate_kind,
  fe.as_of as estimate_as_of,
  fe.central as estimate_central,
  fe.p05 as estimate_p05,
  fe.p95 as estimate_p95,
  fe.reliability as estimate_reliability,
  fe.state as estimate_state,
  -- écart = estimation − prix réel (négatif : l'estimation était trop basse)
  case when fe.central is not null and q.official_price is not null
    then fe.central - q.official_price end as estimate_diff,
  case when fe.central is not null and q.official_price is not null
    then round((fe.central - q.official_price) / q.official_price, 6) end as estimate_diff_pct,
  ql.price as quote_price,
  case when ql.price is not null and coalesce(q.official_price, fe.central) > 0
    then round(ql.price / coalesce(q.official_price, fe.central) - 1, 6) end as gain_pct
from public.quadrimesters q
left join lateral (
  select x.* from public.estimates x
  where x.quadrimester_code = q.code
  order by
    coalesce(x.id = q.final_estimate_id, false) desc,
    (q.official_price is null and x.kind in ('scheduled', 'manual')) desc,
    (x.kind = 'replay') desc,
    x.computed_at desc
  limit 1
) fe on true
left join public.quote_live ql on true;
comment on view public.v_history is 'Historique : prix estimé (archivé ou rejoué), prix réel, écart et plus-value.';

create view public.v_estimate_history with (security_invoker = true) as
select distinct on (e.quadrimester_code, (e.computed_at at time zone 'Europe/Paris')::date)
  e.quadrimester_code,
  (e.computed_at at time zone 'Europe/Paris')::date as day,
  e.computed_at,
  e.as_of,
  e.state,
  e.central,
  e.p05,
  e.p25,
  e.p75,
  e.p95,
  e.reliability,
  e.known_sessions,
  e.prob_below
from public.estimates e
where e.kind in ('scheduled', 'manual')
order by e.quadrimester_code, (e.computed_at at time zone 'Europe/Paris')::date, e.computed_at desc;
comment on view public.v_estimate_history is 'Convergence de l''estimation : dernière valeur de chaque jour.';

create view public.v_job_status with (security_invoker = true) as
select distinct on (j.job)
  j.job,
  j.started_at,
  j.finished_at,
  j.status,
  j.message,
  extract(epoch from (j.finished_at - j.started_at)) * 1000 as duration_ms,
  (
    select count(*) from (
      select x.status from public.job_runs x
      where x.job = j.job and x.status in ('success', 'error')
      order by x.started_at desc limit 2
    ) last2 where last2.status = 'error'
  ) as recent_errors
from public.job_runs j
where j.status in ('success', 'error')
order by j.job, j.started_at desc;
comment on view public.v_job_status is 'Dernier passage de chaque tâche ; alerte si les deux derniers ont échoué.';

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

-- Série de cours pour les graphiques : [date, ouverture, clôture], une seule valeur JSON.
create function public.price_series(p_from date default null, p_to date default null)
returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(s.trade_date, s.open, s.close) order by s.trade_date), '[]'::jsonb)
  from public.stock_prices s
  where (p_from is null or s.trade_date >= p_from)
    and (p_to is null or s.trade_date <= p_to);
$$;

-- Collecte (Edge Functions) : ne remplace jamais une séance corrigée à la main.
-- p_mode : full (séance complète), open (ouverture seule), control (contrôle croisé).
create function public.upsert_prices(p_rows jsonb, p_source text, p_mode text default 'full')
returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if p_mode not in ('full', 'open', 'control') then
    raise exception 'mode inconnu : %', p_mode;
  end if;
  if p_mode = 'control' then
    update public.stock_prices s set
      check_open = round(r.open, 4),
      check_close = round(r.close, 4),
      check_source = p_source,
      check_at = now(),
      vwap = coalesce(round(r.vwap, 4), s.vwap)
    from jsonb_to_recordset(p_rows) as r(date date, open numeric, close numeric, vwap numeric)
    where s.trade_date = r.date;
    get diagnostics v_count = row_count;
    return jsonb_build_object('updated', v_count, 'received', jsonb_array_length(p_rows));
  end if;

  with rows as (
    select *
    from jsonb_to_recordset(p_rows) as r(date date, open numeric, high numeric, low numeric,
                                         close numeric, vwap numeric, volume bigint)
    where r.open is not null or (p_mode = 'full' and r.close is not null)
  ), up as (
    insert into public.stock_prices as s (trade_date, open, high, low, close, vwap, volume, source, fetched_at)
    select
      r.date,
      round(r.open, 4),
      case when p_mode = 'full' then round(r.high, 4) end,
      case when p_mode = 'full' then round(r.low, 4) end,
      case when p_mode = 'full' then round(r.close, 4) end,
      case when p_mode = 'full' then round(r.vwap, 4) end,
      case when p_mode = 'full' then r.volume end,
      p_source,
      now()
    from rows r
    on conflict (trade_date) do update set
      open = coalesce(excluded.open, s.open),
      high = case when p_mode = 'full' then coalesce(excluded.high, s.high) else s.high end,
      low = case when p_mode = 'full' then coalesce(excluded.low, s.low) else s.low end,
      close = case when p_mode = 'full' then coalesce(excluded.close, s.close) else s.close end,
      vwap = case when p_mode = 'full' then coalesce(excluded.vwap, s.vwap) else s.vwap end,
      volume = case when p_mode = 'full' then coalesce(excluded.volume, s.volume) else s.volume end,
      source = excluded.source,
      fetched_at = now()
    where not s.is_manual
    returning 1
  )
  select count(*) into v_count from up;
  return jsonb_build_object('upserted', v_count, 'received', jsonb_array_length(p_rows));
end;
$$;

-- Import CSV de cours depuis le back-office : séances marquées manuelles, une seule ligne d'audit.
create function public.admin_import_prices(p_rows jsonb, p_reason text, p_overwrite boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_updated integer := 0;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'Import CSV');
begin
  if not public.is_admin() then
    raise exception 'réservé aux administrateurs' using errcode = '42501';
  end if;
  perform set_config('castor.skip_audit', 'on', true);
  with rows as (
    select *
    from jsonb_to_recordset(p_rows) as r(date date, open numeric, high numeric, low numeric,
                                         close numeric, vwap numeric, volume bigint)
    where r.date is not null and (r.open is not null or r.close is not null)
  ), up as (
    insert into public.stock_prices as s
      (trade_date, open, high, low, close, vwap, volume, source, fetched_at, is_manual, manual_reason, updated_by)
    select r.date, round(r.open, 4), round(r.high, 4), round(r.low, 4), round(r.close, 4),
           round(r.vwap, 4), r.volume, 'csv', now(), true, v_reason, auth.uid()
    from rows r
    on conflict (trade_date) do update set
      open = coalesce(excluded.open, s.open),
      high = coalesce(excluded.high, s.high),
      low = coalesce(excluded.low, s.low),
      close = coalesce(excluded.close, s.close),
      vwap = coalesce(excluded.vwap, s.vwap),
      volume = coalesce(excluded.volume, s.volume),
      source = 'csv',
      fetched_at = now(),
      is_manual = true,
      manual_reason = excluded.manual_reason,
      updated_by = excluded.updated_by
    where p_overwrite
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
  from up;
  perform set_config('castor.skip_audit', 'off', true);
  insert into public.audit_log (table_name, row_key, action, new, user_id)
  values ('stock_prices', 'import', 'import',
          jsonb_build_object('received', jsonb_array_length(p_rows), 'inserted', v_inserted,
                             'updated', v_updated, 'overwrite', p_overwrite, 'reason', v_reason),
          auth.uid());
  return jsonb_build_object('received', jsonb_array_length(p_rows), 'inserted', v_inserted,
                            'updated', v_updated, 'skipped', jsonb_array_length(p_rows) - v_inserted - v_updated);
end;
$$;

-- Active une version de paramètres (une seule active à la fois).
create function public.activate_calc_params(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'réservé aux administrateurs' using errcode = '42501';
  end if;
  if not exists (select 1 from public.calc_params where id = p_id) then
    raise exception 'paramètres % introuvables', p_id;
  end if;
  update public.calc_params set active = false where active and id <> p_id;
  update public.calc_params set active = true, valid_from = now() where id = p_id and not active;
end;
$$;

-- Saisie du prix officiel (EF-41) : archive la dernière estimation et passe le quadrimestre en « officiel ».
create function public.admin_set_official_price(
  p_code text,
  p_price numeric,
  p_published date default null,
  p_notice_url text default null
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_quad public.quadrimesters;
  v_final bigint;
begin
  if not public.is_admin() then
    raise exception 'réservé aux administrateurs' using errcode = '42501';
  end if;
  select * into v_quad from public.quadrimesters where code = p_code for update;
  if not found then
    raise exception 'quadrimestre % introuvable', p_code;
  end if;
  v_final := v_quad.final_estimate_id;
  if v_final is null then
    insert into public.estimates (
      quadrimester_code, kind, computed_at, as_of, last_price, last_price_date, params_id, seed, n_sims,
      state, central, p05, p25, p75, p95, reliability, prob_below, reference_price, known_sessions,
      known_min, known_max, most_probable_date, window_start, window_end, board, details)
    select
      e.quadrimester_code, 'final', e.computed_at, e.as_of, e.last_price, e.last_price_date, e.params_id,
      e.seed, e.n_sims, e.state, e.central, e.p05, e.p25, e.p75, e.p95, e.reliability, e.prob_below,
      e.reference_price, e.known_sessions, e.known_min, e.known_max, e.most_probable_date,
      e.window_start, e.window_end, e.board,
      e.details || jsonb_build_object('archived_at', now(), 'source_estimate_id', e.id)
    from public.estimates e
    where e.quadrimester_code = p_code and e.kind in ('scheduled', 'manual')
    order by e.computed_at desc
    limit 1
    returning id into v_final;
  end if;
  update public.quadrimesters set
    official_price = round(p_price, 2),
    official_published_at = coalesce(p_published, public.paris_today()),
    notice_url = coalesce(nullif(trim(p_notice_url), ''), notice_url),
    final_estimate_id = v_final
  where code = p_code;
  return v_final;
end;
$$;

-- Vérifie le secret partagé des appels pg_cron (stocké dans Vault, jamais dans le code).
create function public.castor_verify_cron_secret(p_secret text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_secret text;
begin
  if p_secret is null or length(p_secret) < 24 then
    return false;
  end if;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1'
      into v_secret using 'castor_cron_secret';
  exception when undefined_table or invalid_schema_name or undefined_function then
    return false;
  end;
  return v_secret is not null and v_secret = p_secret;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
grant select on public.app_config, public.stock_prices, public.quote_live, public.market_holidays,
  public.dividends, public.quadrimesters, public.calc_params, public.estimates, public.backtests
  to anon, authenticated;
grant select on public.v_dashboard, public.v_history, public.v_estimate_history to anon, authenticated;
grant select on public.user_roles, public.job_runs, public.audit_log, public.v_job_status to authenticated;
grant insert, update, delete on public.stock_prices, public.market_holidays, public.dividends,
  public.quadrimesters, public.calc_params, public.estimates, public.backtests, public.user_roles
  to authenticated;
grant update on public.app_config to authenticated;
grant all on all tables in schema public to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.paris_today(), public.has_role(), public.is_admin(), public.is_public_site(),
  public.can_read(), public.my_access(), public.price_series(date, date) to anon, authenticated;
grant execute on function public.admin_import_prices(jsonb, text, boolean), public.activate_calc_params(bigint),
  public.admin_set_official_price(text, numeric, date, text) to authenticated;
grant execute on function public.upsert_prices(jsonb, text, text), public.castor_verify_cron_secret(text)
  to service_role;
grant execute on all functions in schema public to service_role;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261007120000_schema.sql', '5642e04c0bf9a19f');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261007120100_seed.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261007120100_seed.sql') then
    execute $castor_mig$
-- Castor Tracker — données de référence initiales.
-- Prix officiels et dates de CA : avis publiés par VINCI (sources dans notice_url).
-- Les autres quadrimestres 2018–2025 s'importent depuis le back-office (CSV).

insert into public.app_config (id, visibility, admin_mfa_required) values (true, 'restricted', true)
on conflict (id) do nothing;

-- Paramètres par défaut : formule des avis VINCI (premiers cours cotés, jour du CA exclu).
insert into public.calc_params (label, window_days, discount_bps, price_field, rounding, exclude_board_day,
  tolerance_bps, n_sims, bootstrap_days, model_sigma_bps, active, note)
values ('Avis VINCI : 95 % des 20 ouvertures', 20, 500, 'open', 'nearest', true, 100, 10000, 250, 0, true,
  'Version initiale, à confirmer par le backtest au centime (REC-01).');

-- Fermetures Euronext Paris 2015–2027 et séances courtes (marché ouvert).
insert into public.market_holidays (day, label, half_day, source) values
  ('2015-01-01', 'Jour de l''an', false, 'standard'),
  ('2015-04-03', 'Vendredi saint', false, 'standard'),
  ('2015-04-06', 'Lundi de Pâques', false, 'standard'),
  ('2015-05-01', 'Fête du travail', false, 'standard'),
  ('2015-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2015-12-25', 'Noël', false, 'standard'),
  ('2015-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2015-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2016-01-01', 'Jour de l''an', false, 'standard'),
  ('2016-03-25', 'Vendredi saint', false, 'standard'),
  ('2016-03-28', 'Lundi de Pâques', false, 'standard'),
  ('2016-05-01', 'Fête du travail', false, 'standard'),
  ('2016-12-25', 'Noël', false, 'standard'),
  ('2016-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2017-01-01', 'Jour de l''an', false, 'standard'),
  ('2017-04-14', 'Vendredi saint', false, 'standard'),
  ('2017-04-17', 'Lundi de Pâques', false, 'standard'),
  ('2017-05-01', 'Fête du travail', false, 'standard'),
  ('2017-12-25', 'Noël', false, 'standard'),
  ('2017-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2018-01-01', 'Jour de l''an', false, 'standard'),
  ('2018-03-30', 'Vendredi saint', false, 'standard'),
  ('2018-04-02', 'Lundi de Pâques', false, 'standard'),
  ('2018-05-01', 'Fête du travail', false, 'standard'),
  ('2018-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2018-12-25', 'Noël', false, 'standard'),
  ('2018-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2018-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2019-01-01', 'Jour de l''an', false, 'standard'),
  ('2019-04-19', 'Vendredi saint', false, 'standard'),
  ('2019-04-22', 'Lundi de Pâques', false, 'standard'),
  ('2019-05-01', 'Fête du travail', false, 'standard'),
  ('2019-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2019-12-25', 'Noël', false, 'standard'),
  ('2019-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2019-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2020-01-01', 'Jour de l''an', false, 'standard'),
  ('2020-04-10', 'Vendredi saint', false, 'standard'),
  ('2020-04-13', 'Lundi de Pâques', false, 'standard'),
  ('2020-05-01', 'Fête du travail', false, 'standard'),
  ('2020-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2020-12-25', 'Noël', false, 'standard'),
  ('2020-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2020-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2021-01-01', 'Jour de l''an', false, 'standard'),
  ('2021-04-02', 'Vendredi saint', false, 'standard'),
  ('2021-04-05', 'Lundi de Pâques', false, 'standard'),
  ('2021-05-01', 'Fête du travail', false, 'standard'),
  ('2021-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2021-12-25', 'Noël', false, 'standard'),
  ('2021-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2021-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2022-01-01', 'Jour de l''an', false, 'standard'),
  ('2022-04-15', 'Vendredi saint', false, 'standard'),
  ('2022-04-18', 'Lundi de Pâques', false, 'standard'),
  ('2022-05-01', 'Fête du travail', false, 'standard'),
  ('2022-12-25', 'Noël', false, 'standard'),
  ('2022-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2023-01-01', 'Jour de l''an', false, 'standard'),
  ('2023-04-07', 'Vendredi saint', false, 'standard'),
  ('2023-04-10', 'Lundi de Pâques', false, 'standard'),
  ('2023-05-01', 'Fête du travail', false, 'standard'),
  ('2023-12-25', 'Noël', false, 'standard'),
  ('2023-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2024-01-01', 'Jour de l''an', false, 'standard'),
  ('2024-03-29', 'Vendredi saint', false, 'standard'),
  ('2024-04-01', 'Lundi de Pâques', false, 'standard'),
  ('2024-05-01', 'Fête du travail', false, 'standard'),
  ('2024-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2024-12-25', 'Noël', false, 'standard'),
  ('2024-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2024-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2025-01-01', 'Jour de l''an', false, 'standard'),
  ('2025-04-18', 'Vendredi saint', false, 'standard'),
  ('2025-04-21', 'Lundi de Pâques', false, 'standard'),
  ('2025-05-01', 'Fête du travail', false, 'standard'),
  ('2025-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2025-12-25', 'Noël', false, 'standard'),
  ('2025-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2025-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2026-01-01', 'Jour de l''an', false, 'standard'),
  ('2026-04-03', 'Vendredi saint', false, 'standard'),
  ('2026-04-06', 'Lundi de Pâques', false, 'standard'),
  ('2026-05-01', 'Fête du travail', false, 'standard'),
  ('2026-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2026-12-25', 'Noël', false, 'standard'),
  ('2026-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2026-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard'),
  ('2027-01-01', 'Jour de l''an', false, 'standard'),
  ('2027-03-26', 'Vendredi saint', false, 'standard'),
  ('2027-03-29', 'Lundi de Pâques', false, 'standard'),
  ('2027-05-01', 'Fête du travail', false, 'standard'),
  ('2027-12-24', 'Veille de Noël (séance courte)', true, 'standard'),
  ('2027-12-25', 'Noël', false, 'standard'),
  ('2027-12-26', 'Lendemain de Noël', false, 'standard'),
  ('2027-12-31', 'Saint-Sylvestre (séance courte)', true, 'standard')
on conflict (day) do nothing;

-- Acompte 2026 : 1,10 € versé le 15/10/2026 (communiqué du 30/07/2026), détaché deux séances avant.
insert into public.dividends (ex_date, amount, kind, pay_date, source, note) values
  ('2026-10-13', 1.10, 'acompte', '2026-10-15', 'Communiqué VINCI du 30/07/2026',
   'Date de détachement déduite du paiement (J−2 séances) ; à confirmer.')
on conflict (ex_date) do nothing;

insert into public.quadrimesters (code, start_date, end_date, payment_close_date, board_date, board_slot_start,
  board_slot_end, board_status, board_source, official_price, official_published_at, notice_url) values
  ('2022/1', '2022-01-01', '2022-04-30', '2022-04-15', '2021-10-20', null, null, 'known',
   'Avis VINCI du 30/12/2021', 85.59, '2021-12-30',
   'https://echanges.dila.gouv.fr/OPENDATA/AMF/MKW/2021/12/FCMKW133530_20211230.pdf'),
  ('2024/3', '2024-09-01', '2024-12-31', '2024-12-15', '2024-06-13', null, null, 'known',
   'Avis VINCI du 30/08/2024', 107.41, '2024-08-30',
   'https://echanges.dila.gouv.fr/OPENDATA/AMF/MKW/2024/08/FCMKW132254_20240830.pdf'),
  ('2026/1', '2026-01-01', '2026-04-30', '2026-04-15', '2025-10-15', null, null, 'known',
   'Règlement du FCPE Castor Relais 2026/1 (fenêtre du 17/09 au 14/10/2025)', 111.27, null,
   'https://castor.vinci.com/wp-content/uploads/2026/01/rgt-castor-relais-2026-1.pdf'),
  ('2026/2', '2026-05-01', '2026-08-31', '2026-08-15', '2026-02-05', null, null, 'known',
   'Avis VINCI du 30/04/2026', 112.93, '2026-04-30',
   'https://www.vinci.com/publi/finance/2026/emission-actions-nouvelles-vinci-reservee-salaries-france-plan-epargne-april-2026.pdf'),
  ('2026/3', '2026-09-01', '2026-12-31', '2026-12-15', '2026-06-23', null, null, 'known',
   'Avis VINCI du 31/08/2026', 119.33, '2026-08-31',
   'https://www.vinci.com/publi/finance/2026/2026-document-information-castor.pdf'),
  ('2027/1', '2027-01-01', '2027-04-30', '2027-04-15', null, '2026-10-14', '2026-10-23', 'estimated',
   'Créneau par défaut, calé sur les CA d''octobre 2021–2025', null, null, null),
  ('2027/2', '2027-05-01', '2027-08-31', '2027-08-15', null, '2027-02-01', '2027-02-12', 'estimated',
   'Créneau par défaut (CA de début février)', null, null, null),
  ('2027/3', '2027-09-01', '2027-12-31', '2027-12-15', null, '2027-06-10', '2027-06-26', 'estimated',
   'Créneau par défaut (CA de juin)', null, null, null)
on conflict (code) do nothing;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261007120100_seed.sql', 'd3cc2210694eb8d8');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261007120200_cron.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261007120200_cron.sql') then
    execute $castor_mig$
-- Castor Tracker — planification : pg_cron déclenche l'Edge Function castor-jobs via pg_net.
-- pg_cron compte en UTC : chaque tâche est planifiée aux heures UTC d'été et d'hiver ;
-- la fonction vérifie l'heure de Paris et l'état de la base pour ne travailler qu'une fois.
-- URL des fonctions et secret partagé sont dans Vault (scripts/configure-supabase.sh).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  else
    raise notice 'pg_net indisponible : appels HTTP planifiés désactivés';
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  else
    raise notice 'pg_cron indisponible : planification désactivée';
  end if;
end;
$$;

-- Écrit (ou remplace) un secret Vault par son nom.
create function public.castor_set_secret(p_name text, p_value text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  execute 'select id from vault.secrets where name = $1' into v_id using p_name;
  if v_id is null then
    execute 'select vault.create_secret($1, $2, $3)' using p_value, p_name, 'Castor Tracker';
  else
    execute 'select vault.update_secret($1, $2)' using v_id, p_value;
  end if;
end;
$$;

create function public.castor_secret(p_name text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v text;
begin
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using p_name;
  return v;
exception when undefined_table or invalid_schema_name or undefined_function then
  return null;
end;
$$;

-- Appel asynchrone de castor-jobs (pg_net) ; renvoie l'identifiant de requête.
create function public.castor_call(p_task text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text := public.castor_secret('castor_functions_url');
  v_secret text := public.castor_secret('castor_cron_secret');
  v_anon text := public.castor_secret('castor_anon_key');
  v_headers jsonb;
  v_id bigint;
begin
  if v_url is null or v_secret is null then
    raise exception 'secrets Vault manquants : castor_functions_url et castor_cron_secret (lancer scripts/configure-supabase.sh)';
  end if;
  v_headers := jsonb_build_object('Content-Type', 'application/json', 'x-castor-cron', v_secret);
  if v_anon is not null then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_anon, 'apikey', v_anon);
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 55000)'
    into v_id
    using rtrim(v_url, '/') || '/castor-jobs',
          jsonb_build_object('task', p_task, 'trigger', 'cron') || coalesce(p_body, '{}'::jsonb),
          v_headers;
  return v_id;
end;
$$;

-- (Re)crée les tâches planifiées. Heures UTC ; la fonction filtre en heure de Paris.
create function public.castor_setup_cron()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  j record;
  v_n integer := 0;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return 'pg_cron absent : aucune tâche planifiée';
  end if;
  for j in
    select * from (values
      -- ouverture du jour : 9 h 20, relance 9 h 40 (Paris)
      ('castor-open', '20,40 7,8 * * 1-5', 'open'),
      -- cours en séance : toutes les 15 min, 9 h – 17 h 45 (Paris)
      ('castor-quote', '*/15 7-16 * * 1-5', 'quote'),
      -- séance complète et estimation : 18 h, relance 18 h 30 (Paris)
      ('castor-session', '0,30 16,17 * * 1-5', 'session'),
      -- dernière relance : 21 h (Paris)
      ('castor-session-late', '0 19,20 * * 1-5', 'session'),
      -- rattrapage des 30 derniers jours : 7 h 30 (Paris), tous les jours
      ('castor-catchup', '30 5,6 * * *', 'catchup'),
      -- contrôles et purge : le 1er du mois
      ('castor-maintenance', '15 2 1 * *', 'maintenance')
    ) as t(name, schedule, task)
  loop
    execute 'select cron.schedule($1, $2, $3)'
      using j.name, j.schedule, format('select public.castor_call(%L)', j.task);
    v_n := v_n + 1;
  end loop;
  return format('%s tâches planifiées', v_n);
end;
$$;

create function public.castor_unschedule_cron()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_n integer := 0;
  v_name text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return 'pg_cron absent';
  end if;
  for v_name in execute 'select jobname from cron.job where jobname like ''castor-%''' loop
    execute 'select cron.unschedule($1)' using v_name;
    v_n := v_n + 1;
  end loop;
  return format('%s tâches supprimées', v_n);
end;
$$;

revoke execute on function public.castor_set_secret(text, text), public.castor_secret(text),
  public.castor_call(text, jsonb), public.castor_setup_cron(), public.castor_unschedule_cron()
  from public, anon, authenticated, service_role;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261007120200_cron.sql', '784b70d3f313b8f5');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261008120000_cloud_api_keys.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261008120000_cloud_api_keys.sql') then
    execute $castor_mig$
-- Castor Tracker — compatibilité avec les clés d'API de Supabase Cloud (publishable / secret).
-- Les nouvelles clés (sb_publishable_…, sb_secret_…) ne sont pas des JWT : elles passent dans l'en-tête
-- apikey, jamais en « Authorization: Bearer », que la passerelle refuserait. Une clé anon historique
-- (JWT, auto-hébergement) garde les deux en-têtes.

create or replace function public.castor_call(p_task text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text := public.castor_secret('castor_functions_url');
  v_secret text := public.castor_secret('castor_cron_secret');
  v_key text := public.castor_secret('castor_anon_key');
  v_headers jsonb;
  v_id bigint;
begin
  if v_url is null or v_secret is null then
    raise exception 'secrets Vault manquants : castor_functions_url et castor_cron_secret (lancer scripts/configure-supabase.sh)';
  end if;
  v_headers := jsonb_build_object('Content-Type', 'application/json', 'x-castor-cron', v_secret);
  if v_key is not null then
    v_headers := v_headers || jsonb_build_object('apikey', v_key);
    if v_key like 'eyJ%' then
      v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_key);
    end if;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 55000)'
    into v_id
    using rtrim(v_url, '/') || '/castor-jobs',
          jsonb_build_object('task', p_task, 'trigger', 'cron') || coalesce(p_body, '{}'::jsonb),
          v_headers;
  return v_id;
end;
$$;

revoke execute on function public.castor_call(text, jsonb) from public, anon, authenticated, service_role;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261008120000_cloud_api_keys.sql', 'f47bf5bdef91970f');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261008150000_self_register.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261008150000_self_register.sql') then
    execute $castor_mig$
-- Castor Tracker — installation sans script (Supabase Cloud, éditeur SQL du tableau de bord).
-- castor-jobs enregistre elle-même son adresse dans Vault au premier appel d'un administrateur :
-- aucune URL ni aucun secret à saisir à la main. Une valeur déjà présente (posée par
-- scripts/configure-supabase.sh en auto-hébergement) n'est jamais remplacée.

create or replace function public.castor_register_endpoint(p_url text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_done text[] := '{}';
  v_has_jobs boolean;
begin
  if p_url is null or p_url !~ '^https?://[^ ]+$' then
    return 'adresse refusée';
  end if;
  if public.castor_secret('castor_functions_url') is null then
    perform public.castor_set_secret('castor_functions_url', rtrim(p_url, '/'));
    v_done := v_done || 'adresse des fonctions'::text;
  end if;
  if public.castor_secret('castor_cron_secret') is null then
    perform public.castor_set_secret('castor_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
    v_done := v_done || 'secret des tâches'::text;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job where jobname like ''castor-%'')' into v_has_jobs;
    if not v_has_jobs then
      perform public.castor_setup_cron();
      v_done := v_done || 'tâches planifiées'::text;
    end if;
  end if;
  return coalesce(nullif(array_to_string(v_done, ', '), ''), 'déjà en place');
end;
$$;

revoke execute on function public.castor_register_endpoint(text) from public, anon, authenticated;
grant execute on function public.castor_register_endpoint(text) to service_role;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261008150000_self_register.sql', '13409b8338911e33');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261008190000_page_views.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261008190000_page_views.sql') then
    execute $castor_mig$
-- Castor Tracker — fréquentation de la PWA : une ligne par page affichée.
-- Ni adresse IP ni identifiant de compte : un identifiant aléatoire par navigateur (localStorage)
-- sert à compter les visiteurs uniques. Les pages /admin ne sont pas comptées.

create table public.page_views (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  path text not null check (length(path) between 1 and 200),
  visitor text check (visitor is null or visitor ~ '^[0-9a-f-]{8,64}$'),
  signed_in boolean not null default false
);
create index page_views_at on public.page_views (at);
create index page_views_visitor_at on public.page_views (visitor, at desc);
comment on table public.page_views is 'Pages affichées dans la PWA (fréquentation) ; purge après 13 mois (maintenance).';

-- Aucune policy : la table n'est lue et écrite que par les fonctions ci-dessous et par service_role.
alter table public.page_views enable row level security;

-- Enregistre l'affichage d'une page (appelé par la PWA à chaque changement de route, avec ou sans compte).
create function public.track_page_view(p_path text, p_visitor text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_path text := left(coalesce(nullif(trim(p_path), ''), '/'), 200);
  v_visitor text := case when p_visitor ~ '^[0-9a-f-]{8,64}$' then p_visitor end;
begin
  if v_path like '/admin%' then
    return;
  end if;
  -- anti-rebond : même navigateur et même page à moins de 10 s d'intervalle
  if v_visitor is not null and exists (
    select 1 from public.page_views v
    where v.visitor = v_visitor and v.path = v_path and v.at > now() - interval '10 seconds'
  ) then
    return;
  end if;
  insert into public.page_views (path, visitor, signed_in) values (v_path, v_visitor, auth.uid() is not null);
end;
$$;

-- Fréquentation heure par heure (heure de Paris) sur les p_hours dernières heures, heure en cours comprise.
-- Renvoie { hours: [[« AAAA-MM-JJTHH:00 », affichages, visiteurs], …], views, visitors } ; les heures vides valent 0.
-- Changement d'heure : l'heure doublée d'octobre est cumulée sur un seul créneau, l'heure sautée de mars vaut 0.
create function public.admin_page_views_hourly(p_hours integer default 24)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_hours integer := least(greatest(coalesce(p_hours, 24), 1), 24 * 92);
  v_end timestamp := date_trunc('hour', now() at time zone 'Europe/Paris');
  v_start timestamp := v_end - make_interval(hours => v_hours - 1);
  v_from timestamptz := v_start at time zone 'Europe/Paris';
begin
  if not public.is_admin() then
    raise exception 'réservé aux administrateurs' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'hours', (
      select coalesce(jsonb_agg(jsonb_build_array(
        to_char(h.hour, 'YYYY-MM-DD"T"HH24:00'), coalesce(v.views, 0), coalesce(v.visitors, 0)) order by h.hour), '[]'::jsonb)
      from generate_series(v_start, v_end, interval '1 hour') as h(hour)
      left join (
        select date_trunc('hour', p.at at time zone 'Europe/Paris') as hour,
               count(*) as views,
               count(distinct coalesce(p.visitor, 'ligne-' || p.id)) as visitors
        from public.page_views p
        where p.at >= v_from
        group by 1
      ) v on v.hour = h.hour
    ),
    'views', (select count(*) from public.page_views p where p.at >= v_from),
    'visitors', (select count(distinct coalesce(p.visitor, 'ligne-' || p.id)) from public.page_views p where p.at >= v_from)
  );
end;
$$;

-- Droits : Supabase accorde par défaut tout aux rôles API sur les nouveaux objets, on resserre.
revoke all on public.page_views from anon, authenticated;
grant all on public.page_views to service_role;
revoke execute on function public.track_page_view(text, text), public.admin_page_views_hourly(integer)
  from public, anon, authenticated;
grant execute on function public.track_page_view(text, text) to anon, authenticated, service_role;
grant execute on function public.admin_page_views_hourly(integer) to authenticated, service_role;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261008190000_page_views.sql', '333b5df5447d709f');
    v_applied := v_applied + 1;
  end if;

  -- ═════ 20261008200000_notifications.sql ═════
  if not exists (select 1 from castor_meta.migrations where filename = '20261008200000_notifications.sql') then
    execute $castor_mig$
-- Castor Tracker — notifications (Web Push pour tous, webhook en plus pour les administrateurs).
--
-- Chaque événement est écrit une fois dans notification_events (clé de déduplication), puis
-- distribué aux comptes qui l'ont activé (notification_deliveries, un envoi par compte et par canal).
-- Préférences par compte : interrupteur général (notification_settings.enabled) et un interrupteur
-- par type (notification_prefs), avec les valeurs par défaut du catalogue (notification_types).
-- Les envois partent de l'Edge Function castor-jobs (tâche « notify ») : à la fin de chaque tâche,
-- sur appel pg_net quand un événement naît en base, et toutes les 15 min (heures calmes, relances).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.notification_types (
  code text primary key,
  -- all : tous les comptes ayant accès ; admin : administrateurs seulement
  audience text not null check (audience in ('all', 'admin')),
  label text not null,
  description text not null,
  default_enabled boolean not null default true,
  -- urgent : envoyé même pendant les heures calmes
  urgent boolean not null default false,
  sort integer not null default 0
);
comment on table public.notification_types is 'Catalogue des notifications (libellés, public, valeur par défaut).';

insert into public.notification_types (code, audience, label, description, default_enabled, urgent, sort) values
  ('estimate_move', 'all', 'Variation de l’estimation',
   'Après la séance du soir, quand l’estimation du prochain prix a bougé d’au moins le seuil choisi depuis la dernière alerte.',
   true, false, 10),
  ('estimate_phase', 'all', 'Fenêtre de calcul',
   'Début de la fenêtre des 20 séances, puis prix figé quand toutes les séances sont connues.',
   true, false, 20),
  ('board_date', 'all', 'Date du CA connue',
   'La date du conseil d’administration qui fixe le prix est publiée : l’intervalle se resserre.',
   true, false, 30),
  ('payment_deadline', 'all', 'Clôture des versements',
   'Rappel trois jours avant la fermeture des versements, puis le dernier jour, avec l’estimation du moment.',
   true, false, 40),
  ('official_price', 'all', 'Prix officiel annoncé',
   'Prix de souscription publié par VINCI, écart avec l’estimation finale et plus-value au cours actuel.',
   true, false, 50),
  ('price_alert', 'all', 'Alerte de cours',
   'Le cours VINCI franchit un seuil que vous fixez (au-dessus ou en dessous).',
   false, false, 60),
  ('weekly_digest', 'all', 'Résumé hebdomadaire',
   'Le lundi matin : estimation, intervalle, date du CA et cours.',
   false, false, 70),
  ('job_failure', 'admin', 'Tâche en échec',
   'Une tâche planifiée a échoué deux fois de suite.',
   true, true, 110),
  ('job_missed', 'admin', 'Séance non collectée',
   'La tâche du soir n’a pas abouti pour la dernière séance (constaté au rattrapage du matin).',
   true, true, 120),
  ('data_anomaly', 'admin', 'Anomalie de données',
   'Écart entre Yahoo et Euronext, repli sur Euronext, séances manquantes, ouverture aberrante.',
   true, false, 130),
  ('data_entry', 'admin', 'Saisie à faire',
   'Date du CA toujours inconnue à l’approche du créneau, prix officiel non saisi après le CA.',
   true, false, 140),
  ('price_mismatch', 'admin', 'Écart au centime',
   'Le prix officiel saisi diffère du prix recalculé alors que les 20 séances sont connues.',
   true, false, 150),
  ('inference', 'admin', 'Inférence ambiguë',
   'L’inférence d’une date de CA trouve plusieurs dates possibles.',
   true, false, 160),
  ('security', 'admin', 'Sécurité et accès',
   'Rôle accordé, modifié ou retiré, secret des tâches planifiées renouvelé.',
   true, true, 170);

-- Réglages généraux de chaque compte.
create table public.notification_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- interrupteur général : coupe toutes les notifications du compte
  enabled boolean not null default true,
  -- heures calmes (21 h – 8 h, heure de Paris) : envoi différé à 8 h, sauf urgences admin
  quiet_hours boolean not null default true,
  -- webhook : administrateurs seulement
  webhook_enabled boolean not null default false,
  webhook_url text check (webhook_url is null or (webhook_url ~ '^https?://' and length(webhook_url) <= 2048)),
  webhook_format text not null default 'json' check (webhook_format in ('json', 'ntfy', 'discord', 'slack')),
  -- valeur facultative de l'en-tête Authorization (ex. « Bearer … » pour ntfy)
  webhook_secret text check (webhook_secret is null or length(webhook_secret) <= 1024),
  updated_at timestamptz not null default now()
);
comment on table public.notification_settings is 'Notifications : interrupteur général, heures calmes, webhook (admins).';

-- Interrupteur et réglages par type ; sans ligne, la valeur par défaut du catalogue s'applique.
create table public.notification_prefs (
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null references public.notification_types (code) on delete cascade,
  enabled boolean not null,
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);
comment on table public.notification_prefs is 'Notifications : choix de chaque compte, type par type (seuils dans params).';

-- Mémoire des alertes personnelles (dernière estimation notifiée, seuil de cours franchi) : fonctions seulement.
create table public.notification_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null references public.notification_types (code) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

-- Abonnements Web Push (un par navigateur ou appareil).
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error text,
  failures integer not null default 0
);
create index push_subscriptions_user on public.push_subscriptions (user_id);
comment on table public.push_subscriptions is 'Abonnements Web Push ; supprimés quand le service push les déclare expirés.';

create table public.notification_events (
  id bigint generated always as identity primary key,
  type text not null references public.notification_types (code),
  -- alerte personnelle (seuil propre à un compte) ; null : tous les abonnés du type
  target_user uuid references auth.users (id) on delete cascade,
  dedup_key text unique,
  title text not null,
  body text not null,
  -- chemin dans la PWA ouvert au clic
  url text,
  urgent boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  fanned_out_at timestamptz
);
create index notification_events_time on public.notification_events (created_at desc);
create index notification_events_pending on public.notification_events (id) where fanned_out_at is null;
comment on table public.notification_events is 'Événements notifiables, une ligne par événement (déduplication par clé).';

create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.notification_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  channel text not null check (channel in ('push', 'webhook')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  not_before timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  sent_at timestamptz,
  error text,
  unique (event_id, user_id, channel)
);
create index notification_deliveries_due on public.notification_deliveries (not_before) where status in ('pending', 'sending');
create index notification_deliveries_user on public.notification_deliveries (user_id, event_id desc);
comment on table public.notification_deliveries is 'Envois : un par événement, compte et canal (push, webhook).';

-- Réglages réservés aux administrateurs (contiennent des URL à jeton).
create table public.admin_config (
  id boolean primary key default true check (id),
  -- URL « push » d'un moniteur externe (Uptime Kuma, healthchecks.io) appelée à chaque passage planifié
  heartbeat_url text check (heartbeat_url is null or (heartbeat_url ~ '^https?://' and length(heartbeat_url) <= 2048)),
  updated_at timestamptz not null default now()
);
insert into public.admin_config (id) values (true) on conflict (id) do nothing;
comment on table public.admin_config is 'Réglages lisibles par les administrateurs seuls (moniteur externe).';

-- Clé publique VAPID : lue par la PWA pour s'abonner (la clé privée est dans Vault).
alter table public.app_config add column vapid_public_key text;

create trigger notification_settings_updated_at before update on public.notification_settings
  for each row execute function public.set_updated_at();
create trigger notification_prefs_updated_at before update on public.notification_prefs
  for each row execute function public.set_updated_at();
create trigger admin_config_updated_at before update on public.admin_config
  for each row execute function public.set_updated_at();
create trigger audit_admin_config after insert or update or delete on public.admin_config
  for each row execute function public.audit_trigger('id');

-- Le webhook est réservé aux administrateurs (session TOTP) ; les fonctions (sans JWT) passent.
create function public.notification_settings_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if (tg_op = 'INSERT' and (new.webhook_url is not null or new.webhook_enabled))
     or (tg_op = 'UPDATE' and (new.webhook_url, new.webhook_format, new.webhook_secret, new.webhook_enabled)
                              is distinct from (old.webhook_url, old.webhook_format, old.webhook_secret, old.webhook_enabled)) then
    if not public.is_admin() then
      raise exception 'webhook réservé aux administrateurs (session validée par TOTP)' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger notification_settings_guard before insert or update on public.notification_settings
  for each row execute function public.notification_settings_guard();

-- ---------------------------------------------------------------------------
-- Production des événements
-- ---------------------------------------------------------------------------

create function public.fr_euro(p numeric) returns text
language sql immutable set search_path = ''
as $$ select replace(to_char(round(p, 2), 'FM999999990.00'), '.', ',') || ' €' $$;

create function public.fr_signed(p numeric, p_digits integer default 2) returns text
language sql immutable set search_path = ''
as $$
  select replace(to_char(round(p, p_digits), case when p_digits = 1 then 'FMS999990.0' else 'FMS999990.00' end), '.', ',')
$$;

-- Réveille castor-jobs (tâche notify) via pg_net, une fois par transaction. Sans pg_net ni
-- secrets Vault (tests, instance pas encore configurée), ne fait rien : le passage planifié enverra.
create function public.notification_kick() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('castor.notify_kicked', true), '') = 'on' then
    return;
  end if;
  perform set_config('castor.notify_kicked', 'on', true);
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return;
  end if;
  perform public.castor_call('notify');
exception when others then
  raise notice 'notification_kick : %', sqlerrm;
end;
$$;

-- Crée un événement (ignoré si la clé de déduplication existe déjà) ; renvoie son identifiant.
create function public.notification_emit(
  p_type text,
  p_title text,
  p_body text,
  p_url text default null,
  p_dedup text default null,
  p_data jsonb default '{}'::jsonb,
  p_target uuid default null,
  p_kick boolean default true
)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.notification_events (type, target_user, dedup_key, title, body, url, urgent, data)
  select p_type, p_target, p_dedup, left(p_title, 200), left(p_body, 1000), p_url, t.urgent, coalesce(p_data, '{}'::jsonb)
  from public.notification_types t
  where t.code = p_type
  on conflict (dedup_key) do nothing
  returning id into v_id;
  if v_id is not null and p_kick then
    perform public.notification_kick();
  end if;
  return v_id;
end;
$$;

-- Date du CA connue, prix officiel, écart au centime (quadrimestres en cours ou à venir seulement :
-- l'import de l'historique ne notifie personne).
create function public.quadrimesters_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_final numeric;
  v_quote numeric;
  v_body text;
begin
  if new.end_date < public.paris_today() then
    return null;
  end if;
  if new.board_status = 'known' and new.board_date is not null and new.official_price is null
     and (tg_op = 'INSERT' or old.board_date is distinct from new.board_date or old.board_status is distinct from 'known') then
    perform public.notification_emit(
      'board_date',
      format('Date du CA connue pour %s', new.code),
      format('Le conseil d''administration qui fixe le prix se réunit le %s : l''estimation se resserre.',
             to_char(new.board_date, 'DD/MM/YYYY')),
      '/',
      format('board:%s:%s', new.code, new.board_date));
  end if;
  if new.official_price is not null and (tg_op = 'INSERT' or old.official_price is null) then
    select e.central into v_final from public.estimates e where e.id = new.final_estimate_id;
    select q.price into v_quote from public.quote_live q limit 1;
    v_body := format('Prix de souscription %s : %s.', new.code, public.fr_euro(new.official_price));
    if v_final is not null then
      v_body := v_body || format(' Estimation finale : %s (écart %s €).', public.fr_euro(v_final),
                                 public.fr_signed(v_final - new.official_price));
    end if;
    if v_quote is not null then
      v_body := v_body || format(' Au cours actuel (%s) : %s %%.', public.fr_euro(v_quote),
                                 public.fr_signed((v_quote / new.official_price - 1) * 100, 1));
    end if;
    perform public.notification_emit(
      'official_price',
      format('Prix Castor %s : %s', new.code, public.fr_euro(new.official_price)),
      v_body,
      '/historique',
      format('official:%s', new.code));
    if new.computed_price is not null and coalesce(new.computed_missing, 0) = 0
       and new.board_status = 'known' and new.computed_price <> new.official_price then
      perform public.notification_emit(
        'price_mismatch',
        format('Écart au centime sur %s', new.code),
        format('Prix officiel %s, prix recalculé %s avec les 20 séances connues : règle Castor modifiée ou cours erroné ?',
               public.fr_euro(new.official_price), public.fr_euro(new.computed_price)),
        format('/admin/quadrimestres/%s', replace(new.code, '/', '-')),
        format('mismatch:%s', new.code));
    end if;
  end if;
  return null;
end;
$$;
create trigger quadrimesters_notify after insert or update on public.quadrimesters
  for each row execute function public.quadrimesters_notify();

-- Rôles accordés, modifiés, retirés.
create function public.user_roles_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_email text;
  v_title text;
begin
  select u.email into v_email from auth.users u where u.id = v_user;
  v_email := coalesce(v_email, 'compte supprimé');
  if tg_op = 'INSERT' then
    v_title := case new.role when 'admin' then format('Nouvel administrateur : %s', v_email)
                             else format('Nouveau lecteur : %s', v_email) end;
  elsif tg_op = 'UPDATE' then
    if new.role is not distinct from old.role then
      return null;
    end if;
    v_title := format('Rôle modifié : %s devient %s', v_email,
                      case new.role when 'admin' then 'administrateur' else 'lecteur' end);
  else
    v_title := format('Accès retiré : %s', v_email);
  end if;
  perform public.notification_emit(
    'security', v_title,
    'Modification des accès à Castor Tracker. Si vous n’en êtes pas l’auteur, vérifiez la page Accès.',
    '/admin/acces',
    format('role:%s:%s:%s', v_user, lower(tg_op), extract(epoch from clock_timestamp())::bigint));
  return null;
end;
$$;
create trigger user_roles_notify after insert or update or delete on public.user_roles
  for each row execute function public.user_roles_notify();

-- Deux échecs consécutifs d'une même tâche.
create function public.job_runs_notify() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_prev text;
  v_label text;
begin
  if new.status <> 'error' or old.status = 'error' then
    return null;
  end if;
  select j.status into v_prev from public.job_runs j
  where j.job = new.job and j.id <> new.id and j.status in ('success', 'error')
  order by j.started_at desc limit 1;
  if v_prev is distinct from 'error' then
    return null;
  end if;
  v_label := case new.job
    when 'open' then 'ouverture du jour'
    when 'session' then 'séance du soir'
    when 'catchup' then 'rattrapage du matin'
    when 'maintenance' then 'maintenance mensuelle'
    when 'history' then 'reprise de l’historique'
    else new.job end;
  perform public.notification_emit(
    'job_failure',
    format('Échec répété : %s', v_label),
    format('Deux échecs de suite. Dernière erreur : %s', coalesce(new.message, 'inconnue')),
    '/admin/journal',
    format('fail:%s:%s', new.job, public.paris_today()));
  return null;
end;
$$;
create trigger job_runs_notify after update of status on public.job_runs
  for each row execute function public.job_runs_notify();

-- ---------------------------------------------------------------------------
-- Distribution
-- ---------------------------------------------------------------------------

-- Comptes qui reçoivent un type : rôle compatible, accès au site, interrupteur général et du type actifs.
create function public.notification_recipients(p_type text, p_target uuid default null)
returns table (user_id uuid, role text, params jsonb, quiet_hours boolean)
language sql stable security definer set search_path = ''
as $$
  select r.user_id, r.role, coalesce(p.params, '{}'::jsonb), coalesce(s.quiet_hours, true)
  from public.notification_types t
  join public.user_roles r on t.audience = 'all' or r.role = 'admin'
  left join public.notification_settings s on s.user_id = r.user_id
  left join public.notification_prefs p on p.user_id = r.user_id and p.type = t.code
  where t.code = p_type
    and (p_target is null or r.user_id = p_target)
    and coalesce(s.enabled, true)
    and coalesce(p.enabled, t.default_enabled)
    and (r.role = 'admin' or coalesce((select c.visibility from public.app_config c where c.id), 'restricted') <> 'private');
$$;

-- Heures calmes : 21 h – 8 h (heure de Paris), envoi reporté à 8 h.
create function public.notification_not_before(p_quiet boolean, p_urgent boolean, p_at timestamptz default now())
returns timestamptz
language sql stable set search_path = ''
as $$
  select case
    when p_urgent or not p_quiet then p_at
    when (p_at at time zone 'Europe/Paris')::time >= time '21:00'
      then (((p_at at time zone 'Europe/Paris')::date + 1) + time '08:00') at time zone 'Europe/Paris'
    when (p_at at time zone 'Europe/Paris')::time < time '08:00'
      then ((p_at at time zone 'Europe/Paris')::date + time '08:00') at time zone 'Europe/Paris'
    else p_at
  end;
$$;

-- Répartit les nouveaux événements en envois (push si le compte a un abonnement, webhook pour les admins).
create function public.notification_fanout()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  e record;
  v_n integer := 0;
  v_rows integer;
begin
  for e in
    select * from public.notification_events where fanned_out_at is null order by id for update skip locked
  loop
    insert into public.notification_deliveries (event_id, user_id, channel, not_before)
    select e.id, x.user_id, ch.channel, public.notification_not_before(x.quiet_hours, e.urgent, now())
    from public.notification_recipients(e.type, e.target_user) x
    cross join lateral (
      select 'push'::text as channel
      where exists (select 1 from public.push_subscriptions ps where ps.user_id = x.user_id)
      union all
      select 'webhook'::text
      where x.role = 'admin' and exists (
        select 1 from public.notification_settings s
        where s.user_id = x.user_id and s.webhook_enabled and s.webhook_url is not null)
    ) ch
    on conflict (event_id, user_id, channel) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
    update public.notification_events set fanned_out_at = now() where id = e.id;
  end loop;
  return v_n;
end;
$$;

-- Réserve les envois dus (verrou partagé entre passages concurrents) et les renvoie avec leur contenu.
create function public.notification_claim(p_limit integer default 100)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  update public.notification_deliveries d set status = 'skipped', error = 'périmée (plus de 36 h)'
  from public.notification_events e
  where e.id = d.event_id and d.status = 'pending' and e.created_at < now() - interval '36 hours';
  with c as (
    select d.id from public.notification_deliveries d
    where (d.status = 'pending' and d.not_before <= now())
       or (d.status = 'sending' and d.claimed_at < now() - interval '10 minutes')
    order by d.id
    limit greatest(1, least(p_limit, 500))
    for update skip locked
  ), u as (
    update public.notification_deliveries d
    set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
    from c where d.id = c.id
    returning d.id, d.event_id, d.user_id, d.channel, d.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'channel', u.channel, 'user_id', u.user_id, 'attempts', u.attempts,
    'event', jsonb_build_object('id', e.id, 'type', e.type, 'title', e.title, 'body', e.body, 'url', e.url,
                                'urgent', e.urgent, 'data', e.data, 'created_at', e.created_at)
  ) order by u.id), '[]'::jsonb) into v
  from u join public.notification_events e on e.id = u.event_id;
  return v;
end;
$$;

-- Travail en attente (porte de la tâche planifiée « notify »).
create function public.notification_due()
returns integer
language sql stable security definer set search_path = ''
as $$
  select (select count(*) from public.notification_events where fanned_out_at is null)::integer
       + (select count(*) from public.notification_deliveries
          where (status = 'pending' and not_before <= now())
             or (status = 'sending' and claimed_at < now() - interval '10 minutes'))::integer;
$$;

-- Clés VAPID : la privée dans Vault, la publique dans app_config. La première écriture gagne.
create function public.castor_push_keys()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  return jsonb_build_object(
    'public', (select c.vapid_public_key from public.app_config c where c.id),
    'private', public.castor_secret('castor_vapid_private'));
end;
$$;

create function public.castor_push_keys_init(p_public text, p_private text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('castor_vapid'));
  if public.castor_secret('castor_vapid_private') is null
     or (select c.vapid_public_key from public.app_config c where c.id) is null then
    perform public.castor_set_secret('castor_vapid_private', p_private);
    update public.app_config set vapid_public_key = p_public where id;
  end if;
  return public.castor_push_keys();
end;
$$;

-- Abonnement Web Push du navigateur courant (rattaché au compte connecté, même s'il l'était à un autre).
create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id bigint;
begin
  if v_user is null or not public.has_role() then
    raise exception 'compte sans accès à Castor Tracker' using errcode = '42501';
  end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 2048 then
    raise exception 'adresse d''abonnement invalide';
  end if;
  if p_p256dh !~ '^[A-Za-z0-9_-]{80,100}={0,2}$' or p_auth !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then
    raise exception 'clés d''abonnement invalides';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_user, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update set
    user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, failures = 0, last_error = null
  returning id into v_id;
  -- 10 appareils au plus par compte : les plus anciens partent
  delete from public.push_subscriptions
  where user_id = v_user and id in (
    select id from public.push_subscriptions where user_id = v_user order by created_at desc offset 10);
  return v_id;
end;
$$;

create function public.push_unsubscribe(p_endpoint text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vues
-- ---------------------------------------------------------------------------

create view public.v_my_notifications with (security_invoker = true) as
select
  e.id,
  e.type,
  e.title,
  e.body,
  e.url,
  e.created_at,
  bool_or(d.status = 'sent') as delivered,
  max(d.sent_at) as sent_at,
  bool_or(d.status in ('pending', 'sending')) as pending
from public.notification_events e
join public.notification_deliveries d on d.event_id = e.id
where d.user_id = auth.uid()
group by e.id;
comment on view public.v_my_notifications is 'Notifications envoyées (ou en attente) au compte connecté.';

create view public.v_notification_log with (security_invoker = true) as
select
  e.id,
  e.type,
  e.title,
  e.body,
  e.url,
  e.urgent,
  e.target_user is not null as personal,
  e.created_at,
  e.fanned_out_at,
  count(d.id) filter (where d.status = 'sent') as sent,
  count(d.id) filter (where d.status in ('pending', 'sending')) as pending,
  count(d.id) filter (where d.status = 'failed') as failed,
  count(d.id) filter (where d.status = 'skipped') as skipped,
  max(d.error) filter (where d.status in ('failed', 'pending')) as last_error
from public.notification_events e
left join public.notification_deliveries d on d.event_id = e.id
group by e.id;
comment on view public.v_notification_log is 'Journal des notifications (administrateurs).';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.notification_types enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.notification_state enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_events enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.admin_config enable row level security;

create policy notification_types_read on public.notification_types for select to authenticated using (true);

create policy notification_settings_own_read on public.notification_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_settings_own_insert on public.notification_settings for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.has_role()));
create policy notification_settings_own_update on public.notification_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy notification_prefs_own_read on public.notification_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy notification_prefs_own_insert on public.notification_prefs for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.has_role()));
create policy notification_prefs_own_update on public.notification_prefs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notification_prefs_own_delete on public.notification_prefs for delete to authenticated
  using (user_id = (select auth.uid()));

create policy push_subscriptions_own_read on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy push_subscriptions_own_delete on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy notification_events_read on public.notification_events for select to authenticated
  using ((select public.is_admin()) or exists (
    select 1 from public.notification_deliveries d
    where d.event_id = notification_events.id and d.user_id = (select auth.uid())));
create policy notification_deliveries_read on public.notification_deliveries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy admin_config_admin_read on public.admin_config for select to authenticated
  using ((select public.is_admin()));
create policy admin_config_admin_update on public.admin_config for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on public.notification_types, public.notification_settings, public.notification_prefs,
  public.notification_state, public.push_subscriptions, public.notification_events,
  public.notification_deliveries, public.admin_config, public.v_my_notifications, public.v_notification_log
  from anon, authenticated;
grant select on public.notification_types, public.notification_events, public.notification_deliveries,
  public.push_subscriptions, public.notification_settings, public.notification_prefs, public.admin_config,
  public.v_my_notifications, public.v_notification_log
  to authenticated;
-- upsert PostgREST : la mise à jour réécrit aussi la clé (la RLS l'impose égale au compte connecté)
grant insert (user_id, enabled, quiet_hours, webhook_enabled, webhook_url, webhook_format, webhook_secret),
  update (user_id, enabled, quiet_hours, webhook_enabled, webhook_url, webhook_format, webhook_secret)
  on public.notification_settings to authenticated;
grant insert (user_id, type, enabled, params), update (user_id, type, enabled, params), delete
  on public.notification_prefs to authenticated;
grant delete on public.push_subscriptions to authenticated;
grant update (heartbeat_url) on public.admin_config to authenticated;
grant all on public.notification_types, public.notification_settings, public.notification_prefs,
  public.notification_state, public.push_subscriptions, public.notification_events,
  public.notification_deliveries, public.admin_config, public.v_my_notifications, public.v_notification_log
  to service_role;

revoke execute on function public.fr_euro(numeric), public.fr_signed(numeric, integer), public.notification_kick(),
  public.notification_emit(text, text, text, text, text, jsonb, uuid, boolean), public.quadrimesters_notify(),
  public.user_roles_notify(), public.job_runs_notify(), public.notification_recipients(text, uuid),
  public.notification_not_before(boolean, boolean, timestamptz), public.notification_fanout(),
  public.notification_claim(integer), public.notification_due(), public.castor_push_keys(),
  public.castor_push_keys_init(text, text), public.push_subscribe(text, text, text, text),
  public.push_unsubscribe(text), public.notification_settings_guard()
  from public, anon, authenticated;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) to authenticated;
grant execute on function public.notification_emit(text, text, text, text, text, jsonb, uuid, boolean),
  public.notification_recipients(text, uuid), public.notification_fanout(), public.notification_claim(integer),
  public.notification_due(), public.castor_push_keys(), public.castor_push_keys_init(text, text),
  public.fr_euro(numeric), public.fr_signed(numeric, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Planification : ajoute l'envoi des notifications (toutes les 15 min) aux tâches existantes.
-- Prise en compte au prochain lancement de scripts/configure-supabase.sh.
-- ---------------------------------------------------------------------------

create or replace function public.castor_setup_cron()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  j record;
  v_n integer := 0;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return 'pg_cron absent : aucune tâche planifiée';
  end if;
  for j in
    select * from (values
      -- ouverture du jour : 9 h 20, relance 9 h 40 (Paris)
      ('castor-open', '20,40 7,8 * * 1-5', 'open'),
      -- cours en séance : toutes les 15 min, 9 h – 17 h 45 (Paris)
      ('castor-quote', '*/15 7-16 * * 1-5', 'quote'),
      -- séance complète et estimation : 18 h, relance 18 h 30 (Paris)
      ('castor-session', '0,30 16,17 * * 1-5', 'session'),
      -- dernière relance : 21 h (Paris)
      ('castor-session-late', '0 19,20 * * 1-5', 'session'),
      -- rattrapage des 30 derniers jours : 7 h 30 (Paris), tous les jours
      ('castor-catchup', '30 5,6 * * *', 'catchup'),
      -- contrôles et purge : le 1er du mois
      ('castor-maintenance', '15 2 1 * *', 'maintenance'),
      -- notifications différées (heures calmes) et relances ; battement du moniteur externe
      ('castor-notify', '*/15 * * * *', 'notify')
    ) as t(name, schedule, task)
  loop
    execute 'select cron.schedule($1, $2, $3)'
      using j.name, j.schedule, format('select public.castor_call(%L)', j.task);
    v_n := v_n + 1;
  end loop;
  return format('%s tâches planifiées', v_n);
end;
$$;
revoke execute on function public.castor_setup_cron() from public, anon, authenticated, service_role;

-- Installation déjà planifiée (configure-supabase.sh ou enregistrement automatique sur Supabase Cloud) :
-- ajoute tout de suite la tâche castor-notify.
do $$
declare
  v_has_jobs boolean;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'select exists (select 1 from cron.job where jobname like ''castor-%'')' into v_has_jobs;
    if v_has_jobs then
      perform public.castor_setup_cron();
    end if;
  end if;
end;
$$;
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('20261008200000_notifications.sql', 'b3b4ba3833fa4032');
    v_applied := v_applied + 1;
  end if;

  -- ═════ Configuration ═════
  -- Secret des tâches planifiées : aléatoire, conservé dans Vault, jamais affiché.
  if public.castor_secret('castor_cron_secret') is null then
    perform public.castor_set_secret('castor_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  end if;
  perform public.castor_setup_cron();
  -- Administrateur : le seul compte du projet, si aucun administrateur n'existe encore.
  if not exists (select 1 from public.user_roles where role = 'admin') and (select count(*) from auth.users) = 1 then
    insert into public.user_roles (user_id, role) select id, 'admin' from auth.users
    on conflict (user_id) do update set role = 'admin';
  end if;
  raise warning 'Castor Tracker : % migration(s) appliquée(s)', v_applied;
end
$castor$;

notify pgrst, 'reload schema';

select
  (select count(*) from castor_meta.migrations) as migrations,
  coalesce(
    (select string_agg(u.email, ', ') from public.user_roles r join auth.users u on u.id = r.user_id where r.role = 'admin'),
    'aucun : créer le compte (Authentication › Users › Add user) puis relancer'
  ) as administrateur,
  (select string_agg(extname, ', ' order by extname) from pg_extension where extname in ('pg_cron', 'pg_net')) as extensions;

-- Si le projet compte plusieurs comptes : mettre l'e-mail de l'administrateur, puis exécuter cette ligne seule.
-- insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where lower(email) = lower('moi@exemple.fr') on conflict (user_id) do update set role = 'admin';
