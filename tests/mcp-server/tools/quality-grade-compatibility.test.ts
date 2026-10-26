/** @fileoverview Preserve framework quality-grade repairs before handler normalization. */
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import { inaturalistGetLeaderboard } from '@/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { inaturalistGetSimilarSpecies } from '@/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
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
      userAgent: 'test',
      minRequestIntervalMs: 0,
      maxConcurrentRequests: 4,
      dailyRequestBudget: 1000,
    }),
  );
});

// Reflect.apply sends wire representations through the real repair boundary before schema validation.
const calls = [
  [
    'search',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [inaturalistSearchObservations, { quality_grade }]),
  ],
  [
    'species',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [inaturalistGetSpeciesCounts, { quality_grade }]),
  ],
  [
    'histogram',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [inaturalistGetHistogram, { quality_grade }]),
  ],
  [
    'observers',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [
        inaturalistGetLeaderboard,
        { kind: 'observers', quality_grade },
      ]),
  ],
  [
    'identifiers',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [
        inaturalistGetLeaderboard,
        { kind: 'identifiers', quality_grade },
      ]),
  ],
  [
    'similar',
    (quality_grade: unknown) =>
      Reflect.apply(runToolContract, undefined, [
        inaturalistGetSimilarSpecies,
        { taxon_id: 1, quality_grade },
      ]),
  ],
] as const;

describe('quality-grade compatibility', () => {
  it.each(calls)(
    '%s accepts repaired lists and deduplicates without changing order',
    async (_name, call) => {
      for (const [value, expected] of [
        ['research', 'research'],
        ['["needs_id","research","needs_id"]', 'needs_id,research'],
        [null, 'research'],
        [['needs_id', 'research', 'needs_id'], 'needs_id,research'],
      ] as const) {
        const http = createFetchMock([
          {
            match: /api\.inaturalist\.org/,
            respond: () => Response.json({ total_results: 0, results: [] }),
          },
        ]);
        http.install();
        try {
          const result = await call(value);
          expect(result.isError).toBeFalsy();
          expect(http.calls).toHaveLength(1);
          expect(new URL(http.calls[0]!.request.url).searchParams.get('quality_grade')).toBe(
            expected,
          );
        } finally {
          http.restore();
        }
      }
    },
  );
});
