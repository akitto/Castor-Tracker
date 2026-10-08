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
