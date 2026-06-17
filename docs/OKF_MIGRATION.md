# OKF migration note for source research

Google Cloud introduced OKF (Open Knowledge Format) on 2026-06-12 as a v0.1
draft. Treat it as a research-document format only until the project explicitly
adopts it.

## What OKF is

- OKF is a directory of Markdown files with YAML frontmatter.
- Each concept file requires `type`.
- Recommended frontmatter fields include `title`, `description`, `resource`,
  `tags`, and `timestamp`.
- `index.md` and `log.md` are reserved names.
- Markdown links form graph relationships between concept files.
- OKF can reference domain schemas, but it does not replace them.

## How this applies to Harpe

If source research is migrated to OKF, keep source candidates as research notes
until an endpoint is verified with a real response. OKF should link to the Harpe
domain contract in `docs/ADDING_SOURCES.md`, the shared `ArtItem` contract in
`packages/core/src/art-source.ts`, and the implementation surface in
`src/lib/server/handlers/art.ts`; it must not replace the adapter contract or
justify unverified API integrations.

Candidate source notes that belong in research before implementation:

- Europeana: primary machine-readable route for European countries whose major
  institutions expose human portals but no stable public API. Preserve country
  fan-out notes and provider findings here.
- Rijksmuseum: keyless Linked Art search API candidate at
  `https://data.rijksmuseum.nl/search/collection`, but IIIF image delivery must
  be reachable before implementation.
- Lithuania LIMIS, Poland Zacheta/MNW, Spain Prado/BNE/Hispana, and Portugal
  MatrizNet/BNP/Gulbenkian: researched as mostly human portals or unstable /
  blocked endpoints. Prefer Europeana/Wikidata/Commons coverage unless a current
  documented machine API is verified.
