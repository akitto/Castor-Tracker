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
