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
