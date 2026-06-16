/**
 * Minimal Vercel serverless handler types.
 *
 * We only ever used @vercel/node for these two type aliases, but that package
 * pulls a large build-time dependency tree (esbuild, undici, ajv, minimatch,
 * path-to-regexp …) that triggers npm-audit/Dependabot noise without ever
 * shipping in the deployed function. The Vercel runtime provides the actual
 * req/res objects at runtime; these structural types are all our code needs.
 */

export interface VercelRequest {
  method?: string;
  url?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string | number | readonly string[]): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: unknown): VercelResponse;
}
