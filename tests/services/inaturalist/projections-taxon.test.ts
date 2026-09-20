/**
 * @fileoverview Tests for the wave-2 pure projection functions — the taxon
 * document (photo, lineage, child, conservation status) and the three
 * aggregate row projections (species count, similar species, leaderboard
 * entry), plus the histogram bucket ordering helper.
 * @module tests/services/inaturalist/projections-taxon.test
 */

import { describe, expect, it } from 'vitest';
import {
  histogramBuckets,
  projectConservationStatus,
  projectLeaderboardEntry,
  projectSimilarSpecies,
  projectSpeciesCount,
  projectTaxonChild,
  projectTaxonDocument,
  projectTaxonLineage,
  projectTaxonPhoto,
} from '@/services/inaturalist/projections.js';
import type { RawHistogram, RawTaxonPhoto } from '@/services/inaturalist/types.js';
import {
  rawHistogram,
  rawLeaderboardEntry,
  rawPhoto,
  rawTaxon,
  rawTaxonCount,
  rawTaxonDocument,
} from '../../helpers/fixtures.js';

describe('projectTaxonPhoto', () => {
  it('returns null for an absent photo', () => {
    expect(projectTaxonPhoto(undefined)).toBeNull();
    expect(projectTaxonPhoto(null)).toBeNull();
  });

  it('relays large_url verbatim — this endpoint publishes every size variant', () => {
    const photo = projectTaxonPhoto(rawPhoto({ large_url: 'https://example.test/large.jpg' }));
    expect(photo?.large_url).toBe('https://example.test/large.jpg');
  });

  it('omits large_url rather than deriving one when upstream carries none', () => {
    const photo = projectTaxonPhoto(rawPhoto({ large_url: null }));
    expect(photo).not.toHaveProperty('large_url');
  });
});

describe('projectTaxonLineage', () => {
  it('trims a raw taxon to the four lineage fields', () => {
    expect(projectTaxonLineage(rawTaxon({ id: 1, name: 'Animalia', rank: 'kingdom' }))).toEqual({
      id: 1,
      name: 'Animalia',
      rank: 'kingdom',
      common_name: 'Monarch',
    });
  });

  it('drops fields a lineage rung does not carry, like observations_count and rank_level', () => {
    const lineage = projectTaxonLineage(rawTaxon());
    expect(lineage).not.toHaveProperty('observations_count');
    expect(lineage).not.toHaveProperty('rank_level');
  });

  it('returns null when the raw ancestor carries no numeric id', () => {
    expect(projectTaxonLineage(undefined)).toBeNull();
    expect(projectTaxonLineage({})).toBeNull();
  });
});

describe('projectTaxonChild', () => {
  it('carries observations_count alongside the lineage fields', () => {
    expect(projectTaxonChild(rawTaxon({ id: 100, observations_count: 500 }))).toMatchObject({
      id: 100,
      observations_count: 500,
    });
  });

  it('reports a null observations_count rather than fabricating zero', () => {
    const child = projectTaxonChild(rawTaxon({ id: 100, observations_count: null }));
    expect(child?.observations_count).toBeNull();
  });

  it('returns null when the raw child carries no numeric id', () => {
    expect(projectTaxonChild({})).toBeNull();
  });
});

describe('projectConservationStatus', () => {
  it('collapses place to its display_name when present', () => {
    const status = projectConservationStatus({
      status: 'Special Concern',
      authority: 'NatureServe',
      iucn: 10,
      url: 'https://example.test/status',
      place: { name: 'Canada', display_name: 'Canada (national)' },
    });
    expect(status.place).toBe('Canada (national)');
  });

  it('falls back to place.name when display_name is absent', () => {
    const status = projectConservationStatus({ place: { name: 'Canada', display_name: null } });
    expect(status.place).toBe('Canada');
  });

  it('reports a null place for a global-scope listing', () => {
    expect(projectConservationStatus({ place: null }).place).toBeNull();
  });

  it('relays status, authority, iucn, and url verbatim', () => {
    expect(
      projectConservationStatus({
        status: 'G4',
        authority: 'NatureServe',
        iucn: 20,
        url: 'https://example.test/g4',
        place: null,
      }),
    ).toEqual({
      status: 'G4',
      authority: 'NatureServe',
      iucn: 20,
      url: 'https://example.test/g4',
      place: null,
    });
  });
});

describe('projectTaxonDocument', () => {
  it('returns null when the raw document carries no numeric id', () => {
    expect(projectTaxonDocument(undefined)).toBeNull();
    expect(projectTaxonDocument(null)).toBeNull();
    expect(projectTaxonDocument({})).toBeNull();
  });

  it('projects a full record: taxonomy, children, conservation, photos, encyclopedia', () => {
    const doc = projectTaxonDocument(rawTaxonDocument());
    expect(doc).toMatchObject({
      id: 48662,
      name: 'Danaus plexippus',
      is_active: true,
      extinct: false,
      vision: true,
      listed_taxa_count: 42,
    });
    expect(doc?.taxonomy).toEqual([
      { id: 1, name: 'Animalia', rank: 'kingdom', common_name: null },
    ]);
    expect(doc?.children).toEqual([
      {
        id: 100,
        name: 'Danaus plexippus plexippus',
        rank: 'subspecies',
        common_name: null,
        observations_count: 250_000,
      },
    ]);
    expect(doc?.conservation.statuses).toHaveLength(1);
    expect(doc?.conservation.global_status).toMatchObject({ status: 'Least Concern' });
    expect(doc?.photos).toHaveLength(1);
    expect(doc?.encyclopedia).toEqual({
      wikipedia_summary: 'The <b>monarch butterfly</b> is a milkweed butterfly.',
      wikipedia_url: 'https://en.wikipedia.org/wiki/Monarch_butterfly',
    });
  });

  it('never emits a listed_taxa array — only the scalar count survives', () => {
    const doc = projectTaxonDocument(rawTaxonDocument());
    expect(doc).not.toHaveProperty('listed_taxa');
    expect(doc?.listed_taxa_count).toBe(42);
  });

  it('drops the duplicate taxon record inside a taxon_photos entry, keeping only the photo', () => {
    // Real upstream payloads nest a full taxon record beside the photo inside
    // each taxon_photos[] entry; the function reads only the `photo` key.
    const entryWithDuplicateTaxon: RawTaxonPhoto & { taxon: unknown } = {
      photo: rawPhoto(),
      taxon: rawTaxon(),
    };
    const doc = projectTaxonDocument(rawTaxonDocument({ taxon_photos: [entryWithDuplicateTaxon] }));
    expect(doc?.photos).toHaveLength(1);
    expect(doc?.photos[0]).not.toHaveProperty('taxon');
  });

  it('trims ancestors and children to the lineage fields even when upstream sends extra ones', () => {
    const doc = projectTaxonDocument(
      rawTaxonDocument({
        ancestors: [rawTaxon({ id: 1, rank: 'kingdom', observations_count: 999_999 })],
      }),
    );
    expect(doc?.taxonomy[0]).not.toHaveProperty('observations_count');
    expect(doc?.taxonomy[0]).not.toHaveProperty('rank_level');
  });

  it('relays wikipedia_summary verbatim, inline HTML included, never stripped', () => {
    const doc = projectTaxonDocument(
      rawTaxonDocument({ wikipedia_summary: 'A <i>butterfly</i> with <b>orange</b> wings.' }),
    );
    expect(doc?.encyclopedia.wikipedia_summary).toBe(
      'A <i>butterfly</i> with <b>orange</b> wings.',
    );
  });

  it('projects a sparse record without fabricating any optional field', () => {
    const doc = projectTaxonDocument({ id: 5 });
    expect(doc).toEqual({
      id: 5,
      name: null,
      rank: null,
      rank_level: null,
      common_name: null,
      iconic_taxon_name: null,
      is_active: false,
      extinct: false,
      observations_count: null,
      listed_taxa_count: null,
      vision: false,
      taxonomy: [],
      children: [],
      conservation: { statuses: [], global_status: null },
      photos: [],
      encyclopedia: { wikipedia_summary: null, wikipedia_url: null },
    });
  });
});

describe('projectSpeciesCount', () => {
  it('projects a ranked species row from a { count, taxon } wrapper', () => {
    expect(projectSpeciesCount(rawTaxonCount({ count: 4200 }))).toMatchObject({
      taxon_id: 48662,
      name: 'Danaus plexippus',
      observation_count: 4200,
    });
  });

  it('returns null when the wrapped taxon carries no numeric id', () => {
    expect(projectSpeciesCount({ count: 1, taxon: null })).toBeNull();
    expect(projectSpeciesCount({ count: 1, taxon: {} })).toBeNull();
  });

  it('defaults observation_count to zero rather than null when count is absent', () => {
    expect(projectSpeciesCount({ taxon: rawTaxon() })?.observation_count).toBe(0);
  });

  it('carries the photo only when the taxon has one', () => {
    const withPhoto = projectSpeciesCount(rawTaxonCount());
    expect(withPhoto?.photo).toBeDefined();
    const withoutPhoto = projectSpeciesCount(
      rawTaxonCount({ taxon: rawTaxon({ default_photo: null }) }),
    );
    expect(withoutPhoto).not.toHaveProperty('photo');
  });
});

describe('projectSimilarSpecies', () => {
  it('names the upstream count misidentification_count rather than count', () => {
    const similar = projectSimilarSpecies(rawTaxonCount({ count: 12 }));
    expect(similar).toMatchObject({ misidentification_count: 12 });
    expect(similar).not.toHaveProperty('count');
  });

  it('returns null when the wrapped taxon carries no numeric id', () => {
    expect(projectSimilarSpecies({ count: 1, taxon: null })).toBeNull();
  });

  it('reports a null observations_count when the look-alike publishes none', () => {
    const similar = projectSimilarSpecies(
      rawTaxonCount({ taxon: rawTaxon({ observations_count: null }) }),
    );
    expect(similar?.observations_count).toBeNull();
  });
});

describe('projectLeaderboardEntry', () => {
  it('normalises the observers shape: observation_count, species_count, and user', () => {
    const entry = projectLeaderboardEntry(
      rawLeaderboardEntry({ observation_count: 500, species_count: 120 }),
      1,
      'observers',
    );
    expect(entry).toEqual({ rank: 1, login: 'top_observer', count: 500, species_count: 120 });
  });

  it('normalises the identifiers shape: count and user, with no species_count', () => {
    const entry = projectLeaderboardEntry(
      rawLeaderboardEntry({ observation_count: null, species_count: null, count: 300 }),
      1,
      'identifiers',
    );
    expect(entry).toEqual({ rank: 1, login: 'top_observer', count: 300 });
    expect(entry).not.toHaveProperty('species_count');
  });

  it('omits species_count on the observers arm when upstream publishes none', () => {
    const entry = projectLeaderboardEntry(
      rawLeaderboardEntry({ observation_count: 10, species_count: null }),
      1,
      'observers',
    );
    expect(entry).not.toHaveProperty('species_count');
  });

  it('carries the caller-supplied absolute rank, not a rank derived from the row', () => {
    const entry = projectLeaderboardEntry(rawLeaderboardEntry(), 407, 'observers');
    expect(entry.rank).toBe(407);
  });

  it('defaults count to zero rather than null when the relevant field is absent', () => {
    const observers = projectLeaderboardEntry(
      rawLeaderboardEntry({ observation_count: null }),
      1,
      'observers',
    );
    expect(observers.count).toBe(0);
    const identifiers = projectLeaderboardEntry(
      rawLeaderboardEntry({ count: null }),
      1,
      'identifiers',
    );
    expect(identifiers.count).toBe(0);
  });

  it('reports a null login when the user object is absent', () => {
    expect(projectLeaderboardEntry({}, 1, 'observers').login).toBeNull();
  });
});

describe('histogramBuckets', () => {
  it('orders month_of_year buckets ascending regardless of raw key insertion order', () => {
    const raw = rawHistogram({ results: { month_of_year: { '12': 2, '1': 0, '6': 8 } } });
    expect(histogramBuckets(raw, 'month_of_year')).toEqual([
      { key: '1', count: 0 },
      { key: '6', count: 8 },
      { key: '12', count: 2 },
    ]);
  });

  it('orders week_of_year buckets ascending', () => {
    const raw = rawHistogram({ results: { week_of_year: { '53': 1, '2': 4, '1': 3 } } });
    expect(histogramBuckets(raw, 'week_of_year')).toEqual([
      { key: '1', count: 3 },
      { key: '2', count: 4 },
      { key: '53', count: 1 },
    ]);
  });

  it('orders year buckets ascending', () => {
    const raw = rawHistogram({ results: { year: { '2024': 9, '2020': 1, '2022': 5 } } });
    expect(histogramBuckets(raw, 'year')).toEqual([
      { key: '2020', count: 1 },
      { key: '2022', count: 5 },
      { key: '2024', count: 9 },
    ]);
  });

  it('returns an empty array when the requested interval is absent from results', () => {
    const raw: RawHistogram = { results: {} };
    expect(histogramBuckets(raw, 'month_of_year')).toEqual([]);
  });

  it('returns an empty array when results itself is absent', () => {
    expect(histogramBuckets({}, 'month_of_year')).toEqual([]);
  });

  it('defaults a non-numeric bucket value to zero rather than throwing', () => {
    const raw = { results: { month_of_year: { '1': 'oops' } } } as unknown as RawHistogram;
    expect(histogramBuckets(raw, 'month_of_year')).toEqual([{ key: '1', count: 0 }]);
  });
});
