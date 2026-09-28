// Entry point for the bundled plugin server (plugins/tab-state/server/tab-state-mcp.mjs, built by
// scripts/build-plugin.mjs). The bundle is only ever launched directly by an MCP client, so it
// starts unconditionally — no "am I the main module" path comparison, which can misfire on some
// systems (symlinks, Windows drive-letter case) and make the process exit silently at startup.
import { main } from './server.mjs';

main().catch((err) => {
  console.error('tab-state-mcp: fatal', err);
  process.exit(1);
});
