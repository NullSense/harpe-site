/**
 * Federated artwork search across museum / aggregator APIs (parallel, async).
 * Ported from harpe/sources.py.
 *
 * Keyless sources always run; keyed ones (Harvard/Smithsonian/Europeana/Firecrawl)
 * light up only when their env var is set. Each returns Candidate[]; a failing
 * source never blocks the rest.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { API_UA, UA } from './config.js';
import type { Candidate } from './models.js';
import { rank } from './rank.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = 'https://query.wikidata.org/sparql';
const TIMEOUT_MS = 20_000;

function stripHtml(s: string | null | undefined): string {
  return ((s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function toInt(v: unknown): number {
  try {
    const n = Number.parseInt(String(v ?? '').replace(/\D/g, '') || '0', 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function makeCandidate(fields: Partial<Candidate>): Candidate {
  return {
    area: 0, res: '?', source: '', title: '', artist: '',
    date: '', spec: '', thumb: '', medium: '', desc: '', physdim: '',
    ...fields,
  };
}

/** Fetch with AbortSignal timeout and default API_UA header. */
async function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers({ 'User-Agent': API_UA, ...(init.headers as Record<string, string> ?? {}) });
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Wikimedia Commons image search. */
async function _commons(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: q, gsrnamespace: '6', gsrlimit: '15',
    prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '400',
  });
  const r = await apiFetch(`${COMMONS_API}?${params}`);
  const j = await r.json() as Record<string, unknown>;
  const pages = ((j.query as Record<string, unknown> ?? {}).pages as Record<string, unknown> ?? {});
  const out: Candidate[] = [];
  for (const page of Object.values(pages)) {
    const p = page as Record<string, unknown>;
    const ii = ((p.imageinfo as unknown[]) ?? [{}])[0] as Record<string, unknown>;
    const mime = String(ii.mime ?? '');
    if (!/^image\/(jpeg|png|tiff|webp)/.test(mime)) continue;
    const w = Number(ii.width ?? 0);
    const h = Number(ii.height ?? 0);
    const rawTitle = String(p.title ?? '');
    const title = rawTitle.replace(/^File:/, '').replace(/\.[A-Za-z]+$/, '');
    out.push(makeCandidate({
      area: w * h, res: `${w}x${h}`, source: 'Commons',
      title, spec: 'url:' + String(ii.url ?? ''),
      thumb: String(ii.thumburl ?? ''),
    }));
  }
  return out;
}

/** Art Institute of Chicago. */
async function _aic(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({
    q, limit: '8',
    fields: 'id,title,artist_title,date_display,medium_display,description,dimensions,image_id,is_public_domain,thumbnail',
  });
  const r = await apiFetch(`https://api.artic.edu/api/v1/artworks/search?${params}`);
  const j = await r.json() as Record<string, unknown>;
  const iiif = String(((j.config as Record<string, unknown>) ?? {}).iiif_url ?? '') || 'https://www.artic.edu/iiif/2';
  const out: Candidate[] = [];
  for (const d of (j.data as unknown[] ?? [])) {
    const item = d as Record<string, unknown>;
    if (!item.is_public_domain || !item.image_id) continue;
    const th = (item.thumbnail as Record<string, unknown>) ?? {};
    const w = Number(th.width ?? 0);
    const h = Number(th.height ?? 0);
    const img = String(item.image_id);
    out.push(makeCandidate({
      area: w * h,
      res: `${w || '?'}x${h || '?'}`,
      source: 'AIC',
      title: String(item.title ?? ''),
      artist: String(item.artist_title ?? ''),
      date: String(item.date_display ?? ''),
      spec: `url:${iiif}/${img}/full/full/0/default.jpg`,
      thumb: `${iiif}/${img}/full/400,/0/default.jpg`,
      medium: String(item.medium_display ?? ''),
      desc: stripHtml(String(item.description ?? '')).slice(0, 400),
      physdim: String(item.dimensions ?? '').split(';')[0] ?? '',
    }));
  }
  return out;
}

/** Cleveland Museum of Art. */
async function _cleveland(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ q, has_image: '1', cc0: '1', limit: '8' });
  const r = await apiFetch(`https://openaccess-api.clevelandart.org/api/artworks/?${params}`);
  const j = await r.json() as Record<string, unknown>;
  const out: Candidate[] = [];
  for (const d of (j.data as unknown[] ?? [])) {
    const item = d as Record<string, unknown>;
    const imgs = (item.images as Record<string, unknown>) ?? {};
    const im = (imgs.full ?? imgs.print ?? imgs.web) as Record<string, unknown> | undefined;
    if (!im) continue;
    const w = toInt(im.width);
    const h = toInt(im.height);
    const creators = (item.creators as Array<Record<string, unknown>>) ?? [];
    const artist = creators.length ? String(creators[0].description ?? '') : '';
    const webImg = (imgs.web as Record<string, unknown>) ?? {};
    const printImg = (imgs.print as Record<string, unknown>) ?? {};
    const web = String(webImg.url ?? printImg.url ?? '');
    out.push(makeCandidate({
      area: w * h,
      res: `${im.width ?? '?'}x${im.height ?? '?'}`,
      source: 'Cleveland',
      title: String(item.title ?? ''),
      artist,
      date: String(item.creation_date ?? ''),
      spec: 'url:' + String(im.url ?? ''),
      thumb: web,
      medium: String(item.technique ?? ''),
      desc: stripHtml(String(item.description ?? '')).slice(0, 400),
      physdim: String(item.measurements ?? ''),
    }));
  }
  return out;
}

/** Metropolitan Museum of Art (two-phase: search then per-object). */
async function _met(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ q, hasImages: 'true' });
  const r = await apiFetch(`https://collectionapi.metmuseum.org/public/collection/v1/search?${params}`);
  const j = await r.json() as Record<string, unknown>;
  const ids = ((j.objectIDs as number[]) ?? []).slice(0, 5);

  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const rr = await apiFetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      const d = await rr.json() as Record<string, unknown>;
      if (!d.isPublicDomain || !d.primaryImage) return null;
      return makeCandidate({
        area: 30_000_000, res: 'Met·full', source: 'Met',
        title: String(d.title ?? ''),
        artist: String(d.artistDisplayName ?? ''),
        date: String(d.objectDate ?? ''),
        spec: 'url:' + String(d.primaryImage),
        thumb: String(d.primaryImageSmall ?? ''),
        medium: String(d.medium ?? ''),
        physdim: String(d.dimensions ?? '').replace(/\s+/g, ' '),
      });
    }),
  );

  const out: Candidate[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value !== null) {
      out.push(res.value);
    }
  }
  return out;
}

/** Victoria and Albert Museum. */
async function _vam(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ q, images_exist: '1', page_size: '10' });
  const r = await fetch(`https://api.vam.ac.uk/v2/objects/search?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json() as Record<string, unknown>;
  const out: Candidate[] = [];
  for (const d of (j.records as unknown[] ?? [])) {
    const item = d as Record<string, unknown>;
    const pid = String(item._primaryImageId ?? '');
    if (!pid) continue;
    const base = `https://framemark.vam.ac.uk/collections/${pid}`;
    const maker = (item._primaryMaker as Record<string, unknown>) ?? {};
    out.push(makeCandidate({
      area: 30_000_000, res: 'V&A·full', source: 'V&A',
      title: String(item._primaryTitle ?? item._objectType ?? 'untitled'),
      artist: String(maker.name ?? ''),
      date: String(item._primaryDate ?? ''),
      spec: `url:${base}/full/full/0/default.jpg`,
      thumb: `${base}/full/!400,400/0/default.jpg`,
    }));
  }
  return out;
}

/** Harvard Art Museums (requires HARVARD_API_KEY). */
async function _harvard(q: string): Promise<Candidate[]> {
  const key = process.env.HARVARD_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    apikey: key, q, hasimage: '1', size: '10',
    fields: 'title,people,primaryimageurl,images,dated',
  });
  const r = await fetch(`https://api.harvardartmuseums.org/object?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json() as Record<string, unknown>;
  const out: Candidate[] = [];
  for (const d of (j.records as unknown[] ?? [])) {
    const item = d as Record<string, unknown>;
    if (!item.primaryimageurl) continue;
    const images = (item.images as Array<Record<string, unknown>>) ?? [{}];
    const im = images[0] ?? {};
    const w = Number(im.width ?? 0);
    const h = Number(im.height ?? 0);
    const people = (item.people as Array<Record<string, unknown>>) ?? [];
    const artistPerson = people.find((p) => p.role === 'Artist');
    const artist = String(artistPerson?.name ?? people[0]?.name ?? '');
    const primaryUrl = String(item.primaryimageurl);
    out.push(makeCandidate({
      area: w * h,
      res: w ? `${w}x${h}` : 'Harvard·full',
      source: 'Harvard',
      title: String(item.title ?? ''),
      artist,
      date: String(item.dated ?? ''),
      spec: 'url:' + primaryUrl,
      thumb: primaryUrl,
    }));
  }
  return out;
}

/** Smithsonian Open Access (requires SMITHSONIAN_API_KEY). */
async function _smithsonian(q: string): Promise<Candidate[]> {
  const key = process.env.SMITHSONIAN_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ api_key: key, q, rows: '15' });
  const r = await fetch(`https://api.si.edu/openaccess/api/v1.0/search?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json() as Record<string, unknown>;
  const rows = (((j.response as Record<string, unknown>) ?? {}).rows as unknown[]) ?? [];
  const out: Candidate[] = [];
  for (const d of rows) {
    const item = d as Record<string, unknown>;
    const content = (item.content as Record<string, unknown>) ?? {};
    const dnr = (content.descriptiveNonRepeating as Record<string, unknown>) ?? {};
    const onlineMedia = (dnr.online_media as Record<string, unknown>) ?? {};
    const mediaArr = (onlineMedia.media as Array<Record<string, unknown>>) ?? [{}];
    const media = mediaArr[0] ?? {};
    if (!media.content) continue;
    const ft = (content.freetext as Record<string, unknown>) ?? {};
    const nameArr = (ft.name as Array<Record<string, unknown>>) ?? [{}];
    const dateArr = (ft.date as Array<Record<string, unknown>>) ?? [{}];
    const mediaContent = String(media.content);
    out.push(makeCandidate({
      area: 30_000_000, res: 'SI·full', source: 'Smithsonian',
      title: String(item.title ?? 'untitled'),
      artist: String(nameArr[0]?.content ?? ''),
      date: String(dateArr[0]?.content ?? ''),
      spec: 'url:' + mediaContent,
      thumb: String(media.thumbnail ?? (mediaContent + '&max=400')),
    }));
  }
  return out;
}

/** Europeana (requires EUROPEANA_API_KEY). */
async function _europeana(q: string): Promise<Candidate[]> {
  const key = process.env.EUROPEANA_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    wskey: key, query: q, rows: '10', media: 'true', qf: 'TYPE:IMAGE',
  });
  const r = await fetch(`https://api.europeana.eu/record/v2/search.json?${params}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json() as Record<string, unknown>;
  const out: Candidate[] = [];
  for (const it of (j.items as unknown[] ?? [])) {
    const item = it as Record<string, unknown>;
    const shownBy = (item.edmIsShownBy as string[]) ?? [];
    const preview = (item.edmPreview as string[]) ?? [];
    const img = shownBy[0] ?? preview[0];
    if (!img) continue;
    const title = ((item.title as string[]) ?? ['untitled'])[0] ?? 'untitled';
    const artist = ((item.dcCreator as string[]) ?? [''])[0] ?? '';
    const date = ((item.year as string[]) ?? [''])[0] ?? '';
    out.push(makeCandidate({
      area: 30_000_000, res: 'EU·web', source: 'Europeana',
      title, artist, date,
      spec: 'url:' + img,
      thumb: preview[0] ?? img,
    }));
  }
  return out;
}

/** Wikidata IIIF manifests (2-step: wbsearchentities → SPARQL wdt:P6108). */
async function _wikidata(q: string): Promise<Candidate[]> {
  const params = new URLSearchParams({
    action: 'wbsearchentities', format: 'json', language: 'en',
    limit: '7', search: q,
  });
  const r = await apiFetch(`${WD_API}?${params}`);
  const j = await r.json() as Record<string, unknown>;
  const qids = ((j.search as Array<Record<string, unknown>>) ?? []).map((x) => String(x.id));
  if (qids.length === 0) return [];

  const values = qids.map((id) => `wd:${id}`).join(' ');
  const query = `SELECT ?itemLabel ?manifest WHERE { VALUES ?item { ${values} } `
    + `?item wdt:P6108 ?manifest. SERVICE wikibase:label `
    + `{ bd:serviceParam wikibase:language "en". } }`;
  const sparqlParams = new URLSearchParams({ query, format: 'json' });
  const rr = await apiFetch(`${WD_SPARQL}?${sparqlParams}`, {
    headers: { Accept: 'application/sparql-results+json' },
  });
  const jj = await rr.json() as Record<string, unknown>;
  const bindings = (((jj.results as Record<string, unknown>) ?? {}).bindings as Array<Record<string, unknown>>) ?? [];
  const out: Candidate[] = [];
  for (const b of bindings) {
    const man = String((b.manifest as Record<string, unknown>)?.value ?? '');
    if (!man.startsWith('http')) continue;
    const labelVal = String((b.itemLabel as Record<string, unknown>)?.value ?? '');
    out.push(makeCandidate({
      area: 999_999_999, res: 'IIIF·max', source: 'Wikidata',
      title: labelVal, spec: 'iiif:' + man,
    }));
  }
  return out;
}

/** Firecrawl image search (requires FIRECRAWL_API_KEY or ~/.config/grab/firecrawl.key). */
async function firecrawlKey(): Promise<string | null> {
  const env = process.env.FIRECRAWL_API_KEY;
  if (env) return env;
  const keyFile = join(homedir(), '.config', 'grab', 'firecrawl.key');
  try {
    const v = (await readFile(keyFile, 'utf8')).trim();
    return v || null;
  } catch {
    return null;
  }
}

async function _firecrawl(q: string): Promise<Candidate[]> {
  const key = await firecrawlKey();
  if (!key) return [];
  const r = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `${q} larger:1200x1200`,
      sources: ['images'],
      limit: 12,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json() as Record<string, unknown>;
  const images = ((j.data as Record<string, unknown>) ?? {}).images as Array<Record<string, unknown>> ?? [];
  const out: Candidate[] = [];
  for (const im of images) {
    const u = String(im.imageUrl ?? '');
    const w = Number(im.imageWidth ?? 0);
    const h = Number(im.imageHeight ?? 0);
    if (!u || w <= 0 || h <= 0) continue;
    out.push(makeCandidate({
      area: w * h, res: `${w}x${h}`, source: 'Web',
      title: String(im.title ?? 'web image'),
      spec: 'url:' + u, thumb: u,
    }));
  }
  return out;
}

const SOURCES: Array<(q: string) => Promise<Candidate[]>> = [
  _commons, _aic, _cleveland, _met, _vam, _harvard, _smithsonian,
  _europeana, _wikidata, _firecrawl,
];

/**
 * Query all 10 museum sources in parallel, swallowing per-source errors.
 * Returns a flat list of all Candidates gathered.
 */
export async function gather(q: string): Promise<Candidate[]> {
  const results = await Promise.allSettled(SOURCES.map((fn) => fn(q)));
  const out: Candidate[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled') out.push(...res.value);
  }
  return out;
}

/** Convenience: gather then rank. */
export async function searchArt(q: string): Promise<Candidate[]> {
  return rank(q, await gather(q));
}
