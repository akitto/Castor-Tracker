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
    drop view if exists public.v_dashboard, public.v_history, public.v_estimate_history, public.v_job_status cascade;
    drop table if exists public.app_config, public.user_roles, public.stock_prices, public.quote_live, public.market_holidays, public.dividends, public.quadrimesters, public.calc_params, public.estimates, public.backtests, public.job_runs, public.audit_log cascade;
    drop function if exists public.paris_today, public.has_role, public.is_admin, public.is_public_site, public.can_read, public.my_access, public.set_updated_at, public.audit_trigger, public.price_series, public.upsert_prices, public.admin_import_prices, public.activate_calc_params, public.admin_set_official_price, public.castor_verify_cron_secret, public.castor_set_secret, public.castor_secret, public.castor_call, public.castor_setup_cron, public.castor_unschedule_cron, public.castor_register_endpoint cascade;
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
