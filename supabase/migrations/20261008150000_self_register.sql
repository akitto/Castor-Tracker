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
