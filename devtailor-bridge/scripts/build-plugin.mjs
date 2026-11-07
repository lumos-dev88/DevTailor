#!/usr/bin/env node
// Bundle the MCP/channel entry into a single file for the Claude Code plugin.
//   claude-plugin/server/mcp-main.cjs   (all JS deps inlined)
//   claude-plugin/server/sql-wasm.wasm  (sql.js loads it from __dirname at runtime)
// Output is gitignored; regenerate with `npm run build:plugin`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeDir = resolve(here, '..');
const outDir = resolve(bridgeDir, '../claude-plugin/server');
const require = createRequire(import.meta.url);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(bridgeDir, 'src/mcp-main.ts')],
  outfile: join(outDir, 'mcp-main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

const wasm = join(dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
copyFileSync(wasm, join(outDir, 'sql-wasm.wasm'));
console.log(`[build-plugin] wrote ${outDir}`);
