/**
 * Harpe MCP tools — thin wrappers over the shared @harpe/sources engine (the SAME
 * orchestration the website handlers use), so an LLM agent gets the full federated +
 * dump-backed art search and the Wikidata knowledge graph.
 *
 * Each tool's logic is a plain async function returning MCP text content (unit-tested
 * directly); registerTools() binds them onto an McpServer with zod input schemas.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchArt, loadArtistPage, loadSubjectPage, resolveQueryEntity, fetchItemById } from '@harpe/sources';
import type { ArtItem } from '@harpe/core';

export type ToolText = { content: { type: 'text'; text: string }[] };
const text = (data: unknown): ToolText => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const QID = z.string().regex(/^Q\d+$/, 'expected a Wikidata QID like Q42');

// Project an ArtItem down to the fields an agent reasons over (drop download arrays,
// per-source variant blobs, etc.) — keeps tool output compact and readable.
function slim(it: ArtItem) {
  return {
    id: it.id,
    title: it.title,
    artist: it.artist || undefined,
    date: it.date || undefined,
    medium: it.medium || undefined,
    source: it.source,
    provider: it.provider,
    image: it.fullUrl || it.previewUrl,
    thumb: it.thumbUrl,
    sourceUrl: it.sourceUrl,
    publicDomain: it.isPublicDomain,
    wikidataId: it.wikidataId,
    artistId: it.artistId,
    depicts: it.depicts,
    depictsLabels: it.depictsLabels,
    width: it.width,
    height: it.height,
  };
}

export async function searchArtTool({ query, max }: { query: string; max?: number }): Promise<ToolText> {
  const { items, warnings } = await searchArt(query, { max });
  return text({ count: items.length, items: items.map(slim), warnings });
}

export async function artistTool({ qid }: { qid: string }): Promise<ToolText> {
  const page = await loadArtistPage(qid);
  if (!page) return text({ error: `artist ${qid} is not in the knowledge graph` });
  return text({ entity: page.entity, works: page.works.map(slim) });
}

export async function subjectTool({ qid }: { qid: string }): Promise<ToolText> {
  const page = await loadSubjectPage(qid);
  if (!page) return text({ error: `subject ${qid} is not in the knowledge graph` });
  return text({ entity: page.entity, works: page.works.map(slim) });
}

export async function resolveTool({ query }: { query: string }): Promise<ToolText> {
  const entity = await resolveQueryEntity(query);
  return text({ entity }); // { kind: 'subject', qid } | null
}

export async function itemTool({ id }: { id: string }): Promise<ToolText> {
  const item = await fetchItemById(id);
  if (!item) return text({ error: `item ${id} not found` });
  return text({ item: slim(item) });
}

/** Bind every tool onto an McpServer with its zod input schema. */
export function registerTools(server: McpServer): void {
  server.registerTool('search_art', {
    title: 'Search art',
    description: 'Federated + dump-backed search across ~20 open museum/heritage collections '
      + '(Met, AIC, Cleveland, NGA, Smithsonian, Europeana, Wikidata, Commons, …). Returns ranked, '
      + 'deduped public-domain works with image URLs and Wikidata QIDs (wikidataId/artistId/depicts).',
    inputSchema: { query: z.string().min(1), max: z.number().int().min(1).max(100).optional() },
  }, ({ query, max }) => searchArtTool({ query, max }));

  server.registerTool('artist', {
    title: 'Artist page (knowledge graph)',
    description: 'Given a Wikidata artist QID, return the artist node (label, description, work count) '
      + 'plus a grid of their works from the deep index.',
    inputSchema: { qid: QID },
  }, ({ qid }) => artistTool({ qid }));

  server.registerTool('subject', {
    title: 'Subject page (knowledge graph)',
    description: 'Given a Wikidata subject QID, return the subject node plus works that depict it (P180).',
    inputSchema: { qid: QID },
  }, ({ qid }) => subjectTool({ qid }));

  server.registerTool('resolve', {
    title: 'Resolve a query to a KG subject',
    description: 'Detect whether a free-text query names a known knowledge-graph subject; returns '
      + '{ kind: "subject", qid } or null. Use before "subject" to turn a name into a QID.',
    inputSchema: { query: z.string().min(1) },
  }, ({ query }) => resolveTool({ query }));

  server.registerTool('item', {
    title: 'Resolve one work by id',
    description: 'Fetch a single artwork by its stable Harpe id (e.g. "met-436535", "commons-12345").',
    inputSchema: { id: z.string().min(1) },
  }, ({ id }) => itemTool({ id }));
}
