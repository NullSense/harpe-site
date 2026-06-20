// Types for the dependency-free keep-warm.mjs runner so its one pure export can be
// unit-tested from TypeScript (src/lib/warm.test.ts) without tripping noImplicitAny.
export function pickWarmQueries(
  payload: unknown,
  n: number,
): string[];
