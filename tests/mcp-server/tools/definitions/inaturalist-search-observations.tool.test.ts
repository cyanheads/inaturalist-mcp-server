/**
 * @fileoverview Tests for inaturalist_search_observations — area/annotation/
 * search_on validation, the pagination contracts (window, conflicting cursor
 * and page, cursor-forced ordering), the has_more/next_cursor edge cases on
 * both the page and cursor paths — next_cursor only under id desc, and an
 * id-descending walk through the real service — the past-the-end notice, every
 * zero-hit notice fragment, the observer/project and licence-code filters, the
 * unknown_taxon_id and unknown_user passthroughs, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-search-observations.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
import { failingUpstream } from '../../../helpers/failing-upstream.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import {
  projectedObservation,
  rawIdentification,
  rawObservation,
} from '../../../helpers/fixtures.js';

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

  it('rejects page × per_page past the 10,000-result window, routing to an id-descending cursor walk', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 501, per_page: 20 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'result_window_exceeded',
        recovery: {
          hint: expect.stringContaining(
            're-run with order_by "id" and order "desc", then pass each page\'s next_cursor as cursor',
          ),
        },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('allows page × per_page exactly at the 10,000-result window', async () => {
    fake.searchObservations.mockResolvedValue({ total: 10_000, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 500, per_page: 20 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).resolves.toBeDefined();
  });
});

describe('ordered pairs', () => {
  it('rejects an hrank finer than lrank before any request, without a zero-hit notice', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      hrank: 'family',
      lrank: 'order',
    });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'inverted_rank_range',
        recovery: { hint: expect.stringContaining('coarser rank') },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('rejects d1 after d2 before any request, without a zero-hit notice', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      taxon_id: 48662,
      d1: '2026-01-01',
      d2: '2025-01-01',
    });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'inverted_date_range',
        recovery: { hint: expect.stringContaining('on or before d2') },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('sends equal rank and date pairs through unchanged', async () => {
    fake.searchObservations.mockResolvedValue({ total: 1, observations: observations(1) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      hrank: 'family',
      lrank: 'family',
      d1: '2025-06-15',
      d2: '2025-06-15',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({
      hrank: 'family',
      lrank: 'family',
      d1: '2025-06-15',
      d2: '2025-06-15',
    });
  });

  it('sends a correctly ordered range through', async () => {
    fake.searchObservations.mockResolvedValue({ total: 1, observations: observations(1) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      hrank: 'order',
      lrank: 'family',
      d1: '2025-01-01',
      d2: '2026-01-01',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({
      hrank: 'order',
      lrank: 'family',
      d1: '2025-01-01',
      d2: '2026-01-01',
    });
  });

  it('rejects a calendar-invalid date at the schema, like a malformed one', () => {
    expect(inaturalistSearchObservations.input.safeParse({ d1: '2026-02-30' }).success).toBe(false);
    expect(inaturalistSearchObservations.input.safeParse({ d2: '2025-13-01' }).success).toBe(false);
  });
});

describe('areas upstream answers with HTTP 500', () => {
  /**
   * The real service runs here against an upstream that answers 500, so a
   * missing check shows up as fetch attempts (four, with the retries) and a
   * service error in place of invalid_geography.
   */
  it('rejects radius 0 as invalid_geography with no request and no retry', {
    timeout: 30_000,
  }, async () => {
    const { http, service } = failingUpstream();
    vi.mocked(getINaturalistService).mockReturnValue(service);
    http.install();
    try {
      const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
      const input = inaturalistSearchObservations.input.parse({
        lat: 37,
        lng: -120,
        radius: 0,
        per_page: 1,
      });

      await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'invalid_geography',
          recovery: { hint: expect.stringContaining('radius above 0') },
        },
      });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });
});

describe('non-positive radius on the wire', () => {
  it('fails a negative radius as invalid_geography with the area hint, not a schema error', async () => {
    const result = await runToolContract(inaturalistSearchObservations, {
      lat: 37,
      lng: -120,
      radius: -1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_geography' },
      },
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(
      'radius must be greater than 0 kilometres; -1 was supplied. Upstream fails on a radius of 0 or less',
    );
    expect(text).toContain('a radius above 0');
    expect(fake.searchObservations).not.toHaveBeenCalled();
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
  it('issues no next_cursor under the default ordering, pointing at the next page instead', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 1, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBe('More records match. Raise page to 2 to continue.');
  });

  it('issues next_cursor on the page path when the applied ordering is id desc', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 1,
      per_page: 20,
      order_by: 'id',
      order: 'desc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(String(20));
    expect(getEnrichment(ctx).notice).toContain('Pass cursor "20" to continue');
  });

  it('issues no next_cursor under id asc — only id_below is sent, so a cursor would walk backwards', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 3,
      per_page: 20,
      order_by: 'id',
      order: 'asc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBe('More records match. Raise page to 4 to continue.');
  });

  it('points a non-id ordering at order_by id / order desc when the next page would pass the 10,000 window', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: observations(25) });

    const result = await runToolContract(inaturalistSearchObservations, {
      page: 400,
      per_page: 25,
      order_by: 'votes',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ has_more: true, truncated: true, shown: 25, cap: 25 });
    expect(structured).not.toHaveProperty('next_cursor');
    const expected =
      'This page ends at the 10,000-result window upstream serves, and no cursor continues order_by "votes", order "desc". To continue past it, re-run with order_by "id" and order "desc" and follow next_cursor, or narrow the filters.';
    expect(structured.notice).toBe(expected);
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
    expect(text).toContain('**next_cursor:** none');
  });

  it('names the direction at the window edge under id asc, so the re-run to id desc reads as a change', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: observations(25) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 400,
      per_page: 25,
      order_by: 'id',
      order: 'asc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.next_cursor).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBe(
      'This page ends at the 10,000-result window upstream serves, and no cursor continues order_by "id", order "asc". To continue past it, re-run with order_by "id" and order "desc" and follow next_cursor, or narrow the filters.',
    );
  });

  it('keeps the cursor guidance at the window edge under id desc, since the cursor is the way past it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: observations(25) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 400,
      per_page: 25,
      order_by: 'id',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.next_cursor).toBe(String(25));
    expect(getEnrichment(ctx).notice).toContain('Pass cursor "25" to continue');
  });

  it('stops on the page path when a full page exactly reaches the reported total', async () => {
    fake.searchObservations.mockResolvedValue({ total: 40, observations: observations(20, 20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 2, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it('omits next_cursor on an exactly full final page under id desc too', async () => {
    fake.searchObservations.mockResolvedValue({ total: 40, observations: observations(20, 20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 2,
      per_page: 20,
      order_by: 'id',
    });

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
    // No taxon_id and no area were given, so neither is named.
    expect(notice).not.toContain('taxon');
    expect(notice).not.toContain('here');
  });

  it('names taxon_id in the fallback only when it was supplied, and never the absent date range', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
      taxon_id: 47126,
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'No sightings matched. Relax one filter at a time. Confirm taxon_id with inaturalist_resolve_name, or drop it.',
    );
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

    expect(getEnrichment(ctx).notice).toBe(
      'No sightings carry that annotation. Check the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.',
    );
  });

  it('points the annotation check at the taxon only when taxon_id was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      quality_grade: ['research', 'needs_id'],
      captive: true,
      taxon_id: 47126,
      term_id: [1],
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'No sightings carry that annotation. Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.',
    );
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
      notice: 'No sightings matched. Relax one filter at a time.',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No sightings matched. Relax one filter at a time.');
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

    expect(getEnrichment(ctx).notice).toBe('No sightings matched. Relax one filter at a time.');
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

/**
 * The exact URL a call builds, through the real service and allowlist behind a
 * strict fetch mock — so a new filter left unset is proven never to reach the
 * query string.
 */
async function capturedSearchUrl(args: Record<string, unknown>): Promise<string> {
  const http = createFetchMock([
    {
      match: /api\.inaturalist\.org\/v1\/observations\?/,
      respond: () => Response.json({ total_results: 0, results: [] }),
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
    const result = await runToolContract(inaturalistSearchObservations, args);
    expect(result.isError).toBeFalsy();
    return http.calls[0]?.request.url ?? '';
  } finally {
    http.restore();
  }
}

describe('an id-descending walk through the real service', () => {
  /**
   * Upstream stand-in over ids 1–30: `id_below` filters and re-counts, `page`
   * offsets, and ordering is id descending — the one ordering a cursor
   * continues. The walk starts on the page path and continues by cursor, so
   * both halves of the handoff are exercised past the first hop.
   */
  function idDescendingUpstream() {
    const ids = Array.from({ length: 30 }, (_, i) => 30 - i);
    return createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: (request) => {
          const url = new URL(request.url);
          const perPage = Number(url.searchParams.get('per_page'));
          const below = url.searchParams.get('id_below');
          const matching = below === null ? ids : ids.filter((id) => id < Number(below));
          const offset = below === null ? (Number(url.searchParams.get('page')) - 1) * perPage : 0;
          return Response.json({
            total_results: matching.length,
            results: matching
              .slice(offset, offset + perPage)
              .map((id) => rawObservation({ id, identifications: [] })),
          });
        },
      },
    ]);
  }

  it('reaches every record once, in order, from page 1 through two cursor hops', async () => {
    const http = idDescendingUpstream();
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
      const seen: number[] = [];
      let args: Record<string, unknown> = { order_by: 'id', order: 'desc', per_page: 10 };
      for (let hop = 0; hop < 3; hop += 1) {
        const result = await runToolContract(inaturalistSearchObservations, args);
        const structured = result.structuredContent as {
          observations: { id: number }[];
          next_cursor?: string;
        };
        seen.push(...structured.observations.map((o) => o.id));
        expect(structured.next_cursor).toBe(String(seen.at(-1)));
        args = { cursor: structured.next_cursor, per_page: 10 };
      }

      expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
      expect(
        http.calls.map((call) => new URL(call.request.url).searchParams.get('id_below')),
      ).toEqual([null, '21', '11']);
    } finally {
      http.restore();
    }
  });
});

describe('a page past the end of the results', () => {
  it('says the page is past the end and names the last page, rather than blaming the filters', async () => {
    fake.searchObservations.mockResolvedValue({ total: 93, observations: [] });

    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1,
      taxon_id: 48662,
      d1: '2020-07-01',
      d2: '2020-07-01',
      per_page: 25,
      page: 40,
    });

    expect(result.isError).toBeFalsy();
    const expected =
      'Page 40 is past the end: 93 records match, so the last page holding results at per_page 25 is 4. Request page 4 or lower — the filters are not what emptied this page.';
    expect(result.structuredContent).toMatchObject({
      total_results: 93,
      observations: [],
      has_more: false,
      truncated: false,
      shown: 0,
      notice: expected,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
    expect(text).not.toContain('No sightings fall in');
  });

  it('names page 1 as the last page when every match fits on it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 3, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ per_page: 25, page: 2 });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain(
      'Page 2 is past the end: 3 records match, so the last page holding results at per_page 25 is 1.',
    );
  });
});

describe('request URL without the observer, project, or licence filters', () => {
  it('builds the same query string as before those filters existed', async () => {
    expect(await capturedSearchUrl({ place_id: 1, taxon_id: 48662, licensed: true })).toBe(
      'https://api.inaturalist.org/v1/observations?captive=false&licensed=true&order=desc&order_by=observed_on&page=1&per_page=10&place_id=1&quality_grade=research&taxon_id=48662',
    );
  });
});

describe('observer and project filters', () => {
  it('sends user_id, user_login, and project_id upstream, one observer form at a time', async () => {
    expect(await capturedSearchUrl({ user_login: 'kueda', project_id: 227779 })).toBe(
      'https://api.inaturalist.org/v1/observations?captive=false&order=desc&order_by=observed_on&page=1&per_page=10&project_id=227779&quality_grade=research&user_login=kueda',
    );
    expect(await capturedSearchUrl({ user_id: 1 })).toContain('&user_id=1');
  });

  it('treats a blank user_login from a form client as unset, never sending it', async () => {
    const input = inaturalistSearchObservations.input.parse({ user_login: '' });
    expect(input.user_login).toBeUndefined();
    expect(await capturedSearchUrl({ user_login: '' })).not.toContain('user_login');
  });

  it('rejects user_id with user_login before any request, since a mismatched pair returns nothing', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ user_id: 1, user_login: 'loarie' });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'conflicting_observer',
        recovery: { hint: expect.stringContaining('user_id or user_login') },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('names the observer and the project in the zero-hit notice only when each was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const withBoth = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        quality_grade: ['research', 'needs_id'],
        captive: true,
        user_login: 'kueda',
        project_id: 227779,
      }),
      withBoth,
    );

    expect(getEnrichment(withBoth).notice).toBe(
      'No sightings by that observer match the other filters. Confirm user_login with inaturalist_resolve_name type user, or drop it. No sightings in that project match the other filters. Confirm project_id with inaturalist_resolve_name type project, or drop it.',
    );

    const withNeither = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        quality_grade: ['research', 'needs_id'],
        captive: true,
      }),
      withNeither,
    );
    expect(getEnrichment(withNeither).notice).not.toMatch(/observer|project/);
  });

  it('names user_id rather than user_login when the observer was given by id', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        quality_grade: ['research', 'needs_id'],
        captive: true,
        user_id: 1,
      }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toContain('Confirm user_id with inaturalist_resolve_name');
  });

  it('surfaces an unknown observer as unknown_user with the resolve_name recovery, on both surfaces', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () =>
          new Response(
            JSON.stringify({ error: 'Unknown user_id zz-no-such-login-xq9', status: 422 }),
            { status: 422 },
          ),
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
      const result = await runToolContract(inaturalistSearchObservations, {
        user_login: 'zz-no-such-login-xq9',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'unknown_user',
            recovery: { hint: expect.stringContaining('inaturalist_resolve_name') },
          },
        },
      });
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('');
      expect(text).toContain('inaturalist_resolve_name');
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

describe('licence-code filters', () => {
  it('sends license and photo_license upstream as comma-joined OR lists', async () => {
    const url = await capturedSearchUrl({ license: ['cc-by', 'cc0'], photo_license: ['cc0'] });
    const params = new URL(url).searchParams;

    expect(params.get('license')).toBe('cc-by,cc0');
    expect(params.get('photo_license')).toBe('cc0');
  });

  it('lowercases a case variant before the enum, the way upstream reads it', () => {
    const input = inaturalistSearchObservations.input.parse({
      license: ['CC0', 'CC-BY'],
      photo_license: ['Cc-By-Nc'],
    });

    expect(input.license).toEqual(['cc0', 'cc-by']);
    expect(input.photo_license).toEqual(['cc-by-nc']);
  });

  it('rejects a value outside the seven codes at the schema — upstream narrows it to zero', () => {
    for (const value of ['null', 'bogus', 'cc_by', '']) {
      expect(inaturalistSearchObservations.input.safeParse({ license: [value] }).success).toBe(
        false,
      );
      expect(
        inaturalistSearchObservations.input.safeParse({ photo_license: [value] }).success,
      ).toBe(false);
    }
  });

  it('leaves the licensed and photo_licensed booleans working beside the codes', async () => {
    const params = new URL(
      await capturedSearchUrl({ licensed: true, photo_licensed: true, license: ['cc0'] }),
    ).searchParams;

    expect(params.get('licensed')).toBe('true');
    expect(params.get('photo_licensed')).toBe('true');
    expect(params.get('license')).toBe('cc0');
  });
});

/**
 * Search records never carry the by-id detail arm. This runs the real service
 * and projection behind a strict fetch mock with an upstream record that holds a
 * description, many filled observation fields, and a long thread, and checks
 * none of it reaches either surface of a search reply.
 */
describe('search records stay free of the by-id detail fields', () => {
  it('carries no description, observation fields, or thread counts, and renders none of them', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () =>
          Response.json({
            total_results: 1,
            results: [
              rawObservation({
                id: 5890862,
                description: 'Confirm?',
                ofvs: Array.from({ length: 60 }, (_, i) => ({ name: `Field ${i}`, value: 'x' })),
                identifications: Array.from({ length: 60 }, (_, i) =>
                  rawIdentification({ id: i + 1 }),
                ),
              }),
            ],
          }),
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
      const result = await runToolContract(inaturalistSearchObservations, { place_id: 46 });

      expect(result.isError).toBeFalsy();
      const [record] = (result.structuredContent as { observations: Record<string, unknown>[] })
        .observations;
      for (const key of [
        'description',
        'observation_fields',
        'observation_fields_total',
        'observation_fields_shown',
        'identifications',
        'identifications_total',
        'identifications_shown',
        'comments_total',
      ]) {
        expect(record).not.toHaveProperty(key);
      }
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(text).not.toContain('Observer’s description');
      expect(text).not.toContain('### Observation fields');
      expect(text).not.toContain('### Identification thread');
    } finally {
      http.restore();
    }
  });
});
