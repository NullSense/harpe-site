import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock undici's fetch so the Wikipedia retrieval is deterministic — no network.
vi.mock('undici', () => ({ fetch: vi.fn() }));
import { fetch } from 'undici';
import { fetchWikipedia, buildPrompt } from './analyze.js';

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });

beforeEach(() => mockFetch.mockReset());

describe('fetchWikipedia (RAG grounding)', () => {
  it('finds the artwork article and returns its extract', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ query: { search: [{ title: 'The Death of Socrates' }] } }))
      .mockResolvedValueOnce(ok({ query: { pages: { '1': {
        title: 'The Death of Socrates',
        fullurl: 'https://en.wikipedia.org/wiki/The_Death_of_Socrates',
        extract: 'The Death of Socrates is a 1787 oil on canvas by Jacques-Louis David, a key Neoclassical work depicting the philosopher’s final moments.'.repeat(2),
      } } } }));
    const wiki = await fetchWikipedia('The Death of Socrates', 'Jacques-Louis David', new AbortController().signal);
    expect(wiki?.title).toBe('The Death of Socrates');
    expect(wiki?.url).toContain('/wiki/The_Death_of_Socrates');
    expect(wiki?.extract).toMatch(/Neoclassical/);
  });

  it('discards a wrong page when the artist is not mentioned (anti-mismatch guard)', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ query: { search: [{ title: 'Socrates' }] } }))
      .mockResolvedValueOnce(ok({ query: { pages: { '1': {
        title: 'Socrates', fullurl: 'https://en.wikipedia.org/wiki/Socrates',
        extract: 'Socrates was a Greek philosopher from Athens, a founder of Western philosophy. He wrote nothing himself.'.repeat(2),
      } } } }));
    const wiki = await fetchWikipedia('The Death of Socrates', 'Jacques-Louis David', new AbortController().signal);
    expect(wiki).toBeNull(); // article never mentions "David" → rejected
  });

  it('skips retrieval for generic / untitled works', async () => {
    expect(await fetchWikipedia('Untitled', '', new AbortController().signal)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null gracefully when Wikipedia errors', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
    expect(await fetchWikipedia('The Night Watch', 'Rembrandt', new AbortController().signal)).toBeNull();
  });
});

describe('buildPrompt', () => {
  const items = [{ source: 'aic', date: '1787', medium: 'Oil on canvas', creditLine: 'Harding', description: 'A tapestry.' }];

  it('includes the educational sections and museum records', () => {
    const p = buildPrompt('The Death of Socrates', 'Jacques-Louis David', items, null);
    for (const section of ['The Subject', 'Context', 'How to Look', 'Meaning']) expect(p).toContain(section);
    expect(p).toContain('Oil on canvas');
    expect(p).toContain('Jacques-Louis David');
  });

  it('embeds Wikipedia context and a Learn-more link when present', () => {
    const wiki = { title: 'The Death of Socrates', url: 'https://en.wikipedia.org/wiki/The_Death_of_Socrates', extract: 'Neoclassical masterpiece.' };
    const p = buildPrompt('The Death of Socrates', 'Jacques-Louis David', items, wiki);
    expect(p).toContain('ENCYCLOPEDIC BACKGROUND');
    expect(p).toContain('Neoclassical masterpiece.');
    expect(p).toContain(wiki.url);
  });
});
