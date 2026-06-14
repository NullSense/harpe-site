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

The art search runs **12 keyless** museum sources out of the box (AIC, The Met,
Cleveland, V&A, Wellcome, WikiArt, Wikimedia Commons, SMK, Nasjonalmuseet,
DigitalNZ, Wikidata, **Library of Congress**). More big collections can be
enabled by adding a free key. **The keys live only in server-side env vars and
never reach the browser** (Vite only bundles `VITE_`-prefixed vars; these run
inside the serverless function, which proxies the call). Each source stays
dormant until its key is set — so it's always safe to leave one unset.

| Source | Env var | Register for a free key |
|---|---|---|
| Europeana (3,000+ EU institutions) | `EUROPEANA_API_KEY` | https://pro.europeana.eu/pages/get-api — instant email |
| Harvard Art Museums | `HARVARD_API_KEY` | https://harvardartmuseums.org/collections/api — fill the form, key emailed instantly |
| Smithsonian (Open Access, CC0) | `SMITHSONIAN_API_KEY` | https://api.data.gov/signup — generic api.data.gov key works for the SI Open Access API |
| NYPL Digital Collections (strong **photography**) | `NYPL_API_KEY` (or `NYPL_API_TOKEN`) | https://api.repo.nypl.org/ → "sign up for API access" → token emailed (10k req/day) |
| Paris Musées (14 Paris museums) | `PARIS_MUSEES_TOKEN` | **Currently disabled in code** — redundant with Europeana and its GraphQL has no fast fulltext search. Leave unset. |

### How to register the key (per source)

1. Click the link above, create the (free) account, and copy the key/token it gives you.
2. Add it as a **server-side** env var, either way:
   - **Vercel dashboard:** Project → **Settings → Environment Variables** → add `NAME` = `value`, scope **Production** (and Preview if you want).
   - **CLI:** `vercel env add <NAME> production` then paste the value.
   - **Infisical → Vercel sync (your setup):** add the secret in Infisical (Personal project → **Harpe** folder) using the **exact env-var name** from the table above; the Vercel integration sync pushes it automatically. The name must match exactly (`HARVARD_API_KEY`, not `harvard_key`).
3. **Redeploy** (`vercel --prod` or a dashboard redeploy) — env-var changes only apply to new deployments.

> ⚠️ **NYPL is wired but untested** (I couldn't exercise it without your token). It's written defensively — it only shows results where it parsed a valid image URL, so worst case it returns nothing rather than broken images. After you add `NYPL_API_TOKEN` and redeploy, search e.g. "Berenice Abbott" and confirm photos appear; if they don't, ping me and I'll adjust the response parser.

## Scanner & reverse-image enhancements (optional keys)

These power the **"paste a URL"** scanner and an image-identification feature.
Both are server-only and dormant until their key is set.

| Feature | Env var | What it adds | Register |
|---|---|---|---|
| **Firecrawl** | `FIRECRAWL_API_KEY` | JS-rendered page fallback for the scanner. When the static HTML scan finds **0** images (client-rendered galleries, infinite scroll), it renders the page via Firecrawl and re-extracts. Only fires on empty results, to save credits. | https://www.firecrawl.dev → dashboard → API Keys |
| **SauceNAO** | `SAUCENAO_API_KEY` | Reverse-image search. A 🔍 button on each scanned image finds where it appears online + a higher-res original. Free tier ~200 lookups/day. | https://saucenao.com/user.php → "api" tab |

Both are already wired in code — just confirm the env var name matches (you have
`FIRECRAWL_API_KEY` and `SAUCENAO_API_KEY` set in Vercel already), then redeploy.

## Open-data dumps (museums with no live API)

Museums that publish a bulk dump (MoMA, National Gallery of Art, …) but no
searchable API are ingested into one **metadata-only Parquet** (text + image
URLs, no images) hosted free on **Hugging Face**, and queried via HF's keyless
`/search`. Storage cost ≈ $0.

Currently ingested: **MoMA**, **National Gallery of Art** (with NGA's AI alt-text
as descriptions), and **Minneapolis Institute of Art (MIA)** via `--with-mia`.

1. Log in once (write token): `hf auth login`
2. Build + push the dataset:
   ```
   # MoMA + NGA only (fast, no clone):
   uv run scripts/ingest-art-dumps/ingest.py --push <your-hf-user>/harpe-art

   # + MIA (shallow+sparse clones artsmia/collection, ~few hundred MB, adds ~100k works):
   uv run scripts/ingest-art-dumps/ingest.py --with-mia --push <your-hf-user>/harpe-art
   ```
3. Set `HARPE_DUMP_DATASET=<your-hf-user>/harpe-art` in Vercel, redeploy.
   (HF takes a few minutes to auto-convert `data/train.parquet` to its queryable branch.)

The `dumps` source is dormant until that env var is set. Add more museums by
UNION-ing another SELECT in `build_parquet()` (each must yield the same columns).

## Cross-source AI synthesis (the "deep analysis")

`POST /api/analyze` merges every source's metadata + descriptions for one artwork
and asks an LLM to synthesize a single account. **Dormant until you set a key:**

Set **any one** provider. They're checked in this order (first key found wins):

| Env var | Purpose | Free tier |
|---|---|---|
| `GEMINI_API_KEY` | **Recommended.** Google AI Studio (Gemini), default `gemini-2.0-flash`. | ~1500 req/day free — reliable. Key: https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | Groq (very fast), default `llama-3.3-70b-versatile`. | Generous free tier. Key: https://console.groq.com/keys |
| `OPENROUTER_API_KEY` | OpenRouter `:free` models. | Free but the shared free pool is often rate-limited (429). |
| `ANTHROPIC_API_KEY` | Claude, default `claude-haiku-4-5-20251001`. | Paid. |
| `HARPE_ANALYZE_MODEL` | optional model override for whichever provider is active | — |
| `HARPE_ANALYZE_WEB` | `1` → OpenRouter's Exa web plugin adds live context (OpenRouter only) | — |

> The earlier OpenRouter-only setup kept hitting `429` because free `:free` models share a tiny global pool. **Use `GEMINI_API_KEY`** (or `GROQ_API_KEY`) for reliable free synthesis.

OpenRouter requests send a `models` fallback list (the chosen model + two free
models), so a rate-limited free model auto-falls-through to the next.

Without the key, the button is hidden and `/api/analyze` returns 501. Results are
cached in Upstash (30 days) keyed by artwork, so each work is synthesized once.
The endpoint is rate-limited per IP and capped at 12 source records per request. Because `/api/art` is public, your key is consumed indirectly by site visitors — but the per-IP rate limit + 1-hour edge cache keep usage low, and if a key's quota is exhausted that one source just degrades to a warning (nothing breaks).
