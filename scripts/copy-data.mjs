// Copy product-data JSON (src/data/*.json) into the build output.
// tsc never emits non-.ts assets, so the runtime require('../data/*.json')
// from dist/ would fail on Railway without this. Runs as `npm run build`
// postbuild step. Cross-platform via fs.cpSync (Node >=20).

import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src/data');
const dest = resolve(root, 'dist/data');

if (!existsSync(src)) {
  console.error(`copy-data: source not found: ${src}`);
  process.exit(1);
}

cpSync(src, dest, {
  recursive: true,
  // Ship only the product-data JSON, not co-located test files.
  filter: (s) => !s.includes('__tests__'),
});
console.log(`copy-data: copied ${src} -> ${dest}`);
