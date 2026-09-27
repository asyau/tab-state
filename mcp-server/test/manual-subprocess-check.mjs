// One-off manual check (not part of `npm test`): spawns server.mjs as a real OS child process
// with an actually-open stdin pipe — the way a real MCP client (Claude Desktop/Code) launches
// it — sends a real MCP initialize handshake over that pipe, and hits the HTTP sync endpoint
// concurrently, to catch anything the in-process InMemoryTransport tests can't.
import { spawn } from 'node:child_process';

const port = 8799 + Math.floor(Math.random() * 500);
const child = spawn('node', ['server.mjs'], {
  env: { ...process.env, TAB_STATE_MCP_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });
child.on('exit', (code, sig) => console.log(`[child exited early] code=${code} sig=${sig}`));

await new Promise((r) => setTimeout(r, 800));
console.log('alive after 800ms:', child.exitCode === null);

const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status).catch((e) => `FAILED: ${e.message}`);
console.log('HTTP /health while stdin pipe is open:', health);

const initMsg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'manual-check', version: '0' } } };
child.stdin.write(`${JSON.stringify(initMsg)}\n`);
await new Promise((r) => setTimeout(r, 500));
console.log('MCP initialize response on stdout:', stdout.trim() ? 'received' : 'NONE');
console.log('stdout is otherwise clean (no stray logs):', stdout.split('\n').filter(Boolean).length <= 1);
console.log('stderr (expected: two startup lines):\n' + stderr.trim().split('\n').map((l) => '  ' + l).join('\n'));

child.stdin.end();
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));
console.log('exited cleanly after SIGTERM:', child.exitCode !== null);
