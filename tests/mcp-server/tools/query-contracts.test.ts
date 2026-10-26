/** @fileoverview Query filter and upstream-error contracts across area tools. */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

describe('search filters on the wire', () => {
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
