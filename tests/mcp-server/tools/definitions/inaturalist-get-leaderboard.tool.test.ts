/**
 * @fileoverview Tests for inaturalist_get_leaderboard — area validation, the
 * leaderboard_window_exceeded contract at exactly the 500-entry boundary, the
 * unknown_taxon_id passthrough, zero-hit and truncation enrichment (including
 * the ceiling-reached guidance branch), and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetLeaderboard } from '@/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { LEADERBOARD_WINDOW } from '@/mcp-server/tools/observation-filters.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { leaderboardEntry } from '../../../helpers/fixtures.js';

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

function entries(count: number) {
  return Array.from({ length: count }, (_, i) => leaderboardEntry({ rank: i + 1 }));
}

describe('input validation', () => {
  it('bounds per_page and its default to the response budget, two pages covering the window', () => {
    expect(inaturalistGetLeaderboard.input.parse({ kind: 'observers' }).per_page).toBe(25);
    expect(
      inaturalistGetLeaderboard.input.safeParse({ kind: 'observers', per_page: 250 }).success,
    ).toBe(true);
    expect(
      inaturalistGetLeaderboard.input.safeParse({ kind: 'observers', per_page: 251 }).success,
    ).toBe(false);
    expect(250 * 2).toBe(LEADERBOARD_WINDOW);
  });
});

describe('area validation', () => {
  it('rejects a partial bounding box', async () => {
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      nelat: 47.7,
      nelng: -122.2,
    });

    await expect(inaturalistGetLeaderboard.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.getLeaderboard).not.toHaveBeenCalled();
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      place_id: 1,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await expect(inaturalistGetLeaderboard.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });
});

describe('the 500-entry leaderboard window', () => {
  it('allows page × per_page exactly at 500', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 5000, entries: entries(10) });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      page: 5,
      per_page: 100,
    });

    await expect(inaturalistGetLeaderboard.handler(input, ctx)).resolves.toBeDefined();
    expect(fake.getLeaderboard).toHaveBeenCalledTimes(1);
  });

  it('rejects page × per_page exactly at 501, making no upstream call', async () => {
    // per_page maxes at 500 in the schema, so 3 × 167 = 501 is the boundary
    // pair one past 500 without hitting that per-field cap.
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      page: 3,
      per_page: 167,
    });

    await expect(inaturalistGetLeaderboard.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'leaderboard_window_exceeded' },
    });
    expect(fake.getLeaderboard).not.toHaveBeenCalled();
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.getLeaderboard.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      taxon_id: 999_999_999,
    });

    await expect(inaturalistGetLeaderboard.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('zero-hit and truncation enrichment', () => {
  it('returns an empty leaderboard with the zero-hit notice', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 0, entries: [] });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({ kind: 'identifiers' });

    const result = await inaturalistGetLeaderboard.handler(input, ctx);

    expect(result).toEqual({
      kind: 'identifiers',
      count_metric: 'identifications',
      total_results: 0,
      entries: [],
    });
    expect(getEnrichment(ctx).notice).toBe(
      'Nobody has recorded observations matching those filters. Widen the date range or the area, or drop taxon_id.',
    );
  });

  it('discloses truncation with "raise page" guidance when the next page is still reachable', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 500, entries: entries(25) });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      page: 1,
      per_page: 25,
    });

    await inaturalistGetLeaderboard.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('Raise page to reach further down the ranking');
  });

  it('discloses truncation with "narrow the field" guidance once the next page would exceed the window', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 500, entries: entries(100) });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({
      kind: 'observers',
      page: 5,
      per_page: 100,
    });

    await inaturalistGetLeaderboard.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toContain('This page ends at the 500-entry ceiling');
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.getLeaderboard.mockResolvedValue({ total: 0, entries: [] });

    const result = await runToolContract(inaturalistGetLeaderboard, { kind: 'identifiers' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      entries: [],
      truncated: false,
      shown: 0,
      cap: 25,
      notice:
        'Nobody has recorded observations matching those filters. Widen the date range or the area, or drop taxon_id.',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(
      'Nobody has recorded observations matching those filters. Widen the date range or the area, or drop taxon_id.',
    );
  });

  it('reports truncated: false on a partial page that never reached per_page', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 3, entries: entries(3) });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({ kind: 'observers', per_page: 25 });

    await inaturalistGetLeaderboard.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3, cap: 25 });
  });

  it('echoes the applied quality_grade default', async () => {
    fake.getLeaderboard.mockResolvedValue({ total: 1, entries: entries(1) });
    const ctx = createMockContext({ errors: inaturalistGetLeaderboard.errors });
    const input = inaturalistGetLeaderboard.input.parse({ kind: 'observers' });

    await inaturalistGetLeaderboard.handler(input, ctx);

    expect(getEnrichment(ctx).applied_filters).toEqual({ quality_grade: ['research'] });
  });
});

describe('format()', () => {
  it('renders the header and each entry, with the species clause only on the observers arm', () => {
    const result = {
      kind: 'observers' as const,
      count_metric: 'observations' as const,
      total_results: 50_000,
      entries: [
        leaderboardEntry({ rank: 1, login: 'top_observer', count: 500, species_count: 120 }),
      ],
    };
    const [block] = inaturalistGetLeaderboard.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain(
      '**kind:** observers · **count_metric:** observations · **total_results:** 50000',
    );
    expect(text).toContain('1. **top_observer** — 500 observations · 120 species_count');
  });

  it('omits the species clause on the identifiers arm', () => {
    const result = {
      kind: 'identifiers' as const,
      count_metric: 'identifications' as const,
      total_results: 10,
      entries: [{ rank: 1, login: 'top_identifier', count: 30 }],
    };
    const [block] = inaturalistGetLeaderboard.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('1. **top_identifier** — 30 identifications');
    expect(text).not.toContain('species_count');
  });

  it('renders "login not published" for a null login', () => {
    const result = {
      kind: 'observers' as const,
      count_metric: 'observations' as const,
      total_results: 1,
      entries: [{ rank: 1, login: null, count: 5 }],
    };
    const [block] = inaturalistGetLeaderboard.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('1. **login not published** — 5 observations');
  });

  it('does not let a member login forge a heading', () => {
    const FORGERY = '## Forged heading';
    const result = {
      kind: 'observers' as const,
      count_metric: 'observations' as const,
      total_results: 1,
      entries: [{ rank: 1, login: `someone\n${FORGERY}`, count: 5 }],
    };
    const [block] = inaturalistGetLeaderboard.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text.split(/\r\n|[\r\n]/).filter((line) => line.startsWith(FORGERY))).toEqual([]);
  });
});
