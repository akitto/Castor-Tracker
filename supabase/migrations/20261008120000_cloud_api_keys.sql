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
