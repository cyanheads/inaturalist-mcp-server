/**
 * @fileoverview Shared fixture builders for iNaturalist raw upstream payload
 * shapes and projected domain records. Field names are read from
 * src/services/inaturalist/types.ts so every fixture stays real-shaped; each
 * builder takes a partial override so a test only names what it varies.
 * @module tests/helpers/fixtures
 */

import type {
  ControlledTerm,
  Coordinate,
  LeaderboardEntry,
  ObservedUsage,
  ProjectedAnnotation,
  ProjectedComment,
  ProjectedIdentification,
  ProjectedObservation,
  ProjectedPhoto,
  ProjectedPlace,
  ProjectedSound,
  ProjectedTaxonDocument,
  RawAnnotation,
  RawComment,
  RawControlledTerm,
  RawGeoJsonPolygon,
  RawHistogram,
  RawIdentification,
  RawLeaderboardEntry,
  RawObservation,
  RawPhoto,
  RawPlace,
  RawPopularFieldValue,
  RawSearchResult,
  RawSound,
  RawTaxon,
  RawTaxonCount,
  RawTaxonDocument,
  ResolvedCandidate,
  SimilarSpecies,
  SpeciesCount,
  TaxonRecord,
  TaxonSummary,
} from '@/services/inaturalist/types.js';

// ─── Raw upstream shapes ────────────────────────────────────────────────────

export function rawPhoto(overrides: Partial<RawPhoto> = {}): RawPhoto {
  return {
    id: 737155276,
    url: 'https://static.inaturalist.org/photos/737155276/square.jpg',
    square_url: 'https://static.inaturalist.org/photos/737155276/square.jpg',
    medium_url: null,
    attribution: '(c) Kelly Yeates, all rights reserved',
    license_code: null,
    ...overrides,
  };
}

/** A photo hosted on the domain the spec reserves for open licences. */
export function openPhoto(overrides: Partial<RawPhoto> = {}): RawPhoto {
  return rawPhoto({
    id: 1,
    url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
    square_url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpg',
    attribution:
      '(c) Alejandro Lopez, some rights reserved (CC BY-NC-SA), uploaded by Alejandro Lopez',
    license_code: 'cc-by-nc-sa',
    ...overrides,
  });
}

export function rawSound(overrides: Partial<RawSound> = {}): RawSound {
  return {
    file_url: 'https://static.inaturalist.org/sounds/1.mp3',
    url: null,
    attribution: '(c) fieldrecorder, some rights reserved (CC BY-NC)',
    license_code: 'cc-by-nc',
    ...overrides,
  };
}

export function rawAnnotation(overrides: Partial<RawAnnotation> = {}): RawAnnotation {
  return {
    controlled_attribute_id: 1,
    controlled_value_id: 6,
    user: { login: 'the_insect_cabinet' },
    ...overrides,
  };
}

export function rawTaxon(overrides: Partial<RawTaxon> = {}): RawTaxon {
  return {
    id: 48662,
    name: 'Danaus plexippus',
    rank: 'species',
    rank_level: 10,
    preferred_common_name: 'Monarch',
    iconic_taxon_name: 'Insecta',
    observations_count: 250_000,
    matched_term: 'Monarch',
    default_photo: rawPhoto(),
    ...overrides,
  };
}

export function rawIdentification(overrides: Partial<RawIdentification> = {}): RawIdentification {
  return {
    id: 1001,
    taxon: rawTaxon(),
    user: { login: 'identifier_one' },
    current: true,
    category: 'improving',
    disagreement: false,
    vision: false,
    body: 'Clear wing pattern match.',
    created_at: '2026-06-01T12:00:00-07:00',
    ...overrides,
  };
}

export function rawComment(overrides: Partial<RawComment> = {}): RawComment {
  return {
    id: 2001,
    user: { login: 'commenter_one' },
    body: 'Great find!',
    created_at: '2026-06-01T13:00:00-07:00',
    ...overrides,
  };
}

export function rawObservation(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    id: 401617560,
    uuid: 'abc-uuid-1',
    uri: 'https://www.inaturalist.org/observations/401617560',
    observed_on: '2026-06-01',
    time_observed_at: '2026-06-01T10:00:00-07:00',
    taxon: rawTaxon(),
    community_taxon: rawTaxon(),
    place_guess: 'Seattle, WA',
    location: '47.6062,-122.3321',
    public_positional_accuracy: 15,
    obscured: false,
    geoprivacy: null,
    taxon_geoprivacy: null,
    quality_grade: 'research',
    license_code: 'cc-by-nc',
    captive: false,
    photos: [rawPhoto()],
    sounds: [],
    annotations: [rawAnnotation()],
    identifications: [rawIdentification()],
    comments: [rawComment()],
    user: { login: 'observer_one' },
    identifications_count: 1,
    num_identification_agreements: 1,
    num_identification_disagreements: 0,
    identification_disagreements_count: 0,
    community_taxon_id: 48662,
    ...overrides,
  };
}

/** A rectangular bounding-box polygon, the shape `bounding_box_geojson` always carries. */
export function rawBoundingBoxPolygon(
  overrides: Partial<RawGeoJsonPolygon> = {},
): RawGeoJsonPolygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [-122.4, 47.5],
        [-122.2, 47.5],
        [-122.2, 47.7],
        [-122.4, 47.7],
        [-122.4, 47.5],
      ],
    ],
    ...overrides,
  };
}

export function rawPlace(overrides: Partial<RawPlace> = {}): RawPlace {
  return {
    id: 1,
    name: 'Seattle',
    display_name: 'Seattle, WA, US',
    place_type: 100,
    admin_level: null,
    bounding_box_geojson: rawBoundingBoxPolygon(),
    ancestor_place_ids: [97394, 1],
    location: '47.6062,-122.3321',
    slug: 'seattle-wa-us',
    observations_count: 500_000,
    ...overrides,
  };
}

export function rawControlledTerm(overrides: Partial<RawControlledTerm> = {}): RawControlledTerm {
  return {
    id: 1,
    label: 'Life Stage',
    multivalued: false,
    values: [
      { id: 2, label: 'Adult', blocking: false },
      { id: 6, label: 'Larva', blocking: false },
    ],
    ...overrides,
  };
}

export function rawPopularFieldValue(
  overrides: Partial<RawPopularFieldValue> = {},
): RawPopularFieldValue {
  return {
    count: 336_576,
    controlled_attribute: { id: 1, label: 'Life Stage' },
    controlled_value: { id: 2, label: 'Adult' },
    ...overrides,
  };
}

export function rawSearchResult(overrides: Partial<RawSearchResult> = {}): RawSearchResult {
  return {
    type: 'Taxon',
    score: 12.5,
    matches: ['Monarch'],
    record: rawTaxon(),
    ...overrides,
  };
}

// ─── Projected domain records ─────────────────────────────────────────────

export function taxonSummary(overrides: Partial<TaxonSummary> = {}): TaxonSummary {
  return {
    id: 48662,
    name: 'Danaus plexippus',
    rank: 'species',
    common_name: 'Monarch',
    iconic_taxon_name: 'Insecta',
    ...overrides,
  };
}

export function projectedPhoto(overrides: Partial<ProjectedPhoto> = {}): ProjectedPhoto {
  return {
    square_url: 'https://static.inaturalist.org/photos/1/square.jpg',
    medium_url: 'https://static.inaturalist.org/photos/1/medium.jpg',
    attribution: '(c) Kelly Yeates, all rights reserved',
    license_code: null,
    open: false,
    ...overrides,
  };
}

export function projectedSound(overrides: Partial<ProjectedSound> = {}): ProjectedSound {
  return {
    url: 'https://static.inaturalist.org/sounds/1.mp3',
    attribution: '(c) fieldrecorder, some rights reserved (CC BY-NC)',
    license_code: 'cc-by-nc',
    ...overrides,
  };
}

export function projectedAnnotation(
  overrides: Partial<ProjectedAnnotation> = {},
): ProjectedAnnotation {
  return {
    attribute: 'Life Stage',
    value: 'Larva',
    attribute_id: 1,
    value_id: 6,
    by: 'the_insect_cabinet',
    ...overrides,
  };
}

export function coordinate(overrides: Partial<Coordinate> = {}): Coordinate {
  return { lat: 47.6062, lng: -122.3321, accuracy_m: 15, ...overrides };
}

export function projectedIdentification(
  overrides: Partial<ProjectedIdentification> = {},
): ProjectedIdentification {
  return {
    id: 1001,
    taxon: taxonSummary(),
    by: 'identifier_one',
    current: true,
    category: 'improving',
    disagreement: false,
    from_vision: false,
    body: 'Clear wing pattern match.',
    created_at: '2026-06-01T12:00:00-07:00',
    ...overrides,
  };
}

export function projectedComment(overrides: Partial<ProjectedComment> = {}): ProjectedComment {
  return {
    id: 2001,
    by: 'commenter_one',
    body: 'Great find!',
    created_at: '2026-06-01T13:00:00-07:00',
    ...overrides,
  };
}

export function projectedObservation(
  overrides: Partial<ProjectedObservation> = {},
): ProjectedObservation {
  return {
    id: 401617560,
    uuid: 'abc-uuid-1',
    url: 'https://www.inaturalist.org/observations/401617560',
    observed_on: '2026-06-01',
    observed_at: '2026-06-01T10:00:00-07:00',
    taxon: taxonSummary(),
    place_guess: 'Seattle, WA',
    coordinate: coordinate(),
    obscured: false,
    geoprivacy: null,
    taxon_geoprivacy: null,
    quality_grade: 'research',
    license_code: 'cc-by-nc',
    captive: false,
    photo: projectedPhoto(),
    photo_count: 1,
    sound_count: 0,
    observer: 'observer_one',
    identifications_count: 1,
    agreements: 1,
    disagreements: 0,
    community_taxon_id: 48662,
    ...overrides,
  };
}

export function resolvedCandidate(overrides: Partial<ResolvedCandidate> = {}): ResolvedCandidate {
  return {
    kind: 'taxon',
    id: 48662,
    name: 'Danaus plexippus',
    common_name: 'Monarch',
    rank: 'species',
    matched_term: 'Monarch',
    observations_count: 250_000,
    photo: projectedPhoto(),
    ...overrides,
  };
}

export function taxonRecord(overrides: Partial<TaxonRecord> = {}): TaxonRecord {
  return {
    ...taxonSummary(),
    rank_level: 10,
    observations_count: 250_000,
    photo: projectedPhoto(),
    ...overrides,
  };
}

export function projectedPlace(overrides: Partial<ProjectedPlace> = {}): ProjectedPlace {
  return {
    id: 1,
    name: 'Seattle',
    display_name: 'Seattle, WA, US',
    place_type: 100,
    admin_level: null,
    bbox: { swlat: 47.5, swlng: -122.4, nelat: 47.7, nelng: -122.2 },
    ancestor_place_ids: [97394, 1],
    location: { lat: 47.6062, lng: -122.3321 },
    slug: 'seattle-wa-us',
    ...overrides,
  };
}

export function controlledTerm(overrides: Partial<ControlledTerm> = {}): ControlledTerm {
  return {
    id: 1,
    label: 'Life Stage',
    multivalued: false,
    values: [
      { id: 2, label: 'Adult', blocking: false },
      { id: 6, label: 'Larva', blocking: false },
    ],
    ...overrides,
  };
}

export function observedUsage(overrides: Partial<ObservedUsage> = {}): ObservedUsage {
  return {
    attribute: 'Life Stage',
    term_id: 1,
    value: 'Adult',
    term_value_id: 2,
    count: 336_576,
    ...overrides,
  };
}

// ─── Wave 2: taxon document, aggregates ────────────────────────────────────

/** A `/taxa/{id}` raw record — the one fat document on this surface. */
export function rawTaxonDocument(overrides: Partial<RawTaxonDocument> = {}): RawTaxonDocument {
  return {
    ...rawTaxon(),
    is_active: true,
    extinct: false,
    vision: true,
    listed_taxa_count: 42,
    ancestors: [
      rawTaxon({ id: 1, name: 'Animalia', rank: 'kingdom', preferred_common_name: null }),
    ],
    children: [
      rawTaxon({
        id: 100,
        name: 'Danaus plexippus plexippus',
        rank: 'subspecies',
        preferred_common_name: null,
      }),
    ],
    conservation_statuses: [
      {
        status: 'Special Concern',
        authority: 'NatureServe',
        iucn: 10,
        url: 'https://example.test/status',
        place: { name: 'Canada', display_name: 'Canada' },
      },
    ],
    conservation_status: {
      status: 'Least Concern',
      authority: 'IUCN Red List',
      iucn: 10,
      url: 'https://example.test/global-status',
      place: null,
    },
    taxon_photos: [{ photo: rawPhoto() }],
    wikipedia_summary: 'The <b>monarch butterfly</b> is a milkweed butterfly.',
    wikipedia_url: 'https://en.wikipedia.org/wiki/Monarch_butterfly',
    ...overrides,
  };
}

/** One `{ count, taxon }` row shared by species_counts and similar_species. */
export function rawTaxonCount(overrides: Partial<RawTaxonCount> = {}): RawTaxonCount {
  return { count: 42, taxon: rawTaxon(), ...overrides };
}

/** One leaderboard row. Pass `observation_count`/`species_count` for the
 * observers shape, or `count` for the identifiers shape. */
export function rawLeaderboardEntry(
  overrides: Partial<RawLeaderboardEntry> = {},
): RawLeaderboardEntry {
  return {
    user_id: 1,
    observation_count: 500,
    species_count: 120,
    count: null,
    user: { login: 'top_observer' },
    ...overrides,
  };
}

/** A `/observations/histogram` raw response, keyed by interval name. */
export function rawHistogram(overrides: Partial<RawHistogram> = {}): RawHistogram {
  return {
    results: { month_of_year: { '1': 0, '2': 5, '3': 12 } },
    ...overrides,
  };
}

export function speciesCount(overrides: Partial<SpeciesCount> = {}): SpeciesCount {
  return {
    position: 1,
    taxon_id: 48662,
    name: 'Danaus plexippus',
    common_name: 'Monarch',
    rank: 'species',
    iconic_taxon_name: 'Insecta',
    observation_count: 4200,
    photo: projectedPhoto(),
    ...overrides,
  };
}

export function similarSpecies(overrides: Partial<SimilarSpecies> = {}): SimilarSpecies {
  return {
    taxon_id: 48663,
    name: 'Limenitis archippus',
    common_name: 'Viceroy',
    rank: 'species',
    observations_count: 50_000,
    misidentification_count: 12,
    photo: projectedPhoto(),
    ...overrides,
  };
}

export function leaderboardEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return { rank: 1, login: 'top_observer', count: 500, species_count: 120, ...overrides };
}

/** The projected taxon profile — the full arm of `inaturalist_get_taxon`. */
export function projectedTaxonDocument(
  overrides: Partial<ProjectedTaxonDocument> = {},
): ProjectedTaxonDocument {
  return {
    id: 48662,
    name: 'Danaus plexippus',
    rank: 'species',
    rank_level: 10,
    common_name: 'Monarch',
    iconic_taxon_name: 'Insecta',
    is_active: true,
    extinct: false,
    observations_count: 250_000,
    listed_taxa_count: 42,
    vision: true,
    taxonomy: [{ id: 1, name: 'Animalia', rank: 'kingdom', common_name: null }],
    children: [
      {
        id: 100,
        name: 'Danaus plexippus plexippus',
        rank: 'subspecies',
        common_name: null,
        observations_count: 500,
      },
    ],
    conservation: {
      statuses: [
        {
          status: 'Special Concern',
          authority: 'NatureServe',
          iucn: 10,
          place: 'Canada',
          url: 'https://example.test/status',
        },
      ],
      global_status: null,
    },
    photos: [
      {
        square_url: 'https://static.inaturalist.org/photos/1/square.jpg',
        medium_url: 'https://static.inaturalist.org/photos/1/medium.jpg',
        attribution: '(c) Kelly Yeates, all rights reserved',
        license_code: null,
        open: false,
        large_url: 'https://static.inaturalist.org/photos/1/large.jpg',
      },
    ],
    encyclopedia: {
      wikipedia_summary: 'The <b>monarch butterfly</b> is a milkweed butterfly.',
      wikipedia_url: 'https://en.wikipedia.org/wiki/Monarch_butterfly',
    },
    ...overrides,
  };
}
