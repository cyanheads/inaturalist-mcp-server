/**
 * @fileoverview Tests for inaturalist_get_histogram — area validation, the
 * unknown_taxon_id passthrough, the annotation and iconic-group filters, the
 * every-bucket-zero notice, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-histogram.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
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

describe('ordered date range', () => {
  it('rejects d1 after d2 before any request, without a zero-hit notice', async () => {
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({
      place_id: 14,
      taxon_id: 47126,
      d1: '2026-01-01',
      d2: '2025-01-01',
    });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'inverted_date_range',
        recovery: { hint: expect.stringContaining('on or before d2') },
      },
    });
    expect(fake.getHistogram).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();
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
      'Every bucket is zero — nothing is recorded. Relax quality_grade or captive.',
    );
  });

  it('drops the taxon wording when taxon_id was omitted', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — nothing is recorded in that area. Widen the area, or relax quality_grade or captive.',
    );
  });

  it('keeps the taxon wording when taxon_id was set and no date range was given', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14, taxon_id: 47126 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.',
    );
  });

  it('drops the area clauses when a taxon was given without an area', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ taxon_id: 47126 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — this taxon has no records. Confirm the taxon with inaturalist_resolve_name.',
    );
  });

  it('names the date range when d1 or d2 was set, on both surfaces', async () => {
    fake.getHistogram.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), count: 0 })),
    );

    const result = await runToolContract(inaturalistGetHistogram, {
      place_id: 14,
      taxon_id: 47126,
      d1: '2090-01-01',
    });

    expect(result.isError).toBeFalsy();
    const expected =
      'Every bucket is zero — no records of this taxon in that area fall in 2090-01-01…any end. Widen or drop d1/d2. Confirm the taxon with inaturalist_resolve_name, or widen the area.';
    expect(result.structuredContent).toMatchObject({ total: 0, notice: expected });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('fall in 2090-01-01…any end. Widen or drop d1/d2.');
  });

  it('names the date range without taxon wording when only d2 was set', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14, d2: '1800-01-01' });

    await inaturalistGetHistogram.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('no records in that area fall in any start…1800-01-01');
    expect(notice).not.toContain('this taxon');
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
    const input = inaturalistGetHistogram.input.parse({
      interval: 'day',
      place_id: 14,
      taxon_id: 47126,
    });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.total).toBe(0);
    expect(getEnrichment(ctx)).toMatchObject({
      truncated: true,
      shown: 800,
      cap: 800,
      notice:
        'Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.',
    });
  });
});

describe('annotation and iconic-group filters', () => {
  it('forwards term_id, term_value_id, and iconic_taxa to the service', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 721 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });

    await inaturalistGetHistogram.handler(
      inaturalistGetHistogram.input.parse({
        taxon_id: 48662,
        place_id: 14,
        term_id: [1],
        term_value_id: [6],
        iconic_taxa: ['Insecta'],
      }),
      ctx,
    );

    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      term_id: [1],
      term_value_id: [6],
      iconic_taxa: ['Insecta'],
    });
  });

  it('rejects term_value_id without term_id before any request', async () => {
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ taxon_id: 48662, term_value_id: [6] });

    await expect(inaturalistGetHistogram.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'unpaired_annotation_value',
        recovery: { hint: expect.stringContaining('inaturalist_list_reference') },
      },
    });
    expect(fake.getHistogram).not.toHaveBeenCalled();
  });

  it('rejects an iconic group outside the spec values at the schema', () => {
    expect(inaturalistGetHistogram.input.safeParse({ iconic_taxa: ['Birds'] }).success).toBe(false);
  });

  it('names the annotation filter when it emptied every bucket, on both surfaces', async () => {
    fake.getHistogram.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), count: 0 })),
    );

    const result = await runToolContract(inaturalistGetHistogram, {
      taxon_id: 48662,
      place_id: 14,
      term_id: [1],
      term_value_id: [13],
    });

    expect(result.isError).toBeFalsy();
    const expected =
      'Every bucket is zero — no records of this taxon in that area match the annotation filter. Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms and taxon_id, or drop the annotation filter. Confirm the taxon with inaturalist_resolve_name, or widen the area.';
    expect(result.structuredContent).toMatchObject({ total: 0, notice: expected });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
  });

  it('names the iconic groups when they emptied every bucket', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });

    await inaturalistGetHistogram.handler(
      inaturalistGetHistogram.input.parse({ place_id: 14, iconic_taxa: ['Aves', 'Insecta'] }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — no records in that area match iconic_taxa Aves, Insecta. Drop iconic_taxa or choose another group. Widen the area, or relax quality_grade or captive.',
    );
  });

  it('keeps the date range as the finding and adds the annotation check when both were given', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });

    await inaturalistGetHistogram.handler(
      inaturalistGetHistogram.input.parse({ d1: '2090-01-01', term_id: [12] }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — no records fall in 2090-01-01…any end. Widen or drop d1/d2. Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms, or drop the annotation filter. Relax quality_grade or captive.',
    );
  });

  it('sends the three filters upstream beside the defaults', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/histogram\?/,
        respond: () => Response.json({ results: { month_of_year: { '1': 721 } } }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const result = await runToolContract(inaturalistGetHistogram, {
        taxon_id: 48662,
        place_id: 14,
        term_id: [1],
        term_value_id: [6],
        iconic_taxa: ['Insecta'],
      });

      expect(result.isError).toBeFalsy();
      const params = new URL(http.calls[0]?.request.url ?? '').searchParams;
      expect(params.get('term_id')).toBe('1');
      expect(params.get('term_value_id')).toBe('6');
      expect(params.get('iconic_taxa')).toBe('Insecta');
    } finally {
      http.restore();
    }
  });
});

describe('request URL without the annotation or iconic filters', () => {
  it('builds the same query string as before those filters existed', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/histogram\?/,
        respond: () => Response.json({ results: { month_of_year: { '1': 3 } } }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const result = await runToolContract(inaturalistGetHistogram, {
        taxon_id: 48662,
        place_id: 14,
      });

      expect(result.isError).toBeFalsy();
      expect(http.calls[0]?.request.url).toBe(
        'https://api.inaturalist.org/v1/observations/histogram?captive=false&date_field=observed&interval=month_of_year&place_id=14&quality_grade=research&taxon_id=48662',
      );
    } finally {
      http.restore();
    }
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
