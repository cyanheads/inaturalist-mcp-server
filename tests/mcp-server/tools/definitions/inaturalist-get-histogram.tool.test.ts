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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
import type { QualityGrade } from '@/services/inaturalist/vocabularies.js';
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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T01:00:00Z'));
  resetFakeService(fake);
  vi.mocked(getINaturalistService).mockReturnValue(asService(fake));
});

afterEach(() => vi.useRealTimers());

describe('absolute date windows', () => {
  it.each([
    ['year', '1926-11-01'],
    ['month', '1926-11-01'],
    ['week', '2016-11-01'],
    ['day', '2025-11-01'],
    ['hour', '2026-10-25'],
  ] as const)(
    'defaults %s to a disclosed UTC calendar start without adding an upper bound',
    async (interval, start) => {
      fake.getHistogram.mockResolvedValue([]);
      const result = await runToolContract(inaturalistGetHistogram, { interval });
      expect(result.isError).toBeFalsy();
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({ d1: start, d2: undefined });
      expect(result.structuredContent).toMatchObject({
        applied_filters: { window_start: start },
        total: 0,
        notice: expect.stringContaining(`generated d1=${start}`),
      });
      const text = JSON.stringify(result.content);
      expect(text).toContain(`window_start ${start}`);
      expect(text).toContain(`generated d1=${start}`);
      expect(text).toContain('match the histogram window and other filters');
      expect(text).not.toContain('The supplied observation-date');
    },
  );

  it.each([
    ['day', '2024-02-29', '2023-02-28'],
    ['week', '2024-02-29', '2014-02-28'],
    ['year', '2000-02-29', '1900-02-28'],
    ['month', '2400-02-29', '2300-02-28'],
    ['hour', '2024-03-01', '2024-02-23'],
    ['hour', '2024-01-03', '2023-12-27'],
    ['day', '0099-05-06', '0098-05-06'],
    ['day', '0001-02-28', '0000-02-28'],
    ['day', '0000-06-01', '0000-01-01'],
    ['year', '0099-12-31', '0000-01-01'],
    ['hour', '0000-01-03', '0000-01-01'],
  ] as const)(
    'subtracts %s calendar units from %s without overflow or rejection',
    async (interval, end, start) => {
      fake.getHistogram.mockResolvedValue([]);
      const result = await runToolContract(inaturalistGetHistogram, { interval, d2: end });
      expect(result.isError).toBeFalsy();
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({ d1: start, d2: end });
      expect(result.structuredContent).toMatchObject({ applied_filters: { window_start: start } });
      expect(JSON.stringify(result.content)).toContain(`window_start ${start}`);
    },
  );

  it.each(['observed', 'created'] as const)(
    'uses only the %s family as the anchor and preserves other filters',
    async (date_field) => {
      fake.getHistogram.mockResolvedValue([{ key: '2020-01-03', count: 4 }]);
      const bounds =
        date_field === 'created'
          ? { d1: '2010-01-01', d2: '2010-12-31', created_d2: '2020-01-02' }
          : { d2: '2020-01-02', created_d1: '2010-01-01', created_d2: '2010-12-31' };
      const result = await runToolContract(inaturalistGetHistogram, {
        interval: 'day',
        date_field,
        ...bounds,
        user_id: 1,
        project_id: 185897,
      });
      expect(result.isError).toBeFalsy();
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
        ...bounds,
        [date_field === 'created' ? 'created_d1' : 'd1']: '2019-01-02',
        user_id: 1,
        project_id: 185897,
      });
      expect(result.structuredContent).toMatchObject({
        applied_filters: { window_start: '2019-01-02' },
        buckets: [{ key: '2020-01-03', count: 4 }],
      });
      expect(JSON.stringify(result.content)).toContain('2020-01-03');
    },
  );

  it.each(['observed', 'created'] as const)(
    'echoes an explicit %s start without a generated-start notice',
    async (date_field) => {
      fake.getHistogram.mockResolvedValue([{ key: '0000-01-01', count: 1 }]);
      const field = date_field === 'created' ? 'created_d1' : 'd1';
      const result = await runToolContract(inaturalistGetHistogram, {
        interval: 'year',
        date_field,
        [field]: '0000-01-01',
      });
      expect(result.isError).toBeFalsy();
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({ [field]: '0000-01-01' });
      expect(result.structuredContent).toMatchObject({
        applied_filters: { window_start: '0000-01-01' },
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(JSON.stringify(result.content)).toContain('window_start 0000-01-01');
      expect(JSON.stringify(result.content)).not.toContain('generated');
    },
  );

  it.each(['month_of_year', 'week_of_year'] as const)(
    'leaves %s seasonal bounds and enrichment unchanged',
    async (interval) => {
      fake.getHistogram.mockResolvedValue([{ key: '1', count: 2 }]);
      const result = await runToolContract(inaturalistGetHistogram, {
        interval,
        created_d2: '2020-01-02',
      });
      expect(result.isError).toBeFalsy();
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
        d1: undefined,
        created_d2: '2020-01-02',
      });
      expect(fake.getHistogram.mock.calls[0]?.[0]).not.toHaveProperty('created_d1');
      expect(result.structuredContent).not.toHaveProperty('applied_filters.window_start');
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(JSON.stringify(result.content)).not.toContain('window_start');
    },
  );

  it('treats a blank selected lower bound as unset and preserves supplied-bound zero guidance', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const result = await runToolContract(inaturalistGetHistogram, {
      interval: 'day',
      date_field: 'created',
      created_d1: '',
      created_d2: '2020-12-31',
      d1: '2010-01-01',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      created_d1: '2019-12-31',
      d1: '2010-01-01',
    });
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toContain('generated created_d1=2019-12-31');
    expect(notice).toContain('supplied observation-date d1/d2 2010-01-01…any end');
    expect(notice).toContain('upload-date created_d1/created_d2 any start…2020-12-31');
    expect(JSON.stringify(result.content)).toContain(notice);
  });

  it.each([
    { interval: 'day', d1: '2020-02-30' },
    { interval: 'hour', date_field: 'created', created_d1: '2020-01-01T01:00:00Z' },
  ])('rejects malformed dates on both surfaces before requesting: %j', async (args) => {
    const result = await Reflect.apply(runToolContract, undefined, [inaturalistGetHistogram, args]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_arguments' } },
    });
    expect(JSON.stringify(result.content)).toContain('invalid_arguments');
    expect(fake.getHistogram).not.toHaveBeenCalled();
  });

  it('anchors the generated observation start to a historical upper bound on both surfaces', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '2019-12-31', count: 2 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      interval: 'day',
      d2: '2020-12-31',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      d1: '2019-12-31',
      d2: '2020-12-31',
    });
    expect(result.structuredContent).toMatchObject({
      total: 2,
      applied_filters: { window_start: '2019-12-31' },
      notice: expect.stringContaining('d1=2019-12-31'),
    });
    expect(JSON.stringify(result.content)).toContain('window_start');
    expect(JSON.stringify(result.content)).toContain('d1=2019-12-31');
  });

  it('sends the generated upload start through the real service allowlist beside observation bounds', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/histogram\?/,
        respond: () => Response.json({ results: { day: { '2020-01-03': 2 } } }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const result = await runToolContract(inaturalistGetHistogram, {
        interval: 'day',
        date_field: 'created',
        d1: '2010-01-01',
        d2: '2021-12-31',
        created_d2: '2020-01-02',
        user_id: 1,
        project_id: 185897,
      });
      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(1);
      const query = new URL(http.calls[0]!.request.url).searchParams;
      expect(Object.fromEntries(query)).toMatchObject({
        d1: '2010-01-01',
        d2: '2021-12-31',
        created_d1: '2019-01-02',
        created_d2: '2020-01-02',
        user_id: '1',
        project_id: '185897',
      });
      expect(result.structuredContent).toMatchObject({
        applied_filters: { window_start: '2019-01-02' },
        buckets: [{ key: '2020-01-03', count: 2 }],
        total: 2,
      });
      expect(JSON.stringify(result.content)).toContain('| 2020-01-03 | 2 |');
    } finally {
      http.restore();
    }
  });

  it('returns a full 25,000-bucket range without truncation', async () => {
    fake.getHistogram.mockResolvedValue(
      Array.from({ length: 25_000 }, (_, i) => ({
        key: new Date(Date.UTC(1950, 0, i + 1)).toISOString().slice(0, 10),
        count: 1,
      })),
    );
    const result = await runToolContract(inaturalistGetHistogram, {
      interval: 'day',
      d1: '1950-01-01',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 25_000,
      shown: 25_000,
      truncated: false,
    });
    expect(JSON.stringify(result.content)).toContain('| 2018-06-12 | 1 |');
  });
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
  it('preserves independent date families and complete UTC buckets for absolute intervals', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '2020-05-02T00:00:00Z', count: 3 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      interval: 'hour',
      date_field: 'created',
      d1: '2019-01-01',
      d2: '2021-01-01',
      created_d1: '2020-05-01',
      created_d2: '2020-05-01',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      d1: '2019-01-01',
      d2: '2021-01-01',
      created_d1: '2020-05-01',
      created_d2: '2020-05-01',
    });
    expect(result.structuredContent).toMatchObject({
      buckets: [{ key: '2020-05-02T00:00:00Z', count: 3 }],
      total: 3,
    });
    expect(JSON.stringify(result.content)).toContain('| 2020-05-02T00:00:00Z | 3 |');
  });

  it('validates and forwards upload bounds without clipping upstream keys', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '2020-05-02', count: 3 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      date_field: 'created',
      created_d1: '2020-05-01',
      created_d2: '2020-05-01',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      created_d1: '2020-05-01',
      created_d2: '2020-05-01',
    });
    expect(result.structuredContent).toMatchObject({
      buckets: [{ key: '2020-05-02', count: 3 }],
      total: 3,
    });
    expect(JSON.stringify(result.content)).toContain('2020-05-02');
    expect(inaturalistGetHistogram.input.safeParse({ created_d1: '2026-02-30' }).success).toBe(
      false,
    );
    expect(inaturalistGetHistogram.input.parse({ created_d1: '' }).created_d1).toBeUndefined();
  });
  it('rejects inverted upload bounds before requesting', async () => {
    const result = await runToolContract(inaturalistGetHistogram, {
      created_d1: '2021-01-01',
      created_d2: '2020-01-01',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'inverted_date_range' } },
    });
    expect(fake.getHistogram).not.toHaveBeenCalled();
  });
  it('composes ignored empty filters with honest supplied-bound guidance', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const result = await runToolContract(inaturalistGetHistogram, {
      d1: '2020-01-01',
      created_d2: '2021-01-01',
      term_id: [],
      iconic_taxa: [],
    });
    expect(result.isError).toBeFalsy();
    const notice = String((result.structuredContent as { notice?: string }).notice);
    for (const word of ['term_id', 'iconic_taxa', 'd1/d2', 'created_d1/created_d2', 'may'])
      expect(notice).toContain(word);
    expect(notice).not.toContain('fall in');
    expect(JSON.stringify(result.content)).toContain(notice);
  });
  it('rejects d1 after d2 before any request, without a zero-hit notice', async () => {
    const args = { place_id: 14, taxon_id: 47126, d1: '2026-01-01', d2: '2025-01-01' };
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });

    await expect(
      inaturalistGetHistogram.handler(inaturalistGetHistogram.input.parse(args), ctx),
    ).rejects.toMatchObject({ data: { reason: 'inverted_date_range' } });
    expect(fake.getHistogram).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();

    const result = await runToolContract(inaturalistGetHistogram, args);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'inverted_date_range',
          recovery: { hint: expect.stringContaining('on or before d2') },
        },
      },
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
      'Every bucket is zero — no records match these filters. Relax quality_grade.',
    );
  });

  it('drops the taxon wording when taxon_id was omitted', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — no records in that area match these filters. Widen the area, or relax quality_grade.',
    );
  });

  it('keeps the taxon wording when taxon_id was set and no date range was given', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14, taxon_id: 47126 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — no records of this taxon in that area match these filters. Confirm the taxon with inaturalist_resolve_name, widen the area, or add "needs_id" to quality_grade.',
    );
  });

  it('drops the area clauses when a taxon was given without an area', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ taxon_id: 47126 });

    await inaturalistGetHistogram.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Every bucket is zero — no records of this taxon match these filters. Confirm the taxon with inaturalist_resolve_name, or add "needs_id" to quality_grade.',
    );
  });

  it('words an empty taxon histogram as no matching records, on both surfaces', async () => {
    // 135056 held 32 casual records when this was probed, all outside the default cohort.
    fake.getHistogram.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), count: 0 })),
    );
    const result = await runToolContract(inaturalistGetHistogram, { taxon_id: 135056 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).not.toContain('has no records');
    expect(notice).toContain('no records of this taxon match these filters');
    expect(notice).toContain('add "needs_id" to quality_grade');
    expect(JSON.stringify(result.content)).toContain(
      'no records of this taxon match these filters',
    );
  });

  it('offers needs_id on the taxon branch only when research grade alone was searched', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    for (const quality_grade of [['research', 'needs_id'], ['casual']] satisfies QualityGrade[][]) {
      const result = await runToolContract(inaturalistGetHistogram, {
        taxon_id: 135056,
        quality_grade,
      });
      expect((result.structuredContent as { notice: string }).notice).toBe(
        'Every bucket is zero — no records of this taxon match these filters. Confirm the taxon with inaturalist_resolve_name.',
      );
    }
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
      'Every bucket is zero — no records of this taxon in that area match the combined filters. The supplied observation-date d1/d2 2090-01-01…any end may narrow the intersection; widen or drop those bounds. Confirm the taxon with inaturalist_resolve_name, widen the area, or add "needs_id" to quality_grade.';
    expect(result.structuredContent).toMatchObject({ total: 0, notice: expected });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('observation-date d1/d2 2090-01-01…any end may narrow the intersection');
  });

  it('names the date range without taxon wording when only d2 was set', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ place_id: 14, d2: '1800-01-01' });

    await inaturalistGetHistogram.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('no records in that area match the combined filters');
    expect(notice).toContain('observation-date d1/d2 any start…1800-01-01');
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

describe('captive cohort disclosure', () => {
  const COHORT =
    'Captive and cultivated records are graded casual, so captive: true without "casual" in quality_grade matches only records whose grade disagrees with their captive flag. Add "casual" to quality_grade for captive or cultivated records.';

  it('discloses the cohort on an empty captive histogram with no quality remedy, on both surfaces', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      place_id: 1282,
      captive: true,
    });
    const expected = `${COHORT} Every bucket is zero — no records in that area match these filters. Widen the area.`;
    expect((result.structuredContent as { notice?: string }).notice).toBe(expected);
    expect(JSON.stringify(result.content)).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it('offers no needs_id hint on the taxon branch and joins the radius clamp', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 0 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      taxon_id: 47126,
      lat: 47.6,
      lng: -122.3,
      radius: 20041,
      captive: true,
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `radius 20041 was clamped to 20040. ${COHORT} Every bucket is zero — no records of this taxon in that area match these filters. Confirm the taxon with inaturalist_resolve_name, or widen the area.`,
    );
  });

  it('rides a histogram with records too', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 4 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      captive: true,
      quality_grade: ['needs_id'],
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(COHORT);
  });

  it.each([
    { captive: true, quality_grade: ['casual'] },
    { captive: false, quality_grade: ['research'] },
  ] satisfies { captive: boolean; quality_grade: QualityGrade[] }[])(
    'carries no cohort notice for %j',
    async (cohort) => {
      fake.getHistogram.mockResolvedValue([{ key: '1', count: 4 }]);
      const result = await runToolContract(inaturalistGetHistogram, cohort);
      expect(result.structuredContent).not.toHaveProperty('notice');
    },
  );
});

describe('bucket cap', () => {
  function buckets(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      key: new Date(Date.UTC(1950, 0, i + 1)).toISOString().slice(0, 10),
      count: 1,
    }));
  }

  it.each([
    ['day', 'observed', '2018-06-13', '2018-06-13'],
    ['day', 'created', '2018-06-13', '2018-06-12'],
    ['hour', 'observed', '2022-11-07T16:00:00Z', '2022-11-06'],
    ['hour', 'created', '2022-11-07T16:00:00Z', '2022-11-06'],
    ['week', 'observed', '1979-02-19', '1979-02-19'],
    ['week', 'created', '1979-02-19', '1979-02-18'],
    ['month', 'observed', '2083-05', '2083-05-01'],
    ['month', 'created', '2083-05-01', '2083-04-30'],
  ] as const)(
    'continues %s/%s at the first omitted key %s without replacing boundary counts',
    async (interval, date_field, omitted, start) => {
      const all = Array.from({ length: 25_001 }, (_, i) => {
        let key: string;
        if (interval === 'month') {
          key = `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}${omitted.length === 10 ? '-01' : ''}`;
        } else {
          const base =
            interval === 'week' ? '1500-01-01' : interval === 'hour' ? '2020-01-01' : '1950-01-01';
          const stepMs =
            interval === 'week' ? 604_800_000 : interval === 'hour' ? 3_600_000 : 86_400_000;
          const iso = new Date(Date.parse(`${base}T00:00:00Z`) + i * stepMs).toISOString();
          key = interval === 'hour' ? iso.replace('.000Z', 'Z') : iso.slice(0, 10);
        }
        return { key, count: i === 25_000 ? 7 : 1 };
      });
      fake.getHistogram.mockResolvedValue(all);
      const lower = date_field === 'created' ? 'created_d1' : 'd1';
      const upper = date_field === 'created' ? 'created_d2' : 'd2';
      const result = await runToolContract(inaturalistGetHistogram, {
        interval,
        date_field,
        [lower]: '0000-01-01',
        [upper]: '2090-12-31',
        user_id: 1,
        project_id: 185897,
        term_id: [1],
        term_value_id: [6],
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        total: 25_007,
        shown: 25_000,
        cap: 25_000,
        truncated: true,
      });
      const text = JSON.stringify(result.content);
      const notice = String((result.structuredContent as { notice?: string }).notice);
      for (const value of [
        `first omitted bucket (${omitted})`,
        `${lower}=${start}`,
        'retain all other filters and upper bounds',
        'deduplicate keys',
        'preserving counts',
        'partial',
      ]) {
        expect(notice).toContain(value);
        expect(text).toContain(value);
      }
      expect(notice).not.toContain(`${lower}=${omitted}T`);
      expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
        [lower]: '0000-01-01',
        [upper]: '2090-12-31',
        user_id: 1,
        project_id: 185897,
      });

      // A second and final slice can repeat a boundary bucket with a partial count.
      const previous = all[24_999]!;
      fake.getHistogram.mockResolvedValue([
        { key: previous.key, count: 0 },
        { key: omitted, count: 7 },
      ]);
      const next = await runToolContract(inaturalistGetHistogram, {
        interval,
        date_field,
        [lower]: start,
        [upper]: '2090-12-31',
        user_id: 1,
        project_id: 185897,
        term_id: [1],
        term_value_id: [6],
      });
      expect(next.structuredContent).toMatchObject({
        truncated: false,
        shown: 2,
        total: 7,
        buckets: [
          { key: previous.key, count: 0 },
          { key: omitted, count: 7 },
        ],
      });
      expect(JSON.stringify(next.content)).toContain(`| ${omitted} | 7 |`);
    },
  );

  it('returns an empty final slice without truncation or another continuation', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const result = await runToolContract(inaturalistGetHistogram, {
      interval: 'hour',
      date_field: 'created',
      created_d1: '2020-01-03',
      created_d2: '2020-01-03',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total: 0, shown: 0, truncated: false });
    expect(JSON.stringify(result.content)).not.toContain('first omitted');
  });

  it('declares truncated: false with shown/cap when there are zero buckets', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({});

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toEqual([]);
    expect(result.total).toBe(0);
    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 0, cap: 25_000 });
  });

  it('does not truncate when the bucket count sits exactly at the cap', async () => {
    fake.getHistogram.mockResolvedValue(buckets(25_000));
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ interval: 'day', d1: '1950-01-01' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toHaveLength(25_000);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(false);
    expect(enrichment.shown).toBe(25_000);
    expect(enrichment.cap).toBe(25_000);
    expect(enrichment.notice).toBeUndefined();
  });

  it('truncates to the first 25,000 buckets, in upstream order, one past the cap', async () => {
    fake.getHistogram.mockResolvedValue(buckets(25_001));
    const ctx = createMockContext({ errors: inaturalistGetHistogram.errors });
    const input = inaturalistGetHistogram.input.parse({ interval: 'day' });

    const result = await inaturalistGetHistogram.handler(input, ctx);

    expect(result.buckets).toHaveLength(25_000);
    expect(result.buckets[0]).toEqual({ key: '1950-01-01', count: 1 });
    expect(result.buckets.at(-1)).toEqual({ key: '2018-06-12', count: 1 });
    // total sums every bucket upstream returned, including the one past the cap.
    expect(result.total).toBe(25_001);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(25_000);
    expect(enrichment.cap).toBe(25_000);
    expect(enrichment.notice).toContain('d1=2025-11-01');
  });

  it('carries the cap through structuredContent and content[] together', async () => {
    fake.getHistogram.mockResolvedValue(buckets(25_001));

    const result = await runToolContract(inaturalistGetHistogram, { interval: 'day' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 25_000, cap: 25_000 });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('25000 buckets shown');
  });

  it('lets the zero-hit notice win over the truncation guidance when the full set sums to zero', async () => {
    fake.getHistogram.mockResolvedValue(buckets(25_001).map((bucket) => ({ ...bucket, count: 0 })));
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
      shown: 25_000,
      cap: 25_000,
      notice: expect.stringContaining(
        'Every bucket is zero — no records of this taxon in that area match the histogram window and other filters.',
      ),
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
    const result = await runToolContract(inaturalistGetHistogram, {
      taxon_id: 48662,
      term_value_id: [6],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'unpaired_annotation_value',
          recovery: { hint: expect.stringContaining('inaturalist_list_reference') },
        },
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
      'Every bucket is zero — no records of this taxon in that area match the annotation filter. Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms and taxon_id, or drop the annotation filter. Confirm the taxon with inaturalist_resolve_name, widen the area, or add "needs_id" to quality_grade.';
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
      'Every bucket is zero — no records in that area match iconic_taxa Aves, Insecta. Drop iconic_taxa or choose another group. Widen the area, or relax quality_grade.',
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
      'Every bucket is zero — no records match the combined filters. The supplied observation-date d1/d2 2090-01-01…any end may narrow the intersection; widen or drop those bounds. Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms, or drop the annotation filter. Relax quality_grade.',
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
  it('preserves the no-input URL', async () => {
    const http = createFetchMock([
      {
        match: () => true,
        respond: () => Response.json({ results: { month_of_year: { '1': 3 } } }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const result = await runToolContract(inaturalistGetHistogram, {});
      expect(result.isError).toBeFalsy();
      expect(http.calls.map((call) => call.request.url)).toEqual([
        'https://api.inaturalist.org/v1/observations/histogram?captive=false&date_field=observed&interval=month_of_year&quality_grade=research',
      ]);
    } finally {
      http.restore();
    }
  });
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

describe('observer and project scope', () => {
  it('forwards observer login and project while preserving both output surfaces', async () => {
    fake.getHistogram.mockResolvedValue([{ key: '1', count: 7 }]);
    const result = await runToolContract(inaturalistGetHistogram, {
      user_login: 'kueda',
      project_id: 185897,
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      user_login: 'kueda',
      project_id: 185897,
    });
    expect(result.structuredContent).toMatchObject({ buckets: [{ key: '1', count: 7 }], total: 7 });
    expect(JSON.stringify(result.content)).toContain('| 1 | 7 |');
  });
  it('rejects conflicting observers before requesting with recovery on both surfaces', async () => {
    const result = await runToolContract(inaturalistGetHistogram, {
      user_id: 1,
      user_login: 'kueda',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'conflicting_observer',
          recovery: { hint: expect.stringContaining('user_id or user_login') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('user_id or user_login');
    expect(fake.getHistogram).not.toHaveBeenCalled();
  });
  it('treats a blank login as absent beside a numeric observer', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const result = await runToolContract(inaturalistGetHistogram, {
      user_id: 1,
      user_login: '',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getHistogram.mock.calls[0]?.[0]).toMatchObject({
      user_id: 1,
      user_login: undefined,
    });
  });
  it.each(['unknown_user', 'unknown_project_id'] as const)(
    'declares %s recovery on both surfaces',
    async (reason) => {
      fake.getHistogram.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ValidationError, 'Unknown upstream filter.', { reason }),
      );
      const result = await runToolContract(inaturalistGetHistogram, {
        user_id: 1,
        project_id: 185897,
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: { reason, recovery: { hint: expect.stringContaining('inaturalist_resolve_name') } },
        },
      });
      expect(JSON.stringify(result.content)).toContain('inaturalist_resolve_name');
    },
  );
  it('names supplied observer and project filters when no records match on both surfaces', async () => {
    fake.getHistogram.mockResolvedValue([]);
    const result = await runToolContract(inaturalistGetHistogram, {
      user_id: 1,
      project_id: 185897,
    });
    expect(result.isError).toBeFalsy();
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toContain('user_id');
    expect(notice).toContain('project_id');
    expect(
      (result.content ?? []).map((block) => ('text' in block ? block.text : '')).join(''),
    ).toContain(notice);
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
      '**interval:** month_of_year · **total:** 5 observations in the upstream window · 2 buckets shown',
    );
    expect(text).toContain('| key | count |');
    expect(text).toContain('| 1 | 0 |');
    expect(text).toContain('| 2 | 5 |');
  });

  it('renders an empty table when there are no buckets at all', () => {
    const result = { interval: 'year' as const, buckets: [], total: 0 };
    const [block] = inaturalistGetHistogram.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain(
      '**interval:** year · **total:** 0 observations in the upstream window · 0 buckets shown',
    );
    expect(text).toContain('|:--|--:|');
  });
});
