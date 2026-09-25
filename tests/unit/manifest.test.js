// Guards the Chrome Web Store package: catches the mistakes that only show up after upload
// (a file the manifest points at that isn't in the repo, a permission the submission doc never
// justifies, an import that resolves on the author's machine but not in the zip).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

function walk(dir, out = []) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

test('every file the manifest references exists', () => {
  const refs = [
    manifest.background?.service_worker,
    manifest.options_page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ].filter(Boolean);
  assert.ok(refs.length >= 6, 'expected the manifest to reference several files');
  for (const ref of refs) assert.ok(exists(ref), `manifest references missing file: ${ref}`);
});

test('manifest and package.json agree, and satisfy store limits', () => {
  assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions must match');
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, 'Chrome accepts 1-4 dot-separated integers');
  assert.ok(manifest.name.length <= 45, 'store name limit is 45 chars');
  assert.ok(manifest.description.length <= 132, `store description limit is 132 chars, got ${manifest.description.length}`);
  assert.equal(manifest.manifest_version, 3);
  for (const size of ['16', '32', '48', '128']) assert.ok(manifest.icons[size], `missing ${size}px icon`);
});

test('every permission is justified in the Web Store submission doc', () => {
  const doc = read('docs/chrome-web-store-submission.md');
  for (const perm of [...manifest.permissions, ...(manifest.host_permissions || [])]) {
    assert.ok(doc.includes(`\`${perm}\``), `docs/chrome-web-store-submission.md has no justification for "${perm}"`);
  }
});

test('every relative import in the shipped JS resolves', () => {
  const files = ['background.js', 'content.js', ...['lib', 'ai', 'ui'].flatMap((d) => walk(d)).filter((f) => f.endsWith('.js'))];
  const importRe = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s+['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g;
  let checked = 0;
  for (const file of files) {
    for (const m of read(file).matchAll(importRe)) {
      const target = path.join(path.dirname(file), m[1] || m[2]);
      assert.ok(exists(target), `${file} imports ${m[1] || m[2]}, which does not exist`);
      checked += 1;
    }
  }
  assert.ok(checked > 20, `expected to check many imports, only saw ${checked}`);
});

test('HTML pages only reference files that exist', () => {
  for (const page of walk('ui').filter((f) => f.endsWith('.html'))) {
    for (const m of read(page).matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (/^(https?:|data:|mailto:)/.test(m[1])) continue;
      const target = path.join(path.dirname(page), m[1]);
      assert.ok(exists(target), `${page} references missing ${m[1]}`);
    }
  }
});

test('the shipped package contains no test or doc files', () => {
  // scripts/package.mjs only zips these; guard the list so a stray file can't be added by accident.
  const src = read('scripts/package.mjs');
  const list = src.match(/const INCLUDE = \[(.*?)\];/s)[1];
  for (const banned of ['tests', 'docs', 'node_modules', 'scripts', 'dist']) {
    assert.ok(!list.includes(`'${banned}'`), `package INCLUDE must not contain ${banned}`);
  }
});
