// Prépare l'installation de Castor Tracker sur Supabase Cloud par le seul tableau de bord (sans CLI ni secret) :
//   deploy/supabase-cloud.sql : toutes les migrations + la configuration, à coller dans l'éditeur SQL ;
//   deploy/castor-jobs.js     : la fonction castor-jobs en un seul fichier, à coller dans l'éditeur des Edge Functions.
// Usage : node scripts/build-cloud-bundle.mjs (Deno 2.4+ requis : variable DENO ou commande deno).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'deploy');
mkdirSync(out, { recursive: true });

// 1. Fonction en un seul fichier (le moteur packages/core y est inclus, supabase-js reste importé par npm:).
execFileSync(process.execPath, [join(root, 'scripts/sync-core.mjs')], { stdio: 'ignore' });
const bundlePath = join(out, 'castor-jobs.js');
// Deno ajoute parfois « workspaces » au package.json racine (espace de travail pnpm détecté) : on le restaure.
const rootPackage = readFileSync(join(root, 'package.json'), 'utf8');
execFileSync(
  process.env.DENO || 'deno',
  [
    'bundle', '--platform', 'deno', '--packages', 'external', '--external', 'npm:*', '--no-lock',
    '--config', join(root, 'supabase/functions/deno.json'),
    '-o', bundlePath, join(root, 'supabase/functions/castor-jobs/index.ts'),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
if (readFileSync(join(root, 'package.json'), 'utf8') !== rootPackage) writeFileSync(join(root, 'package.json'), rootPackage);
const bundle = readFileSync(bundlePath, 'utf8');
writeFileSync(
  bundlePath,
  `// Castor Tracker — fonction castor-jobs en un seul fichier, pour Supabase Cloud.
// Tableau de bord Supabase › Edge Functions › Deploy a new function › Via Editor :
//   nom de la fonction : castor-jobs ; remplacer tout le contenu de index.ts par ce fichier ; Deploy function.
// Puis, dans les réglages de la fonction, désactiver la vérification JWT (« Verify JWT ») :
// la fonction contrôle elle-même ses appels (secret des tâches planifiées, session admin + TOTP).
// Fichier généré par scripts/build-cloud-bundle.mjs à partir de supabase/functions/castor-jobs : ne pas modifier.
${bundle}`,
);

// 2. Base : migrations dans l'ordre, suivies comme le fait scripts/configure-supabase.sh, puis configuration.
const migrations = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const parts = migrations.map((name) => {
  const body = readFileSync(join(root, 'supabase/migrations', name));
  const sum = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `-- ═════ ${name} ═════\n${body.toString('utf8').trimEnd()}\n\ninsert into castor_meta.migrations (filename, checksum) values ('${name}', '${sum}');\n`;
});
writeFileSync(
  join(out, 'supabase-cloud.sql'),
  `-- Castor Tracker — installation de la base sur Supabase Cloud.
-- Tableau de bord Supabase › SQL Editor › New query : coller tout ce fichier, puis Run.
-- Une seule fois, sur un projet neuf, après avoir créé le compte administrateur
-- (Authentication › Users › Add user) : s'il est le seul compte du projet, il devient administrateur.
-- Une seule transaction : tout passe ou rien ne passe.
-- Fichier généré par scripts/build-cloud-bundle.mjs à partir de supabase/migrations : ne pas modifier.

begin;

set local client_min_messages = warning;
create schema if not exists castor_meta;
revoke all on schema castor_meta from public;
create table if not exists castor_meta.migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

${parts.join('\n')}
-- ═════ Configuration ═════
-- Secret des tâches planifiées : aléatoire, conservé dans Vault, jamais affiché.
select public.castor_set_secret('castor_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
where public.castor_secret('castor_cron_secret') is null;
select public.castor_setup_cron();
-- Administrateur : le seul compte du projet.
insert into public.user_roles (user_id, role)
select id, 'admin' from auth.users where (select count(*) from auth.users) = 1
on conflict (user_id) do update set role = 'admin';

commit;

notify pgrst, 'reload schema';

select
  (select count(*) from castor_meta.migrations) as migrations,
  coalesce(
    (select string_agg(u.email, ', ') from public.user_roles r join auth.users u on u.id = r.user_id where r.role = 'admin'),
    'aucun : voir la ligne à adapter en fin de fichier'
  ) as administrateur,
  (select string_agg(extname, ', ' order by extname) from pg_extension where extname in ('pg_cron', 'pg_net')) as extensions;

-- Si le projet compte plusieurs comptes : mettre l'e-mail de l'administrateur, puis exécuter cette ligne seule.
-- insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where lower(email) = lower('moi@exemple.fr') on conflict (user_id) do update set role = 'admin';
`,
);
console.log(`deploy/castor-jobs.js (${Math.round(readFileSync(bundlePath).length / 1024)} Ko) et deploy/supabase-cloud.sql (${migrations.length} migrations) écrits`);
