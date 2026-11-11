/** @fileoverview Query filter and upstream-error contracts across area tools. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import { inaturalistGetLeaderboard } from '@/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { inaturalistGetSimilarSpecies } from '@/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
import { inaturalistListReference } from '@/mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import { inaturalistResolveName } from '@/mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';

vi.mock('@/services/inaturalist/inaturalist-service.js', async (original) => ({
  ...(await original<typeof import('@/services/inaturalist/inaturalist-service.js')>()),
  getINaturalistService: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getINaturalistService).mockReturnValue(
    new INaturalistService({
      userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
      minRequestIntervalMs: 0,
      maxConcurrentRequests: 4,
      dailyRequestBudget: 1000,
    }),
  );
});

const areaCalls = [
  ['search', () => runToolContract(inaturalistSearchObservations, { place_id: 99999999 })],
  ['species', () => runToolContract(inaturalistGetSpeciesCounts, { place_id: 99999999 })],
  ['histogram', () => runToolContract(inaturalistGetHistogram, { place_id: 99999999 })],
  [
    'observers',
    () => runToolContract(inaturalistGetLeaderboard, { kind: 'observers', place_id: 99999999 }),
  ],
  [
    'identifiers',
    () => runToolContract(inaturalistGetLeaderboard, { kind: 'identifiers', place_id: 99999999 }),
  ],
  [
    'similar',
    () => runToolContract(inaturalistGetSimilarSpecies, { taxon_id: 48662, place_id: 99999999 }),
  ],
] as const;

describe('unknown place recovery', () => {
  it.each(areaCalls)(
    '%s preserves the typed service failure and adds discovery guidance',
    async (_name, call) => {
      const http = createFetchMock([
        {
          match: /api\.inaturalist\.org/,
          respond: () =>
            Response.json({ error: 'Unknown place_id 99999999', status: 422 }, { status: 422 }),
        },
      ]);
      http.install();
      try {
        const result = await call();
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'unknown_place_id',
              retryable: false,
              recovery: { hint: expect.stringContaining('inaturalist_find_places') },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain('inaturalist_find_places');
        expect(JSON.stringify(result)).not.toContain('responseBody');
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
    },
  );
});

describe('daily request budget', () => {
  const RECOVERY =
    'The upstream daily request allowance is spent; retry after the next UTC midnight, or raise INATURALIST_DAILY_REQUEST_BUDGET only if this deployment does not share an egress IP.';
  const definitions = {
    search: inaturalistSearchObservations,
    species: inaturalistGetSpeciesCounts,
    histogram: inaturalistGetHistogram,
    observers: inaturalistGetLeaderboard,
    identifiers: inaturalistGetLeaderboard,
    similar: inaturalistGetSimilarSpecies,
  } as const;

  it.each(areaCalls)('%s declares rate_budget_exhausted as a service reason', (name) => {
    expect(
      definitions[name].errors?.find((entry) => entry.reason === 'rate_budget_exhausted'),
    ).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      retryable: false,
      thrownBy: 'service',
      recovery: RECOVERY,
    });
  });

  it.each(areaCalls)(
    '%s fails a call past the budget as -32003 with the recovery, on both surfaces',
    async (_name, call) => {
      vi.mocked(getINaturalistService).mockReturnValue(
        new INaturalistService({
          userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
          minRequestIntervalMs: 0,
          maxConcurrentRequests: 4,
          dailyRequestBudget: 1,
        }),
      );
      const http = createFetchMock([
        {
          match: /api\.inaturalist\.org/,
          respond: (request) =>
            Response.json(
              new URL(request.url).pathname.endsWith('/histogram')
                ? { results: { month_of_year: {} } }
                : { total_results: 0, results: [] },
            ),
        },
      ]);
      http.install();
      try {
        expect((await call()).isError).toBeFalsy();
        const spent = await call();
        expect(spent.isError).toBe(true);
        expect(spent.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.RateLimited,
            data: {
              reason: 'rate_budget_exhausted',
              retryable: false,
              recovery: { hint: RECOVERY },
            },
          },
        });
        expect(JSON.stringify(spent.content)).toContain('INATURALIST_DAILY_REQUEST_BUDGET');
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
    },
  );
});

describe('search filters on the wire', () => {
  it.each([
    [inaturalistSearchObservations, {}, ['hrank', 'lrank', 'search_on', 'order_by', 'order']],
    [inaturalistGetHistogram, {}, ['date_field', 'interval']],
    [inaturalistResolveName, { q: 'monarch' }, ['rank', 'type']],
  ] as const)(
    'treats untouched optional enum dropdowns as omitted for $name',
    async (definition, extra, fields) => {
      const http = createFetchMock([
        {
          match: /./,
          respond: (request) =>
            Response.json(
              new URL(request.url).pathname.endsWith('/histogram')
                ? { results: { month_of_year: {} } }
                : { total_results: 0, results: [] },
            ),
        },
      ]);
      http.install();
      try {
        const omitted = await runToolContract(definition, extra);
        const blank = await runToolContract(definition, {
          ...extra,
          ...Object.fromEntries(fields.map((field) => [field, ''])),
        });
        expect(blank.isError).toBeFalsy();
        expect(blank.structuredContent).toEqual(omitted.structuredContent);
        expect(blank.content).toEqual(omitted.content);
        expect(http.calls).toHaveLength(2);
        expect(http.calls.at(-1)!.request.url).toBe(http.calls[0]!.request.url);
      } finally {
        http.restore();
      }
    },
  );
  it.each([
    [inaturalistSearchObservations, {}],
    [inaturalistGetSpeciesCounts, {}],
    [inaturalistGetHistogram, {}],
    [inaturalistGetLeaderboard, { kind: 'observers' }],
    [inaturalistGetSimilarSpecies, { taxon_id: 48662 }],
  ] as const)(
    'retains geographic filtering and discloses the radius clamp for $name',
    async (definition, extra) => {
      const http = createFetchMock([
        {
          match: /./,
          respond: (request) =>
            Response.json(
              new URL(request.url).pathname.endsWith('/histogram')
                ? { results: { month_of_year: {} } }
                : { total_results: 0, results: [] },
            ),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(definition, {
          ...extra,
          lat: 47.6,
          lng: -122.3,
          radius: 20041,
        });
        expect(result.isError).toBeFalsy();
        expect(http.calls).toHaveLength(1);
        const query = new URL(http.calls[0]!.request.url).searchParams;
        expect(query.get('radius')).toBe('20040');
        expect(query.get('lat')).toBe('47.6');
        expect(query.get('lng')).toBe('-122.3');
        expect((result.structuredContent as { notice: string }).notice).toContain(
          'radius 20041 was clamped to 20040.',
        );
        expect(JSON.stringify(result.content)).toContain('radius 20041 was clamped to 20040.');
      } finally {
        http.restore();
      }
    },
  );
  it.each([{ cursor: '2147483648' }, { project_id: 2147483648 }])(
    'rejects upstream int32 overflow without a request: %j',
    async (input) => {
      const http = createFetchMock([
        { match: /./, respond: () => Response.json({ total_results: 0, results: [] }) },
      ]);
      http.install();
      try {
        const result = await runToolContract(inaturalistSearchObservations, input);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
        });
        expect(JSON.stringify(result.content)).toContain('2147483647');
        expect(http.calls).toHaveLength(0);
      } finally {
        http.restore();
      }
    },
  );

  it('preserves an int32 boundary cursor and typed unknown project recovery', async () => {
    const http = createFetchMock([
      {
        match: /./,
        respond: (request) =>
          new URL(request.url).searchParams.has('project_id')
            ? Response.json(
                { error: 'Unknown project_id: [2147483647]', status: 422 },
                { status: 422 },
              )
            : Response.json({ total_results: 0, results: [] }),
      },
    ]);
    http.install();
    try {
      const cursor = await runToolContract(inaturalistSearchObservations, { cursor: '2147483647' });
      expect(cursor.isError).toBeFalsy();
      expect(new URL(http.calls[0]!.request.url).searchParams.get('id_below')).toBe('2147483647');
      const project = await runToolContract(inaturalistSearchObservations, {
        project_id: 2147483647,
      });
      expect(project.structuredContent).toMatchObject({
        error: { data: { reason: 'unknown_project_id' } },
      });
      expect(JSON.stringify(project.content)).toContain('inaturalist_resolve_name');
      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });
  it('serves supplemental ranks and their fractional levels on both surfaces', async () => {
    const result = await runToolContract(inaturalistListReference, { topic: 'ranks' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      entries: expect.arrayContaining([
        { code: 'parvorder', label: 'parvorder', notes: 'rank_level 34.5.' },
      ]),
    });
    expect((result.structuredContent as { entries: unknown[] }).entries).toHaveLength(35);
    expect(JSON.stringify(result.content)).toContain('rank_level 34.5.');
    for (const rank of ['root', 'subkingdom']) {
      expect(inaturalistResolveName.input.safeParse({ q: 'achillea', rank }).success).toBe(false);
    }
  });

  it('resolves a complex rank through real service projection and both surfaces', async () => {
    // Minimal fields from the upstream Achillea complex autocomplete response.
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org/,
        respond: () =>
          Response.json({
            total_results: 1,
            results: [
              { id: 1105043, name: 'Achillea millefolium', rank: 'complex', rank_level: 11 },
            ],
          }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(inaturalistResolveName, {
        q: 'achillea',
        rank: 'complex',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        found: true,
        candidates: [{ id: 1105043, rank: 'complex' }],
      });
      expect(JSON.stringify(result.content)).toContain('rank complex');
      expect(new URL(http.calls[0]!.request.url).searchParams.get('rank')).toBe('complex');
    } finally {
      http.restore();
    }
  });
  it.each([
    [inaturalistSearchObservations, /\/observations\?/, { total_results: 0, results: [] }],
    [
      inaturalistGetSpeciesCounts,
      /\/observations\/species_counts\?/,
      { total_results: 0, results: [] },
    ],
    [inaturalistGetHistogram, /\/observations\/histogram\?/, { results: { month_of_year: {} } }],
  ] as const)(
    'explains annotation membership sets on both surfaces for $name',
    async (definition, match, body) => {
      const http = createFetchMock([
        { match: /api\.inaturalist\.org/, respond: () => Response.json(body) },
      ]);
      http.install();
      try {
        const result = await runToolContract(definition, {
          term_id: [1, 9],
          term_value_id: [2, 11],
        });
        expect(result.isError).toBeFalsy();
        expect(http.calls).toHaveLength(1);
        expect(http.calls[0]!.request.url).toMatch(match);
        const query = new URL(http.calls[0]!.request.url).searchParams;
        expect(query.get('term_id')).toBe('1,9');
        expect(query.get('term_value_id')).toBe('2,11');
        expect((result.structuredContent as { notice: string }).notice).toContain(
          'any one annotation',
        );
        expect(JSON.stringify(result.content)).toContain('any one annotation');
      } finally {
        http.restore();
      }
    },
  );

  it.each([true, false, undefined])(
    'forwards sounds=%s independently of expansions',
    async (sounds) => {
      const http = createFetchMock([
        {
          match: /\/observations\?/,
          respond: () => Response.json({ total_results: 0, results: [] }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(
          inaturalistSearchObservations,
          sounds === undefined ? {} : { sounds },
        );
        expect(result.isError).toBeFalsy();
        const query = new URL(http.calls[0]!.request.url).searchParams;
        expect(query.get('sounds')).toBe(sounds === undefined ? null : String(sounds));
        expect(query.has('include')).toBe(false);
        const notice = String((result.structuredContent as { notice?: string }).notice);
        if (sounds === undefined) expect(notice).not.toContain('sounds');
        else {
          expect(notice).toContain(`sounds: ${sounds}`);
          expect(JSON.stringify(result.content)).toContain(`sounds: ${sounds}`);
        }
      } finally {
        http.restore();
      }
    },
  );

  it('drops empty arrays while explaining all ignored filters beside zero-result guidance', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\?/,
        respond: () => Response.json({ total_results: 0, results: [] }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(inaturalistSearchObservations, {
        license: [],
        photo_license: [],
        csi: [],
        term_id: [1],
        term_value_id: [],
        iconic_taxa: [],
        include: [],
      });
      expect(result.isError).toBeFalsy();
      const query = new URL(http.calls[0]!.request.url).searchParams;
      expect(query.get('term_id')).toBe('1');
      const notice = String((result.structuredContent as { notice?: string }).notice);
      for (const field of ['license', 'photo_license', 'csi', 'term_value_id', 'iconic_taxa']) {
        expect(query.has(field)).toBe(false);
        expect(notice).toContain(field);
      }
      expect(notice).toContain('ignored');
      expect(notice).toContain('annotation');
      expect(notice.split(' were empty')[0]).not.toContain('include');
      expect(JSON.stringify(result.content)).toContain('ignored');
    } finally {
      http.restore();
    }
  });

  it('describes the captive cohort as exclusive', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\?/,
        respond: () => Response.json({ total_results: 0, results: [] }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(inaturalistSearchObservations, { captive: false });
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain('captive/cultivated-only');
      expect(notice).toContain('separate call');
      expect(notice).not.toContain('to include zoo');
    } finally {
      http.restore();
    }
  });
});
