/**
 * @fileoverview Tests for the wave-2 INaturalistService methods —
 * getSpeciesCounts, getHistogram, getLeaderboard, getSimilarSpecies, and
 * getTaxon: each hits the expected endpoint path with the allowed parameter
 * set, and getTaxon is served from the six-hour TTL cache on a repeat id.
 * The network boundary is faked with `createFetchMock`.
 * @module tests/services/inaturalist/inaturalist-service-aggregates.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { rawLeaderboardEntry, rawTaxonCount, rawTaxonDocument } from '../../helpers/fixtures.js';

function newService(): INaturalistService {
  return new INaturalistService({
    userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
    minRequestIntervalMs: 0,
    maxConcurrentRequests: 4,
    dailyRequestBudget: 1000,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getSpeciesCounts', () => {
  it('hits observations/species_counts with the allowed parameter set', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/species_counts/,
        respond: () =>
          Response.json({ total_results: 1, results: [rawTaxonCount({ count: 4200 })] }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { total, species } = await service.getSpeciesCounts(
        { place_id: 1, quality_grade: ['research'], captive: false, per_page: 25, page: 1 },
        ctx,
      );

      expect(total).toBe(1);
      expect(species).toEqual([
        expect.objectContaining({ taxon_id: 48662, observation_count: 4200 }),
      ]);
      expect(http.calls[0]?.request.url).toContain('/observations/species_counts');
    } finally {
      http.restore();
    }
  });

  it('filters out a row whose taxon carries no numeric id, keeping the reported total intact', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/species_counts/,
        respond: () =>
          Response.json({
            total_results: 500,
            results: [rawTaxonCount(), { count: 1, taxon: {} }],
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { total, species } = await service.getSpeciesCounts({ per_page: 25, page: 1 }, ctx);

      expect(species).toHaveLength(1);
      expect(total).toBe(500);
    } finally {
      http.restore();
    }
  });

  it('numbers rows absolutely from the page offset — page 3 at 3 per page is 7, 8, 9', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/species_counts/,
        respond: () =>
          Response.json({
            total_results: 99_891,
            results: [
              rawTaxonCount({ count: 314_499 }),
              rawTaxonCount({ count: 309_869 }),
              rawTaxonCount({ count: 289_232 }),
            ],
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { species } = await service.getSpeciesCounts(
        { place_id: 1, page: 3, per_page: 3 },
        ctx,
      );

      expect(species.map((row) => row.position)).toEqual([7, 8, 9]);
      // `rank` stays the taxonomic rank; the ranking position is its own field.
      expect(species.every((row) => row.rank === 'species')).toBe(true);
    } finally {
      http.restore();
    }
  });

  it('numbers page 1 from 1', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/species_counts/,
        respond: () =>
          Response.json({
            total_results: 3,
            results: [rawTaxonCount(), rawTaxonCount(), rawTaxonCount()],
          }),
      },
    ]);
    http.install();
    try {
      const { species } = await newService().getSpeciesCounts(
        { page: 1, per_page: 25 },
        createMockContext(),
      );

      expect(species.map((row) => row.position)).toEqual([1, 2, 3]);
    } finally {
      http.restore();
    }
  });

  it('leaves a gap where a taxonless row was dropped, rather than renumbering the rest', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/species_counts/,
        respond: () =>
          Response.json({
            total_results: 500,
            results: [rawTaxonCount(), { count: 5, taxon: {} }, rawTaxonCount(), rawTaxonCount()],
          }),
      },
    ]);
    http.install();
    try {
      const { species } = await newService().getSpeciesCounts(
        { page: 2, per_page: 4 },
        createMockContext(),
      );

      expect(species.map((row) => row.position)).toEqual([5, 7, 8]);
    } finally {
      http.restore();
    }
  });
});

describe('getHistogram', () => {
  it('hits observations/histogram and returns the ordered buckets for the requested interval', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/histogram/,
        respond: () => Response.json({ results: { month_of_year: { '2': 5, '1': 0 } } }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const buckets = await service.getHistogram(
        { taxon_id: 48662, interval: 'month_of_year' },
        ctx,
      );

      expect(buckets).toEqual([
        { key: '1', count: 0 },
        { key: '2', count: 5 },
      ]);
      expect(http.calls[0]?.request.url).toContain('/observations/histogram');
    } finally {
      http.restore();
    }
  });
});

describe('getLeaderboard', () => {
  it('routes "observers" to observations/observers and offsets rank by the page', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/observers/,
        respond: () =>
          Response.json({
            total_results: 1000,
            results: [
              rawLeaderboardEntry({ observation_count: 50, species_count: 10 }),
              rawLeaderboardEntry({ observation_count: 40, species_count: 8 }),
            ],
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { total, entries } = await service.getLeaderboard(
        'observers',
        { page: 3, per_page: 100, quality_grade: ['research'] },
        ctx,
      );

      expect(total).toBe(1000);
      // page 3 at 100/page starts at absolute rank 201.
      expect(entries.map((e) => e.rank)).toEqual([201, 202]);
      expect(entries[0]).toMatchObject({ count: 50, species_count: 10 });
      expect(http.calls[0]?.request.url).toContain('/observations/observers');
    } finally {
      http.restore();
    }
  });

  it('routes "identifiers" to observations/identifiers with no species_count on the rows', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/identifiers/,
        respond: () =>
          Response.json({
            total_results: 10,
            results: [
              rawLeaderboardEntry({ observation_count: null, species_count: null, count: 30 }),
            ],
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { entries } = await service.getLeaderboard(
        'identifiers',
        { page: 1, per_page: 25 },
        ctx,
      );

      expect(entries).toEqual([{ rank: 1, login: 'top_observer', count: 30 }]);
      expect(http.calls[0]?.request.url).toContain('/observations/identifiers');
    } finally {
      http.restore();
    }
  });
});

describe('getSimilarSpecies', () => {
  it('hits identifications/similar_species and projects the confusion set', async () => {
    const http = createFetchMock([
      {
        match: /\/identifications\/similar_species/,
        respond: () =>
          Response.json({ total_results: 24, results: [rawTaxonCount({ count: 12 })] }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { total, similar } = await service.getSimilarSpecies({ taxon_id: 48662 }, ctx);

      expect(total).toBe(24);
      expect(similar).toEqual([expect.objectContaining({ misidentification_count: 12 })]);
      expect(http.calls[0]?.request.url).toContain('/identifications/similar_species');
    } finally {
      http.restore();
    }
  });
});

describe('getTaxon', () => {
  it('hits /taxa/{id} and returns the projected document', async () => {
    const http = createFetchMock([
      { match: /\/taxa\/48662/, respond: () => Response.json({ results: [rawTaxonDocument()] }) },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const doc = await service.getTaxon(48662, ctx);

      expect(doc).toMatchObject({ id: 48662, name: 'Danaus plexippus' });
      expect(http.calls[0]?.request.url).toContain('/taxa/48662');
    } finally {
      http.restore();
    }
  });

  it('returns null when upstream answers an empty results array for that id', async () => {
    const http = createFetchMock([
      { match: /\/taxa\/999999999/, respond: () => Response.json({ results: [] }) },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await expect(service.getTaxon(999_999_999, ctx)).resolves.toBeNull();
    } finally {
      http.restore();
    }
  });

  it('serves a repeat call from the six-hour TTL cache without a second fetch', async () => {
    const http = createFetchMock([
      { match: /\/taxa\/48662/, respond: () => Response.json({ results: [rawTaxonDocument()] }) },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await service.getTaxon(48662, ctx);
      await service.getTaxon(48662, ctx);

      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('expires the cached taxon once the six-hour TTL elapses, issuing a fresh fetch', async () => {
    vi.useFakeTimers();
    const http = createFetchMock([
      { match: /\/taxa\/48662/, respond: () => Response.json({ results: [rawTaxonDocument()] }) },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await service.getTaxon(48662, ctx);
      // taxa is cached 6h (21,600s).
      await vi.advanceTimersByTimeAsync(21_600_000 + 1_000);
      await service.getTaxon(48662, ctx);

      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });
});
