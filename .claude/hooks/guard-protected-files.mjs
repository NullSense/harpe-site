#!/usr/bin/env node
// PreToolUse guard — refuse Edit/Write/NotebookEdit on generated or
// policy-governed files. These should never be hand-edited by an agent:
//   - pnpm-lock.yaml      governed by the minimumReleaseAge supply-chain policy
//   - harpe-art.parquet   generated data dump (multi-MB), rebuilt by ingest
//   - dist/, packages/*/dist/   build output
//   - monitor-results.json      written by the live monitor, not by hand
//
// Reads the hook payload on stdin, denies via PreToolUse permissionDecision.
import { readFileSync } from 'node:fs';

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0); // can't parse → don't block
}

const path = payload?.tool_input?.file_path || payload?.tool_input?.notebook_path || '';

const PROTECTED = [
  { re: /(^|\/)pnpm-lock\.yaml$/, why: 'governed by the minimumReleaseAge supply-chain policy — change deps via package.json + a normal `pnpm install`' },
  { re: /(^|\/)harpe-art\.parquet$/, why: 'a generated data dump — rebuild it via scripts/ingest-art-dumps, do not edit by hand' },
  { re: /(^|\/)monitor-results\.json$/, why: 'written by tests/live/monitor.mjs — run the monitor instead of editing it' },
  { re: /(^|\/)dist\//, why: 'build output — edit the source and rebuild' },
  { re: /\/packages\/[^/]+\/dist\//, why: 'package build output — edit the source and rebuild' },
];

const hit = PROTECTED.find((p) => p.re.test(path));
if (hit) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Refusing to edit ${path}: ${hit.why}.`,
      },
    }),
  );
}
process.exit(0);
