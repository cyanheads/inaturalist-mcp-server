/**
 * @fileoverview Tests for inaturalist_get_species_counts — area validation,
 * the unpaired-annotation-value contract, the unknown_taxon_id passthrough,
 * the observer/project filters, absolute positions, the zero-hit, past-the-end,
 * and truncation enrichment, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
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

describe('input validation', () => {
  it('bounds per_page and its default to the response budget', () => {
    expect(inaturalistGetSpeciesCounts.input.parse({}).per_page).toBe(25);
    expect(inaturalistGetSpeciesCounts.input.safeParse({ per_page: 50 }).success).toBe(true);
    expect(inaturalistGetSpeciesCounts.input.safeParse({ per_page: 51 }).success).toBe(false);
  });
});

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

describe('ordered date range', () => {
  it('rejects d1 after d2 before any request, without a zero-hit notice', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({
      place_id: 14,
      d1: '2026-01-01',
      d2: '2025-01-01',
    });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'inverted_date_range',
        recovery: { hint: expect.stringContaining('on or before d2') },
      },
    });
    expect(fake.getSpeciesCounts).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });
});

describe('areas upstream answers with HTTP 500', () => {
  it('rejects a box whose nelat is south of swlat with no request and no retry', {
    timeout: 30_000,
  }, async () => {
    const { http, service } = failingUpstream();
    vi.mocked(getINaturalistService).mockReturnValue(service);
    http.install();
    try {
      const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
      const input = inaturalistGetSpeciesCounts.input.parse({
        nelat: 37,
        nelng: -120,
        swlat: 38,
        swlng: -121,
        per_page: 1,
      });

      await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'invalid_geography',
          recovery: { hint: expect.stringContaining('nelat at or north of swlat') },
        },
      });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });

  it('passes an antimeridian-crossing box, where nelng is west of swlng, to the service', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 1, species: species(1) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({
      nelat: 66,
      nelng: -170,
      swlat: 52,
      swlng: 170,
    });

    await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(fake.getSpeciesCounts.mock.calls[0]?.[0]).toMatchObject({
      nelat: 66,
      nelng: -170,
      swlat: 52,
      swlng: 170,
    });
  });

  it('rejects a calendar-invalid date at the schema, like a malformed one', () => {
    expect(
      inaturalistGetSpeciesCounts.input.safeParse({ place_id: 14, d1: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      inaturalistGetSpeciesCounts.input.safeParse({ place_id: 14, d1: '2026-02-28' }).success,
    ).toBe(true);
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
      'No species recorded for those filters. Set quality_grade to include "needs_id".',
    );
  });

  it('names the date range only when d1 or d2 was supplied', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 0, species: [] });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({
      d2: '1800-01-01',
      quality_grade: ['research', 'needs_id'],
    });

    await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'No species recorded for those filters. Widen or drop d1/d2.',
    );
  });

  it('names taxon_id as a candidate cause when one was supplied, on both surfaces', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 0, species: [] });

    const result = await runToolContract(inaturalistGetSpeciesCounts, {
      place_id: 14,
      taxon_id: 3,
    });

    expect(result.isError).toBeFalsy();
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      'No species recorded for those filters. Widen the area, drop taxon_id or confirm it with inaturalist_resolve_name, or set quality_grade to include "needs_id".',
    );
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('drop taxon_id or confirm it with inaturalist_resolve_name');
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

  it('reports truncated: false when the full result set fits on one page', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 3, species: species(3) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ per_page: 25, page: 1 });

    await inaturalistGetSpeciesCounts.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3, cap: 25 });
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.getSpeciesCounts.mockResolvedValue({ total: 0, species: [] });

    const result = await runToolContract(inaturalistGetSpeciesCounts, { per_page: 25 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      species: [],
      truncated: false,
      shown: 0,
      cap: 25,
      notice: 'No species recorded for those filters. Set quality_grade to include "needs_id".',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(
      'No species recorded for those filters. Set quality_grade to include "needs_id".',
    );
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

describe('a page past the end of the ranking', () => {
  it('says the page is past the end and names the last page, on both surfaces', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 99_891, species: [] });

    const result = await runToolContract(inaturalistGetSpeciesCounts, {
      place_id: 1,
      per_page: 50,
      page: 2000,
    });

    expect(result.isError).toBeFalsy();
    const expected =
      'Page 2000 is past the end: 99891 species match, so the last page holding results at per_page 50 is 1998. Request page 1998 or lower — the filters are not what emptied this page.';
    expect(result.structuredContent).toMatchObject({
      total_results: 99_891,
      species: [],
      truncated: false,
      shown: 0,
      cap: 50,
      notice: expected,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
    expect(text).not.toContain('Widen the area');
  });
});

describe('absolute position', () => {
  it('carries each row’s position on structuredContent and numbers the rendered list from it', async () => {
    fake.getSpeciesCounts.mockResolvedValue({
      total: 99_891,
      species: [
        speciesCount({ position: 7, taxon_id: 9083, common_name: 'Northern Cardinal' }),
        speciesCount({ position: 8, taxon_id: 7089, common_name: 'Canada Goose' }),
        speciesCount({ position: 9, taxon_id: 46017, common_name: 'Eastern Gray Squirrel' }),
      ],
    });

    const result = await runToolContract(inaturalistGetSpeciesCounts, {
      place_id: 1,
      per_page: 3,
      page: 3,
    });

    expect(result.isError).toBeFalsy();
    const rows = (result.structuredContent as { species: { position: number; rank: string }[] })
      .species;
    expect(rows.map((row) => row.position)).toEqual([7, 8, 9]);
    expect(rows.every((row) => row.rank === 'species')).toBe(true);
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('7. **Northern Cardinal**');
    expect(text).toContain('9. **Eastern Gray Squirrel**');
    expect(text).not.toMatch(/^1\. /m);
  });

  it('forwards page and per_page so the service can offset the positions', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 1, species: species(1) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });

    await inaturalistGetSpeciesCounts.handler(
      inaturalistGetSpeciesCounts.input.parse({ page: 3, per_page: 3 }),
      ctx,
    );

    expect(fake.getSpeciesCounts.mock.calls[0]?.[0]).toMatchObject({ page: 3, per_page: 3 });
  });
});

describe('observer and project filters', () => {
  it('forwards user_id, user_login, and project_id to species_counts', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 1, species: species(1) });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });

    await inaturalistGetSpeciesCounts.handler(
      inaturalistGetSpeciesCounts.input.parse({ user_login: 'loarie', project_id: 189155 }),
      ctx,
    );

    expect(fake.getSpeciesCounts.mock.calls[0]?.[0]).toMatchObject({
      user_login: 'loarie',
      project_id: 189155,
    });
    expect(fake.getSpeciesCounts.mock.calls[0]?.[0]?.user_id).toBeUndefined();
  });

  it('rejects user_id with user_login before any request', async () => {
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });
    const input = inaturalistGetSpeciesCounts.input.parse({ user_id: 1, user_login: 'kueda' });

    await expect(inaturalistGetSpeciesCounts.handler(input, ctx)).rejects.toMatchObject({
      data: {
        reason: 'conflicting_observer',
        recovery: { hint: expect.stringContaining('user_id or user_login') },
      },
    });
    expect(fake.getSpeciesCounts).not.toHaveBeenCalled();
  });

  it('names the observer and the project among the widening options only when supplied', async () => {
    fake.getSpeciesCounts.mockResolvedValue({ total: 0, species: [] });
    const ctx = createMockContext({ errors: inaturalistGetSpeciesCounts.errors });

    await inaturalistGetSpeciesCounts.handler(
      inaturalistGetSpeciesCounts.input.parse({ user_id: 1, project_id: 227779 }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toBe(
      'No species recorded for those filters. Drop user_id or confirm the observer with inaturalist_resolve_name, drop project_id or confirm it with inaturalist_resolve_name, or set quality_grade to include "needs_id".',
    );
  });

  it('surfaces an unknown project as unknown_project_id with the resolve_name recovery', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/species_counts\?/,
        respond: () =>
          new Response(JSON.stringify({ error: 'Unknown project_id: [999999999]', status: 422 }), {
            status: 422,
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
      const result = await runToolContract(inaturalistGetSpeciesCounts, {
        project_id: 999_999_999,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'unknown_project_id',
            recovery: { hint: expect.stringContaining('inaturalist_resolve_name type project') },
          },
        },
      });
      expect(http.calls[0]?.request.url).toContain('project_id=999999999');
    } finally {
      http.restore();
    }
  });
});

describe('request URL without the observer or project filters', () => {
  it('builds the same query string as before those filters existed', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/species_counts\?/,
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
      const result = await runToolContract(inaturalistGetSpeciesCounts, {
        place_id: 1,
        taxon_id: 3,
        page: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(http.calls[0]?.request.url).toBe(
        'https://api.inaturalist.org/v1/observations/species_counts?captive=false&page=2&per_page=25&place_id=1&quality_grade=research&taxon_id=3',
      );
    } finally {
      http.restore();
    }
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

  it('does not let a community-editable name forge a heading', () => {
    const FORGERY = '## Forged heading';
    const result = {
      total_results: 1,
      species: [
        speciesCount({
          common_name: `Monarch\n${FORGERY}`,
          name: `Danaus\r${FORGERY}`,
          rank: `species\n${FORGERY}`,
          iconic_taxon_name: `Insecta\n${FORGERY}`,
        }),
      ],
    };
    const [block] = inaturalistGetSpeciesCounts.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text.split(/\r\n|[\r\n]/).filter((line) => line.startsWith(FORGERY))).toEqual([]);
  });
});
