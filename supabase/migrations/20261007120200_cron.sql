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
