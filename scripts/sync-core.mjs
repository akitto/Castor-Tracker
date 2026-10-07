// Copie le moteur de calcul (packages/core/src) dans supabase/functions/_shared/core :
// les Edge Functions (Deno) importent le même code que la PWA.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/core/src');
const dest = join(root, 'supabase/functions/_shared/core');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
writeFileSync(
  join(dest, 'README.md'),
  'Copie générée de packages/core/src par scripts/sync-core.mjs. Ne pas modifier ici.\n',
);
console.log(`moteur copié dans ${dest}`);
