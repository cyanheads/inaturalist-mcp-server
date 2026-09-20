/**
 * @fileoverview Tests for inaturalist_get_species_counts — area validation,
 * the unpaired-annotation-value contract, the unknown_taxon_id passthrough,
 * the zero-hit and truncation enrichment, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { speciesCount } from '../../../helpers/fixtures.js';

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

function species(count: number) {
  return Array.from({ length: count }, (_, i) =>
    speciesCount({ taxon_id: i + 1, observation_count: 100 - i }),
  );
}

describe('area validation', () => {
  it('rejects a partial coordinate triple', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ lat: 47.6, lng: -122.3 });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.getSpeciesCounts).not.toHaveBeenCalled();
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({
      place_id: 1,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('rejects an incomplete bounding box', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ nelat: 47.7, nelng: -122.2 });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });
});

describe('annotation pairing', () => {
  it('rejects term_value_id supplied without term_id', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ term_value_id: [6] });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unpaired_annotation_value' },
    });
    expect(fake.getSpeciesCounts).not.toHaveBeenCalled();
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.getSpeciesCounts.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('zero-hit and truncation enrichment', () => {
  it('returns an empty list with the zero-hit notice', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 0, species: [] });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({});

    const result = await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(result).toEqual({ total_results: 0, species: [] });
    expect(getEnrichment(ctx).notice).toBe(
      'No species recorded for that area and period. Widen the date range or the area, or set quality_grade to include "needs_id".',
    );
  });

  it('discloses truncation with the descending-rank ceiling when the page fills and more remain', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 100, species: species(25) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ per_page: 25, page: 1 });

    const result = await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(result.species).toHaveLength(25);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(25);
    expect(enrichment.cap).toBe(25);
    expect(enrichment.truncationCeiling).toBe(species(25).at(-1)?.observation_count);
  });

  it('does not disclose truncation when the full result set fits on one page', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 3, species: species(3) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ per_page: 25, page: 1 });

    await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('echoes the applied quality_grade and captive defaults on every response', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 1, species: species(1) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({});

    await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(getEnrichment(ctx).applied_filters).toEqual({
      quality_grade: ['research'],
      captive: false,
    });
  });
});

describe('format()', () => {
  it('renders the header and a ranked numbered list with the photo block', () => {
    const result = { total_results: 4200, species: [speciesCount()] };
    const [block] = inaturalistGetSpeciesCounts.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**total_results:** 4200 distinct species');
    expect(text).toContain(
      '1. **Monarch** (*Danaus plexippus*) — 4200 observations · species · Insecta · taxon_id 48662',
    );
    expect(text).toContain('**Photo:**');
  });

  it('renders an empty species list with just the header line', () => {
    const result = { total_results: 0, species: [] };
    const [block] = inaturalistGetSpeciesCounts.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toBe('**total_results:** 0 distinct species');
  });
});
