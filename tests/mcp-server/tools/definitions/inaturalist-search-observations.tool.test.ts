/**
 * @fileoverview Tests for inaturalist_search_observations — area/annotation/
 * search_on validation, the pagination contracts (window, conflicting cursor
 * and page, cursor-forced ordering), the has_more/next_cursor edge cases on
 * both the page and cursor paths, every zero-hit notice fragment, the
 * unknown_taxon_id passthrough from the service, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-search-observations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { projectedObservation } from '../../../helpers/fixtures.js';

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

function observations(count: number, idOffset = 0) {
  return Array.from({ length: count }, (_, i) => projectedObservation({ id: idOffset + i + 1 }));
}

describe('input validation', () => {
  it('bounds per_page and its default to the response budget', () => {
    expect(inaturalistSearchObservations.input.parse({}).per_page).toBe(10);
    expect(inaturalistSearchObservations.input.safeParse({ per_page: 25 }).success).toBe(true);
    expect(inaturalistSearchObservations.input.safeParse({ per_page: 26 }).success).toBe(false);
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('rejects term_value_id supplied without term_id', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ term_value_id: [6] });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unpaired_annotation_value' },
    });
  });

  it('rejects search_on supplied without q', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ search_on: 'names' });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'search_on_without_query' },
    });
  });

  it('rejects page and cursor supplied together', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 1, cursor: '12345' });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_pagination' },
    });
  });

  it('treats a blank cursor from a form client as unset, so page does not conflict with it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 2, cursor: '' });

    expect(input.cursor).toBeUndefined();
    await expect(inaturalistSearchObservations.handler(input, ctx)).resolves.toBeDefined();

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.page).toBe(2);
    expect(params.id_below).toBeUndefined();
  });

  it('treats a blank q from a form client as unset, so search_on is not required', async () => {
    const input = inaturalistSearchObservations.input.parse({ q: '', d1: '' });

    expect(input.q).toBeUndefined();
    expect(input.d1).toBeUndefined();
  });

  it('rejects page × per_page past the 10,000-result window', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 501, per_page: 20 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'result_window_exceeded' },
    });
  });

  it('allows page × per_page exactly at the 10,000-result window', async () => {
    fake.searchObservations.mockResolvedValue({ total: 10_000, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 500, per_page: 20 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).resolves.toBeDefined();
  });
});

describe('cursor format validation', () => {
  it('accepts a positive-integer cursor', () => {
    const result = inaturalistSearchObservations.input.safeParse({ cursor: '401666942' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe('401666942');
  });

  it('treats a blank cursor as unset rather than rejecting it', () => {
    const result = inaturalistSearchObservations.input.safeParse({ cursor: '' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeUndefined();
  });

  it('rejects zero and a leading-zero cursor — observation ids start at 1', () => {
    expect(inaturalistSearchObservations.input.safeParse({ cursor: '0' }).success).toBe(false);
    expect(inaturalistSearchObservations.input.safeParse({ cursor: '007' }).success).toBe(false);
  });

  it('rejects a non-numeric cursor at the schema, before the handler or the service ever sees it', async () => {
    expect(inaturalistSearchObservations.input.safeParse({ cursor: 'notanumber' }).success).toBe(
      false,
    );

    const result = await runToolContract(inaturalistSearchObservations, {
      cursor: 'notanumber',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });
});

describe('cursor forces id ordering', () => {
  it('sends order_by id / order desc under a cursor regardless of the requested ordering', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      cursor: '401666942',
      order_by: 'votes',
      order: 'asc',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.order_by).toBe('id');
    expect(params.order).toBe('desc');
    expect(params.id_below).toBe('401666942');
    expect(params.page).toBeUndefined();

    expect(getEnrichment(ctx).applied_filters).toMatchObject({
      order_by: 'id',
      order: 'desc',
      ordering_forced_by_cursor: true,
    });
  });

  it('sends the requested ordering and page on the page path', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ order_by: 'votes', order: 'asc' });

    await inaturalistSearchObservations.handler(input, ctx);

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.order_by).toBe('votes');
    expect(params.order).toBe('asc');
    expect(params.page).toBe(1);
    expect(params.id_below).toBeUndefined();
    expect(getEnrichment(ctx).applied_filters).toMatchObject({ ordering_forced_by_cursor: false });
  });
});

describe('has_more / next_cursor', () => {
  it('continues on the page path when the page is full and more remain by total', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 1, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(String(20));
    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('stops on the page path when a full page exactly reaches the reported total', async () => {
    fake.searchObservations.mockResolvedValue({ total: 40, observations: observations(20, 20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 2, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it('continues under a cursor whenever the page is full, independent of total', async () => {
    fake.searchObservations.mockResolvedValue({ total: 2, observations: observations(2) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ cursor: '99', per_page: 2 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(String(2));
  });

  it('reports has_more: false with no next_cursor on an empty result', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({});

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result).toEqual({ total_results: 0, observations: [], has_more: false });
  });
});

describe('zero-hit notice composition', () => {
  it('names both default filters when neither was overridden', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({});

    await inaturalistSearchObservations.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Only research-grade records were searched.');
    expect(notice).toContain('Captive and cultivated records were excluded.');
  });

  it('names the date range when the defaults were widened', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
      d1: '2026-01-01',
      d2: '2026-01-31',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No sightings fall in 2026-01-01…2026-01-31.');
    expect(notice).not.toContain('Only research-grade records were searched.');
  });

  it('names the annotation filter when a term_id was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
      term_id: [1],
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('No sightings carry that annotation.');
  });

  it('names the radius when an area radius was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('No sightings within 10 km of that point.');
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });

    const result = await runToolContract(inaturalistSearchObservations, {
      quality_grade: ['research', 'needs_id'],
      captive: true,
      per_page: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [],
      has_more: false,
      truncated: false,
      shown: 0,
      cap: 5,
      notice:
        'No sightings matched. Relax one filter at a time — taxon_id and the date range are the usual culprits.',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No sightings matched. Relax one filter at a time');
  });

  it('reports truncated: false on a partial page that never reached per_page', async () => {
    fake.searchObservations.mockResolvedValue({ total: 3, observations: observations(3) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ per_page: 20 });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3, cap: 20 });
  });

  it('falls back to the generic notice when no specific condition applies', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'No sightings matched. Relax one filter at a time — taxon_id and the date range are the usual culprits.',
    );
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.searchObservations.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('format()', () => {
  it('renders the summary header line and each observation', () => {
    const result = {
      total_results: 4_660_480,
      observations: [projectedObservation()],
      next_cursor: '401617560',
      has_more: true,
    };
    const [block] = inaturalistSearchObservations.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**total_results:** 4660480 (upstream estimate)');
    expect(text).toContain('**returned:** 1');
    expect(text).toContain('**has_more:** true');
    expect(text).toContain('**next_cursor:** 401617560');
    expect(text).toContain('## Monarch (Danaus plexippus)');
  });

  it('renders next_cursor as "none" when absent', () => {
    const result = { total_results: 0, observations: [], has_more: false };
    const [block] = inaturalistSearchObservations.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**next_cursor:** none');
  });
});
