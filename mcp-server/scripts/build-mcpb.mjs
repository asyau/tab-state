// Builds the one-click Claude Desktop installer: dist/tab-state-mcp-<version>.mcpb
//
//   npm run build:mcpb
//
// Stages only what the bundle needs (manifest, server code, an icon, and production
// dependencies — no tests, no devDependencies, no repo docs) into a throwaway directory, then
// shells out to the `mcpb` CLI to validate and pack it. Needs `npm install -g @anthropic-ai/mcpb`
// once; see https://github.com/modelcontextprotocol/mcpb.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(MCP_DIR, '..');
const fail = (msg) => { console.error(`build-mcpb: ${msg}`); process.exit(1); };

try {
  execFileSync('mcpb', ['--version'], { stdio: 'ignore' });
} catch {
  fail('the `mcpb` CLI was not found. Install it once with: npm install -g @anthropic-ai/mcpb');
}

const manifest = JSON.parse(readFileSync(path.join(MCP_DIR, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(MCP_DIR, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  fail(`manifest.json version ${manifest.version} != package.json version ${pkg.version}; keep them in sync`);
}

const stage = path.join(MCP_DIR, 'build', 'mcpb-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Runtime files only.
copyFileSync(path.join(MCP_DIR, 'manifest.json'), path.join(stage, 'manifest.json'));
copyFileSync(path.join(MCP_DIR, 'server.mjs'), path.join(stage, 'server.mjs'));
copyFileSync(path.join(MCP_DIR, 'store.mjs'), path.join(stage, 'store.mjs'));
copyFileSync(path.join(REPO_ROOT, 'icons', 'icon128.png'), path.join(stage, 'icon.png'));

// A trimmed package.json: dependencies only, so `npm install --omit=dev` below doesn't pull in
// wrangler/test tooling. The bundled server.mjs doesn't need "scripts" or "bin" to run.
writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  dependencies: pkg.dependencies,
}, null, 2));

console.log('build-mcpb: installing production dependencies into the stage...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });

console.log('build-mcpb: validating manifest...');
execFileSync('mcpb', ['validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });

const dist = path.join(MCP_DIR, 'dist');
mkdirSync(dist, { recursive: true });
const out = path.join(dist, `tab-state-mcp-${manifest.version}.mcpb`);
rmSync(out, { force: true });

console.log('build-mcpb: packing...');
execFileSync('mcpb', ['pack', stage, out], { stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
console.log(`build-mcpb: ${path.relative(MCP_DIR, out)}`);
