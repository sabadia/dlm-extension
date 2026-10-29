// Fails when a production dependency has a licence outside the allow-list (docs/CONVENTIONS.md).
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  'ISC',
  '0BSD',
]);

const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8' });
const byLicence = JSON.parse(out);
let bad = 0;
for (const [licence, packages] of Object.entries(byLicence)) {
  const ok = ALLOWED.has(licence);
  for (const p of packages) {
    console.log(`${ok ? 'ok  ' : 'BAD '} ${licence.padEnd(14)} ${p.name}@${p.versions.join(',')}`);
    if (!ok) bad++;
  }
}
if (bad > 0) {
  console.error(`${bad} package(s) with a licence that is not allowed`);
  process.exit(1);
}
