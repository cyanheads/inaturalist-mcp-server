/**
 * @fileoverview Tests for inaturalist_get_histogram — area validation, the
 * unknown_taxon_id passthrough, the every-bucket-zero notice, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-histogram.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';

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

describe('area validation', () => {
  it('rejects a partial coordinate triple', async () => {
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ lat: 47.6, radius: 10 });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.getHistogram).not.toHaveBeenCalled();
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({
      place_id: 1,
      nelat: 47.7,
      nelng: -122.2,
      swlat: 47.5,
      swlng: -122.4,
    });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('rejects an incomplete bounding box', async () => {
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ nelat: 47.7, swlat: 47.5, swlng: -122.4 });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.getHistogram.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('zero-hit notice', () => {
  it('fires only when every bucket is zero', async () => {
    fake.getHistogram.mockResolvedValue([
      { key: '1', count: 0 },
      { key: '2', count: 0 },
    ]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({});

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.',
    );
  });

  it('does not fire when at least one bucket is non-zero', async () => {
    fake.getHistogram.mockResolvedValue([
      { key: '1', count: 0 },
      { key: '2', count: 5 },
    ]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({});

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.total).toBe(5);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('sums bucket counts into total and echoes applied_filters including date_field', async () => {
    fake.getHistogram.mockResolvedValue([
      { key: '1', count: 3 },
      { key: '2', count: 4 },
    ]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ date_field: 'created' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result).toEqual({
      interval: 'month_of_year',
      buckets: [
        { key: '1', count: 3 },
        { key: '2', count: 4 },
      ],
      total: 7,
    });
    expect(getEnrichment(ctx).applied_filters).toEqual({
      quality_grade: ['research'],
      captive: false,
      date_field: 'created',
    });
  });
});

describe('bucket cap', () => {
  function buckets(n: number) {
    return Array.from({ length: n }, (_, i) => ({ key: `bucket-${i}`, count: 1 }));
  }

  it('declares truncated: false with shown/cap when there are zero buckets', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({});

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toEqual([]);
    expect(result.total).toBe(0);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 0, cap: 800 });
  });

  it('does not truncate when the bucket count sits exactly at the cap', async () => {
    fake.getHistogram.mockResolvedValue(buckets(800));
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ interval: 'day' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toHaveLength(800);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.shown).toBe(800);
    expect(enrichment.cap).toBe(800);
    expect(enrichment.notice).toBeUndefined();
  });

  it('truncates to the first 800 buckets, in upstream order, one past the cap', async () => {
    fake.getHistogram.mockResolvedValue(buckets(801));
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ interval: 'day' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toHaveLength(800);
    expect(result.buckets[0]).toEqual({ key: 'bucket-0', count: 1 });
    expect(result.buckets.at(-1)).toEqual({ key: 'bucket-799', count: 1 });
    // total sums every bucket upstream returned, including the one past the cap.
    expect(result.total).toBe(801);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(800);
    expect(enrichment.cap).toBe(800);
    expect(enrichment.notice).toContain('Narrow d1/d2');
  });

  it('carries the cap through structuredContent and content[] together', async () => {
    fake.getHistogram.mockResolvedValue(buckets(801));

    const result = await runToolContract(inaturalistGetHistogram, { interval: 'day' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 800, cap: 800 });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('across 800 buckets');
  });

  it('lets the zero-hit notice win over the truncation guidance when the full set sums to zero', async () => {
    fake.getHistogram.mockResolvedValue(buckets(801).map((bucket) => ({ ...bucket, count: 0 })));
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ interval: 'day' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.',
    );
  });
});

describe('format()', () => {
  it('renders the header line and a two-column markdown table', () => {
    const result = {
      interval: 'month_of_year' as const,
      buckets: [
        { key: '1', count: 0 },
        { key: '2', count: 5 },
      ],
      total: 5,
    };
    const [block] = inaturalistGetHistogram.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain(
      '**interval:** month_of_year · **total:** 5 observations across 2 buckets',
    );
    expect(text).toContain('| key | count |');
    expect(text).toContain('| 1 | 0 |');
    expect(text).toContain('| 2 | 5 |');
  });

  it('renders an empty table when there are no buckets at all', () => {
    const result = { interval: 'year' as const, buckets: [], total: 0 };
    const [block] = inaturalistGetHistogram.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**interval:** year · **total:** 0 observations across 0 buckets');
    expect(text).toContain('|:--|--:|');
  });
});
