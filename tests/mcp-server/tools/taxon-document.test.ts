/**
 * @fileoverview Tests for the shared taxon document markdown renderer —
 * `renderTaxonDocument` — which must render on field presence alone, never by
 * branching on a `kind` the type doesn't even carry. Covers the full-record
 * render, a sparse/empty-arrays render, and the standalone section blocks a
 * `sections` selection returns one at a time.
 * @module tests/mcp-server/tools/taxon-document.test
 */

import { describe, expect, it } from 'vitest';
import {
  renderTaxonDocument,
  TAXON_ALWAYS_KEEP,
  TAXON_SECTIONS,
  TAXON_SUMMARY_KEYS,
} from '@/mcp-server/tools/taxon-document.js';
import { projectedTaxonDocument } from '../../helpers/fixtures.js';

describe('section vocabulary', () => {
  it('names the six sections, with summary as the virtual root-scalar group', () => {
    expect(TAXON_SECTIONS).toEqual([
      'summary',
      'taxonomy',
      'children',
      'conservation',
      'photos',
      'encyclopedia',
    ]);
  });

  it('always keeps id, name, and rank on any selection', () => {
    expect(TAXON_ALWAYS_KEEP).toEqual(['id', 'name', 'rank']);
  });

  it('summary keys are the flat document-root scalars, not any section object', () => {
    for (const key of TAXON_SUMMARY_KEYS) {
      expect(TAXON_SECTIONS as readonly string[]).not.toContain(key === 'id' ? 'nonexistent' : key);
    }
    expect(TAXON_SUMMARY_KEYS).toContain('id');
    expect(TAXON_SUMMARY_KEYS).toContain('vision');
  });
});

describe('renderTaxonDocument — full record', () => {
  const doc = projectedTaxonDocument();

  it('renders the heading with common name and scientific name', () => {
    expect(renderTaxonDocument(doc).join('\n')).toContain('## Monarch (Danaus plexippus)');
  });

  it('renders the root scalars on one pipe-separated line', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('id 48662');
    expect(text).toContain('rank species');
    expect(text).toContain('rank_level 10');
    expect(text).toContain('iconic_taxon_name Insecta');
    expect(text).toContain('is_active true');
    expect(text).toContain('extinct false');
    expect(text).toContain('observations_count 250000');
    expect(text).toContain('listed_taxa_count 42');
    expect(text).toContain('vision true');
  });

  it('renders the taxonomy section as a rank path', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('### Taxonomy');
    expect(text).toContain('kingdom Animalia (no common name, id 1)');
  });

  it('renders the children section as a list', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('### Children');
    expect(text).toContain('taxon_id 100');
    expect(text).toContain('500 observations');
  });

  it('renders the conservation section with global status and per-listing entries', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('### Conservation');
    expect(text).toContain('**Global status:** none recorded');
    expect(text).toContain('status Special Concern');
    expect(text).toContain('place Canada');
  });

  it('renders the photos section with the photo block and large_url', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('### Photos');
    expect(text).toContain('large_url https://static.inaturalist.org/photos/1/large.jpg');
  });

  it('renders the encyclopedia section as a blockquote plus the wikipedia_url', () => {
    const text = renderTaxonDocument(doc).join('\n');
    expect(text).toContain('### Encyclopedia');
    expect(text).toContain('> The <b>monarch butterfly</b> is a milkweed butterfly.');
    expect(text).toContain('**wikipedia_url:** https://en.wikipedia.org/wiki/Monarch_butterfly');
  });
});

describe('renderTaxonDocument — empty section arrays and null fields', () => {
  const sparse = projectedTaxonDocument({
    name: null,
    common_name: null,
    rank: null,
    rank_level: null,
    iconic_taxon_name: null,
    observations_count: null,
    listed_taxa_count: null,
    taxonomy: [],
    children: [],
    conservation: { statuses: [], global_status: null },
    photos: [],
    encyclopedia: { wikipedia_summary: null, wikipedia_url: null },
  });

  it('renders the unnamed-taxon placeholder when name and common_name are both absent', () => {
    expect(renderTaxonDocument(sparse).join('\n')).toContain('## *(taxon name not recorded)*');
  });

  it('renders "not recorded" / "not published" fallbacks for null scalars', () => {
    const text = renderTaxonDocument(sparse).join('\n');
    expect(text).toContain('rank not recorded');
    expect(text).toContain('rank_level not published');
    expect(text).toContain('iconic_taxon_name none assigned');
    expect(text).toContain('observations_count not published');
    expect(text).toContain('listed_taxa_count not published');
  });

  it('renders the empty-list placeholder for each empty section', () => {
    const text = renderTaxonDocument(sparse).join('\n');
    expect(text).toContain('_No ancestors published._');
    expect(text).toContain('_No child taxa published._');
    expect(text).toContain('_No listings published._');
    expect(text).toContain('_No gallery photos published._');
    expect(text).toContain('_No encyclopedia summary published._');
  });

  it('renders none-recorded for a missing global conservation status', () => {
    expect(renderTaxonDocument(sparse).join('\n')).toContain('**Global status:** none recorded');
  });
});

describe('renderTaxonDocument — a single-section selection renders only that section', () => {
  it('renders only the photos block when the document carries just that key', () => {
    const doc = projectedTaxonDocument();
    const selection = { id: doc.id, name: doc.name, rank: doc.rank, photos: doc.photos };
    const text = renderTaxonDocument(selection).join('\n');

    expect(text).toContain('### Photos');
    expect(text).not.toContain('### Taxonomy');
    expect(text).not.toContain('### Children');
    expect(text).not.toContain('### Conservation');
    expect(text).not.toContain('### Encyclopedia');
  });

  it('renders nothing but the heading and scalar line for a summary-only selection', () => {
    const doc = projectedTaxonDocument();
    const summary = {
      id: doc.id,
      name: doc.name,
      rank: doc.rank,
      rank_level: doc.rank_level,
      common_name: doc.common_name,
      iconic_taxon_name: doc.iconic_taxon_name,
      is_active: doc.is_active,
      extinct: doc.extinct,
      observations_count: doc.observations_count,
      listed_taxa_count: doc.listed_taxa_count,
      vision: doc.vision,
    };
    const lines = renderTaxonDocument(summary);

    expect(lines.some((line) => line.startsWith('## '))).toBe(true);
    expect(lines.some((line) => line.startsWith('### '))).toBe(false);
  });

  it('renders nothing at all for an empty (outline-arm) document', () => {
    expect(renderTaxonDocument({})).toEqual([]);
  });
});

/**
 * Conservation status text, authority names, and community-editable common
 * names are third-party strings rendered inline. A line break inside one ends
 * its line and lets the remainder read as structure this renderer never
 * emitted.
 */
describe('line breaks in taxon text cannot forge markdown structure', () => {
  const FORGERY = '## Forged heading';

  const forgedLines = (lines: readonly string[]): string[] =>
    lines
      .join('\n')
      .split(/\r\n|[\r\n]/)
      .filter((line) => line.startsWith(FORGERY));

  it('does not let a common name break out of the document heading', () => {
    const doc = projectedTaxonDocument({ common_name: `Monarch\n${FORGERY}` });
    expect(forgedLines(renderTaxonDocument(doc))).toEqual([]);
  });

  it('does not let a conservation authority break out of its listing line', () => {
    const doc = projectedTaxonDocument({
      conservation: {
        statuses: [
          {
            status: `Special Concern\r${FORGERY}`,
            authority: `Some Authority\n${FORGERY}`,
            iucn: 30,
            place: null,
            url: null,
          },
        ],
        global_status: null,
      },
    });
    expect(forgedLines(renderTaxonDocument(doc))).toEqual([]);
  });

  it('does not let an ancestor or child name break out of its line', () => {
    const doc = projectedTaxonDocument({
      taxonomy: [{ id: 1, name: `Animalia\n${FORGERY}`, rank: 'kingdom', common_name: null }],
      children: [
        {
          id: 2,
          name: `Danaus\n${FORGERY}`,
          rank: 'genus',
          common_name: null,
          observations_count: 5,
        },
      ],
    });
    expect(forgedLines(renderTaxonDocument(doc))).toEqual([]);
  });

  it('keeps the encyclopedia summary quoted across a bare CR', () => {
    const doc = projectedTaxonDocument({
      encyclopedia: {
        wikipedia_summary: `A butterfly.\r${FORGERY}`,
        wikipedia_url: `https://example.test\n${FORGERY}`,
      },
    });
    const lines = renderTaxonDocument(doc);
    expect(lines.join('\n')).toContain(`> ${FORGERY}`);
    expect(forgedLines(lines)).toEqual([]);
  });
});
