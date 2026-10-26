/** @fileoverview Applied limits govern ranking windows, rows and composed notices. */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetLeaderboard } from '@/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { inaturalistGetSimilarSpecies } from '@/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../helpers/fake-inaturalist-service.js';
import { leaderboardEntry, similarSpecies, speciesCount } from '../../helpers/fixtures.js';

vi.mock('@/services/inaturalist/inaturalist-service.js', async (original) => ({
  ...(await original<typeof import('@/services/inaturalist/inaturalist-service.js')>()),
  getINaturalistService: vi.fn(),
}));
const fake = createFakeService();
beforeEach(() => {
  resetFakeService(fake);
  vi.mocked(getINaturalistService).mockReturnValue(asService(fake));
});

describe('ranking limits', () => {
  it('uses 250 before checking the leaderboard page-two window', async () => {
    fake.getLeaderboard.mockResolvedValue({
      total: 501,
      entries: Array.from({ length: 250 }, (_, i) => leaderboardEntry({ rank: 251 + i })),
    });
    const result = await runToolContract(inaturalistGetLeaderboard, {
      kind: 'observers',
      page: 2,
      per_page: 251,
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getLeaderboard.mock.calls[0]?.[1]).toMatchObject({ page: 2, per_page: 250 });
    expect(result.structuredContent).toMatchObject({
      shown: 250,
      cap: 250,
      truncated: true,
      notice: expect.stringContaining('per_page 251 was clamped to 250'),
    });
    expect(JSON.stringify(result.content)).toContain('500-entry ceiling');
    expect(JSON.stringify(result.content)).toContain('per_page 251 was clamped to 250');
  });
  it.each([0, 1, 50])(
    'composes species clamp and empty-array notices for %s returned rows',
    async (count) => {
      fake.getSpeciesCounts.mockResolvedValue({
        total: count === 0 ? 0 : 51,
        species: Array.from({ length: count }, (_, i) => speciesCount({ position: i + 1 })),
      });
      const result = await runToolContract(inaturalistGetSpeciesCounts, {
        per_page: 51,
        iconic_taxa: [],
      });
      expect(result.isError).toBeFalsy();
      expect(fake.getSpeciesCounts.mock.calls[0]?.[0]).toMatchObject({ per_page: 50 });
      expect(result.structuredContent).toMatchObject({
        shown: count,
        cap: 50,
        truncated: count === 50,
        notice: expect.stringContaining('per_page 51 was clamped to 50'),
      });
      expect(JSON.stringify(result.content)).toContain('iconic_taxa was empty and ignored');
    },
  );
  it.each([0, 1, 51])('composes similar-species clamp with %s upstream rows', async (count) => {
    fake.getSimilarSpecies.mockResolvedValue({
      total: count,
      similar: Array.from({ length: count }, (_, i) => similarSpecies({ taxon_id: i + 1 })),
    });
    const result = await runToolContract(inaturalistGetSimilarSpecies, {
      taxon_id: 48662,
      limit: 51,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      shown: Math.min(count, 50),
      cap: 50,
      truncated: count > 50,
      notice: expect.stringContaining('limit 51 was clamped to 50'),
    });
    expect(JSON.stringify(result.content)).toContain('limit 51 was clamped to 50');
  });
});
