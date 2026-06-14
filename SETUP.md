# Deployment Setup

## Caching (automatic — no setup required)

CDN caching is handled automatically by Vercel's Edge Network via `Cache-Control` headers set by the API functions. No configuration needed.

| Endpoint | s-maxage | stale-while-revalidate |
|---|---|---|
| `GET /api/art` | 1 hour | 24 hours |
| `GET /api/scan` | 30 minutes | 24 hours |
| `GET /api/fetch` (image proxy) | 24 hours | 7 days |

Error responses (4xx/5xx) always return `Cache-Control: no-store` so failures are never cached at the edge.

## Rate Limiting

### Default (no setup): in-memory limiter

Without any configuration, each serverless function instance enforces 30 requests/minute per IP using an in-memory window. Because Vercel may run multiple instances in parallel, this is a best-effort limit — it works well under normal traffic but is not globally strict.

### Optional: Durable cross-instance rate limiting via Upstash Redis

For stricter enforcement across all instances (recommended for production), configure a free Upstash Redis database:

1. Create a free database at [upstash.com](https://upstash.com) (free tier: 10,000 commands/day — plenty for this use case).
2. In the Upstash console, copy the two values from the **REST API** section:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Add them as Vercel environment variables:
   ```
   vercel env add UPSTASH_REDIS_REST_URL production
   vercel env add UPSTASH_REDIS_REST_TOKEN production
   ```
   Or add them in the Vercel dashboard under **Settings → Environment Variables**.
4. Redeploy for the new env vars to take effect:
   ```
   vercel --prod
   ```

The limit is generous: **60 requests per 60 seconds per IP** (sliding window), so real users are never blocked. Only abusive scripts hitting the API repeatedly will be rate-limited. The fallback in-memory limiter remains active if env vars are missing or the Redis connection fails.

> The code also accepts the `KV_REST_API_URL` / `KV_REST_API_TOKEN` names that the Vercel Marketplace **Upstash for Redis** integration injects — so the one-click integration works with no code change.

## Optional art sources (free API keys)

The art search runs 7 keyless museum sources out of the box (AIC, The Met, Cleveland, V&A, Wellcome, WikiArt, Wikimedia Commons). Three more big collections can be enabled by adding a free key. **The keys live only in server-side env vars and never reach the browser** (Vite only bundles `VITE_`-prefixed vars; these run inside the serverless function, which proxies the call). Each source stays dormant until its key is set.

| Source | Env var | Get a free key |
|---|---|---|
| Europeana (3,000+ EU institutions) | `EUROPEANA_API_KEY` | https://pro.europeana.eu/pages/get-api |
| Harvard Art Museums | `HARVARD_API_KEY` | https://harvardartmuseums.org/collections/api |
| Smithsonian (Open Access, CC0) | `SMITHSONIAN_API_KEY` | https://api.data.gov/signup |
| Paris Musées (14 Paris museums) | `PARIS_MUSEES_TOKEN` | https://apicollections.parismusees.paris.fr/en/user/register → My Account → Auth Tokens |

Add each in the Vercel dashboard (**Settings → Environment Variables**) or via `vercel env add <NAME> production`, then redeploy.

## Cross-source AI synthesis (the "deep analysis")

`POST /api/analyze` merges every source's metadata + descriptions for one artwork
and asks an LLM to synthesize a single account. **Dormant until you set a key:**

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | enables the "✦ Synthesize" button (server-only; never sent to the browser) |
| `HARPE_ANALYZE_MODEL` | optional model override (default `claude-haiku-4-5-20251001`) |

Without the key, the button is hidden and `/api/analyze` returns 501. Results are
cached in Upstash (30 days) keyed by artwork, so each work is synthesized once.
The endpoint is rate-limited per IP and capped at 12 source records per request. Because `/api/art` is public, your key is consumed indirectly by site visitors — but the per-IP rate limit + 1-hour edge cache keep usage low, and if a key's quota is exhausted that one source just degrades to a warning (nothing breaks).
