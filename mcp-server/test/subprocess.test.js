// Real subprocess regression test for server.mjs's "am I the main module" check. The in-process
// tests (server.test.js) import server.mjs as a module, so they never execute this check at all —
// it only runs when node launches the file directly, the way Claude Desktop/Code actually does.
//
// This caught two real bugs live in this session, both the same shape: the check compared
// import.meta.url against process.argv[1] and silently failed to match, so main() was never
// called and the process exited 0 with zero output — indistinguishable from a successful no-op.
// First a percent-encoding mismatch (a space in the path), then a symlink-resolution mismatch
// (macOS's /tmp -> /private/tmp). Both are exactly the kind of path this file gets invoked from
// once packaged as a .mcpb, so this runs it from a real symlinked directory every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, unlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('starts correctly when invoked through a symlinked directory (e.g. macOS /tmp)', async () => {
  // Symlink the whole mcp-server directory (so node_modules resolves too), then run server.mjs
  // through that symlink — the exact condition that broke before.
  const dirLink = path.join(realpathSync(tmpdir()), `ts-mcp-dirlink-${process.pid}-${Date.now()}`);
  symlinkSync(MCP_DIR, dirLink);
  const port = 8900 + Math.floor(Math.random() * 500);

  const child = spawn('node', [path.join(dirLink, 'server.mjs')], {
    env: { ...process.env, TAB_STATE_MCP_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  try {
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(exited, null, `process should still be running, not exited (stderr: ${stderr || '<empty>'})`);
    assert.match(stderr, /sync endpoint listening/, 'the startup log line actually printed — proves main() ran');

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200, 'the HTTP endpoint it should have started is actually reachable');
  } finally {
    child.kill();
    unlinkSync(dirLink); // unlink the symlink only — never recurse through it
  }
});
