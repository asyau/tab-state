// Builds the Chrome Web Store upload: dist/tab-state-<version>.zip, containing only what the
// extension needs at runtime (no tests, docs, or node_modules).
//
//   npm run package
//
// Fails loudly if manifest.json and package.json disagree on the version, or if anything the
// package should contain is missing. Needs the `zip` command (macOS/Linux; on Windows use WSL or
// Git Bash).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`package: ${msg}`); process.exit(1); };

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  fail(`manifest.json version ${manifest.version} != package.json version ${pkg.version}; keep them in sync`);
}

const INCLUDE = ['manifest.json', 'background.js', 'content.js', 'icons', 'lib', 'ai', 'ui'];
for (const entry of INCLUDE) {
  if (!existsSync(path.join(ROOT, entry))) fail(`missing ${entry}`);
}

try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
} catch {
  fail('the `zip` command was not found (install it, or run this from WSL / Git Bash on Windows)');
}

const dist = path.join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
const out = path.join(dist, `tab-state-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-r', '-q', '-X', out, ...INCLUDE, '-x', '*.DS_Store'], { cwd: ROOT });

const kb = (statSync(out).size / 1024).toFixed(1);
const count = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
console.log(`package: ${path.relative(ROOT, out)}  (${kb} KB, ${count} files)`);
