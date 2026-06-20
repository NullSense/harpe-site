#!/usr/bin/env node
// PostToolUse — after an Edit/Write to a TypeScript source file, run the
// fast (offline) unit tests for just that package/area, and surface failures
// back to Claude. Enforces the "fix bug → immediately run/extend its test"
// loop without paying the cost of the whole monorepo `verify`.
//
// Scope is narrow on purpose:
//   - only *.ts / *.tsx source edits trigger it
//   - it runs the `default` vitest project, which EXCLUDES *.live.test.ts,
//     so no network is hit
//   - it filters to the changed package (packages/<pkg>) or top-level area
//     (src / api), so a touch in packages/sources doesn't re-run the world
//
// Exit 2 surfaces stderr to Claude as feedback (the edit already happened).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let file = payload?.tool_input?.file_path || '';
if (!file) process.exit(0);
if (isAbsolute(file)) file = relative(projectDir, file);
file = file.replace(/\\/g, '/');

// Only TypeScript source; skip declaration files and non-source areas.
if (!/\.(ts|tsx)$/.test(file) || file.endsWith('.d.ts')) process.exit(0);
if (/(^|\/)(node_modules|dist)\//.test(file)) process.exit(0);

// Map the edited file to the narrowest vitest path filter that still has tests.
let scope = null;
const pkg = file.match(/^packages\/([^/]+)\//);
if (pkg) scope = `packages/${pkg[1]}`;
else if (/^src\//.test(file)) scope = 'src';
else if (/^api\//.test(file)) scope = 'api';
if (!scope) process.exit(0); // edit outside the tested tree → nothing to do

const run = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--project', 'default', '--silent', scope],
  { cwd: projectDir, encoding: 'utf8', timeout: 120_000 },
);

if (run.status === 0) process.exit(0); // green → stay quiet

// Surface a concise failure summary to Claude.
const out = `${run.stdout || ''}\n${run.stderr || ''}`;
const failLines = out
  .split('\n')
  .filter((l) => /(FAIL|✗|×|Error:|failed)/i.test(l))
  .slice(0, 25)
  .join('\n');
process.stderr.write(
  `Unit tests for "${scope}" failed after editing ${file}.\n` +
    `Run \`pnpm exec vitest run --project default ${scope}\` to reproduce.\n\n` +
    (failLines || out.slice(-1500)),
);
process.exit(2);
