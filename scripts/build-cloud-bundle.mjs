// Prépare l'installation de Castor Tracker sur Supabase Cloud par le seul tableau de bord (sans CLI ni secret) :
//   deploy/1-base-a-coller-dans-SQL-Editor.sql        : migrations + configuration, pour l'éditeur SQL ;
//   deploy/2-fonction-a-coller-dans-Edge-Functions.js  : la fonction castor-jobs en un seul fichier.
// Usage : node scripts/build-cloud-bundle.mjs (Deno 2.4+ requis : variable DENO ou commande deno).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'deploy');
const SQL_FILE = '1-base-a-coller-dans-SQL-Editor.sql';
const JS_FILE = '2-fonction-a-coller-dans-Edge-Functions.js';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Fonction en un seul fichier (le moteur packages/core y est inclus, supabase-js reste importé par npm:).
execFileSync(process.execPath, [join(root, 'scripts/sync-core.mjs')], { stdio: 'ignore' });
const bundlePath = join(out, JS_FILE);
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
  `// Castor Tracker — fonction castor-jobs, À COLLER DANS EDGE FUNCTIONS (pas dans le SQL Editor).
// Tableau de bord Supabase › Edge Functions › Deploy a new function › Via Editor :
//   nom de la fonction : castor-jobs ; remplacer tout le contenu de index.ts par ce fichier ; Deploy function.
// Puis, dans les réglages de la fonction, désactiver la vérification JWT (« Verify JWT ») :
// la fonction contrôle elle-même ses appels (secret des tâches planifiées, session admin + TOTP).
// Fichier généré par scripts/build-cloud-bundle.mjs à partir de supabase/functions/castor-jobs : ne pas modifier.
${bundle}`,
);

// 2. Base : un seul bloc DO, donc une seule transaction quel que soit l'éditeur. Chaque migration n'est appliquée
// qu'une fois (suivi castor_meta.migrations, comme scripts/configure-supabase.sh) : le fichier se relance sans risque
// et sert aussi aux mises à jour. Les restes d'une installation interrompue sont supprimés avant la première.
const migrations = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const objects = { view: new Set(), table: new Set(), function: new Set(), type: new Set() };
const patterns = {
  view: /create\s+(?:or\s+replace\s+)?view\s+public\.(\w+)/gi,
  table: /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi,
  function: /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi,
  type: /create\s+type\s+public\.(\w+)/gi,
};
const steps = migrations.map((name) => {
  const raw = readFileSync(join(root, 'supabase/migrations', name));
  const text = raw.toString('utf8');
  if (/\$castor(_mig)?\$/.test(text)) throw new Error(`${name} contient un délimiteur réservé`);
  for (const [kind, re] of Object.entries(patterns)) for (const m of text.matchAll(re)) objects[kind].add(m[1]);
  const sum = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `  -- ═════ ${name} ═════
  if not exists (select 1 from castor_meta.migrations where filename = '${name}') then
    execute $castor_mig$
${text.trimEnd()}
$castor_mig$;
    insert into castor_meta.migrations (filename, checksum) values ('${name}', '${sum}');
    v_applied := v_applied + 1;
  end if;
`;
});
const drop = (kind, names) => (names.size ? `    drop ${kind} if exists ${[...names].map((n) => `public.${n}`).join(', ')} cascade;\n` : '');
writeFileSync(
  join(out, SQL_FILE),
  `-- Castor Tracker — base, À COLLER DANS LE SQL EDITOR de Supabase (pas dans Edge Functions).
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
${drop('view', objects.view)}${drop('table', objects.table)}${drop('function', objects.function)}${drop('type', objects.type)}  end if;

${steps.join('\n')}
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
`,
);
console.log(`deploy/${JS_FILE} (${Math.round(readFileSync(bundlePath).length / 1024)} Ko) et deploy/${SQL_FILE} (${migrations.length} migrations) écrits`);
