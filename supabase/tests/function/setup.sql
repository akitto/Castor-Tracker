-- Comptes et secret pour le test de bout en bout de castor-jobs.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@example.org'),
  ('00000000-0000-0000-0000-00000000000b', 'viewer@example.org');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'viewer');
select public.castor_set_secret('castor_cron_secret', :'cron_secret');
