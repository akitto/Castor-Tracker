// Génère packages/core/src/database.ts (types supabase-js) à partir de l'introspection
// du schéma (supabase/tests/introspect.sql, lancée par scripts/test-db.sh avec GEN_TYPES=1).
// Usage : node scripts/gen-db-types.mjs schema.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const TS = {
  boolean: 'boolean',
  smallint: 'number',
  integer: 'number',
  bigint: 'number',
  numeric: 'number',
  real: 'number',
  'double precision': 'number',
  text: 'string',
  'character varying': 'string',
  uuid: 'string',
  date: 'string',
  'timestamp with time zone': 'string',
  'timestamp without time zone': 'string',
  jsonb: 'Json',
  json: 'Json',
  void: 'undefined',
};
const tsType = (pg) => {
  if (pg.endsWith('[]')) return `${tsType(pg.slice(0, -2))}[]`;
  const t = TS[pg];
  if (!t) throw new Error(`type Postgres non géré : ${pg}`);
  return t;
};
const ind = (n) => '  '.repeat(n);
const field = (c, optional) => `${c.name}${optional ? '?' : ''}: ${tsType(c.type)}${c.nullable ? ' | null' : ''}`;

let out = `// Fichier généré par scripts/gen-db-types.mjs à partir des migrations. Ne pas modifier.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
`;
for (const rel of schema.relations.filter((r) => r.kind === 'r')) {
  out += `${ind(3)}${rel.name}: {\n`;
  out += `${ind(4)}Row: {\n${rel.columns.map((c) => `${ind(5)}${field(c, false)};`).join('\n')}\n${ind(4)}};\n`;
  out += `${ind(4)}Insert: {\n${rel.columns.map((c) => `${ind(5)}${field(c, c.nullable || c.hasDefault)};`).join('\n')}\n${ind(4)}};\n`;
  out += `${ind(4)}Update: {\n${rel.columns.map((c) => `${ind(5)}${field(c, true)};`).join('\n')}\n${ind(4)}};\n`;
  out += `${ind(4)}Relationships: [];\n${ind(3)}};\n`;
}
out += `${ind(2)}};\n${ind(2)}Views: {\n`;
for (const rel of schema.relations.filter((r) => r.kind === 'v')) {
  out += `${ind(3)}${rel.name}: {\n`;
  out += `${ind(4)}Row: {\n${rel.columns.map((c) => `${ind(5)}${c.name}: ${tsType(c.type)} | null;`).join('\n')}\n${ind(4)}};\n`;
  out += `${ind(4)}Relationships: [];\n${ind(3)}};\n`;
}
out += `${ind(2)}};\n${ind(2)}Functions: {\n`;
for (const fn of schema.functions) {
  const n = fn.arg_types.length;
  const args = fn.arg_types.map((t, i) => {
    const name = fn.arg_names[i] ?? `arg${i}`;
    const optional = i >= n - fn.n_defaults;
    return `${name}${optional ? '?' : ''}: ${tsType(t)}`;
  });
  const ret = tsType(fn.returns) + (fn.returns_set ? '[]' : '');
  out += `${ind(3)}${fn.name}: {\n${ind(4)}Args: ${args.length ? `{ ${args.join('; ')} }` : 'Record<PropertyKey, never>'};\n${ind(4)}Returns: ${ret};\n${ind(3)}};\n`;
}
out += `${ind(2)}};\n${ind(2)}Enums: Record<string, never>;\n${ind(2)}CompositeTypes: Record<string, never>;\n${ind(1)}};\n};\n`;

const dest = join(root, 'packages/core/src/database.ts');
writeFileSync(dest, out);
console.log(`types écrits dans ${dest}`);
