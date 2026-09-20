/**
 * @fileoverview Tests for inaturalist_get_similar_species — area validation,
 * the unknown_taxon_id passthrough, the zero-hit and limit-truncation
 * enrichment (with the descending-rank ceiling), and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetSimilarSpecies } from '@/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { similarSpecies } from '../../../helpers/fixtures.js';

vi.mock('@/services/inaturalist/inaturalist-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/inaturalist/inaturalist-service.js')>();
  return { ...actual, getINaturalistService: vi.fn() };
});

const fake = createFakeService();

beforeEach(() => {
  resetFakeService(fake);
  vi.mocked(getINaturalistService).mockReturnValue(asService(fake));
});

function candidates(count: number) {
  return Array.from({ length: count }, (_, i) =>
    similarSpecies({ taxon_id: i + 1, misidentification_count: count - i }),
  );
}

describe('area validation', () => {
  it('rejects a partial coordinate triple', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({
      taxon_id: 48662,
      lat: 47.6,
      lng: -122.3,
    });

    await expect(inaturalistGetSimilarSpecies.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.getSimilarSpecies).not.toHaveBeenCalled();
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({
      taxon_id: 48662,
      place_id: 46,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await expect(inaturalistGetSimilarSpecies.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.getSimilarSpecies.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistGetSimilarSpecies.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('zero-hit and limit-truncation enrichment', () => {
  it('returns an empty list with the zero-hit notice', async () => {
    fake.getSimilarSpecies.mockResolvedValue({ total: 0, similar: [] });
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({ taxon_id: 48662 });

    const result = await inaturalistGetSimilarSpecies.handler(input, ctx);

    expect(result).toEqual({ taxon_id: 48662, similar_species: [] });
    expect(getEnrichment(ctx).notice).toBe(
      'No look-alikes are recorded for this taxon — either it is rarely misidentified, or the area filter is too narrow. Re-run without the area filter to see the global confusion set.',
    );
  });

  it('discloses truncation with the descending-rank ceiling when the in-process limit cuts the set', async () => {
    fake.getSimilarSpecies.mockResolvedValue({ total: 24, similar: candidates(24) });
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({ taxon_id: 48662, limit: 20 });

    const result = await inaturalistGetSimilarSpecies.handler(input, ctx);

    expect(result.similar_species).toHaveLength(20);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(20);
    expect(enrichment.cap).toBe(20);
    expect(enrichment.truncationCeiling).toBe(candidates(24)[19]?.misidentification_count);
    expect(enrichment.totalCount).toBe(24);
  });

  it('reports truncated: false when the whole confusion set fits under the limit', async () => {
    fake.getSimilarSpecies.mockResolvedValue({ total: 3, similar: candidates(3) });
    const ctx = createMockContext({ errors: inaturalistGetSimilarSpecies.errors });
    const input = inaturalistGetSimilarSpecies.input.parse({ taxon_id: 48662 });

    await inaturalistGetSimilarSpecies.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({
      truncated: false,
      shown: 3,
      cap: 20,
      totalCount: 3,
    });
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.getSimilarSpecies.mockResolvedValue({ total: 0, similar: [] });

    const result = await runToolContract(inaturalistGetSimilarSpecies, { taxon_id: 48662 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      similar_species: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 20,
      notice:
        'No look-alikes are recorded for this taxon — either it is rarely misidentified, or the area filter is too narrow. Re-run without the area filter to see the global confusion set.',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No look-alikes are recorded for this taxon');
  });
});

describe('format()', () => {
  it('renders the header and a ranked numbered list with the photo block', () => {
    const result = { taxon_id: 48662, similar_species: [similarSpecies()] };
    const [block] = inaturalistGetSimilarSpecies.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**taxon_id:** 48662 · **look-alikes returned:** 1');
    expect(text).toContain(
      '1. **Viceroy** (*Limenitis archippus*) — corrected 12 times · species · 50000 observations · taxon_id 48663',
    );
    expect(text).toContain('**Photo:**');
  });

  it('renders "observation count not published" for a null observations_count', () => {
    const result = {
      taxon_id: 48662,
      similar_species: [similarSpecies({ observations_count: null })],
    };
    const [block] = inaturalistGetSimilarSpecies.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('observation count not published');
  });

  it('does not let a community-editable name forge a heading', () => {
    const FORGERY = '## Forged heading';
    const result = {
      taxon_id: 48662,
      similar_species: [
        similarSpecies({
          common_name: `Viceroy\n${FORGERY}`,
          name: `Limenitis\r${FORGERY}`,
          rank: `species\n${FORGERY}`,
        }),
      ],
    };
    const [block] = inaturalistGetSimilarSpecies.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text.split(/\r\n|[\r\n]/).filter((line) => line.startsWith(FORGERY))).toEqual([]);
  });
});
