// Types for the dependency-free keep-warm.mjs runner so its one pure export can be
// unit-tested from TypeScript (src/lib/warm.test.ts) without tripping noImplicitAny.
export function pickWarmQueries(
  payload: unknown,
  n: number,
): string[];

export function clampCount(raw: unknown, max: number, def: number): number;

export function clampThreshold(raw: unknown, def: number): number;

export function summarizeWarm(
  results: ReadonlyArray<{ ok?: boolean }>,
  threshold: number,
): { ok: number; total: number; ratio: number; pass: boolean };
