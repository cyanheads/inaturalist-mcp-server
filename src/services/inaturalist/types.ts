/**
 * @fileoverview Raw upstream payload shapes and the projected domain records
 * `INaturalistService` hands to tool handlers.
 * @module services/inaturalist/types
 */

import type { IucnCode, QualityGrade } from './vocabularies.js';

/**
 * Every probed endpoint answers with this envelope, including the by-id paths —
 * a missing record is `results: []` with HTTP 200, never a 404.
 */
export type INaturalistEnvelope<T> = {
  total_results?: number;
  page?: number;
  per_page?: number;
  results?: T[];
};

/**
 * Upstream photo. Observation photos carry only `url` (the 75px square variant);
 * taxon photos carry every size variant, so both are read here and the derived
 * variant is used only when upstream supplies none.
 */
export type RawPhoto = {
  id?: number;
  url?: string | null;
  square_url?: string | null;
  medium_url?: string | null;
  large_url?: string | null;
  original_url?: string | null;
  attribution?: string | null;
  license_code?: string | null;
};

export type RawSound = {
  file_url?: string | null;
  url?: string | null;
  attribution?: string | null;
  license_code?: string | null;
};

/** Annotations carry no labels — only the id pair, plus a full user profile. */
export type RawAnnotation = {
  controlled_attribute_id?: number;
  controlled_value_id?: number;
  user?: { login?: string | null } | null;
};

export type RawTaxon = {
  id?: number;
  name?: string | null;
  rank?: string | null;
  rank_level?: number | null;
  preferred_common_name?: string | null;
  iconic_taxon_name?: string | null;
  observations_count?: number | null;
  matched_term?: string | null;
  default_photo?: RawPhoto | null;
  /** False once a taxonomic change retires the taxon. */
  is_active?: boolean;
  /** The taxa that replace a retired one: null while active, `[]` when none is recorded. */
  current_synonymous_taxon_ids?: number[] | null;
};

export type RawIdentification = {
  id?: number;
  taxon?: RawTaxon | null;
  user?: { login?: string | null } | null;
  current?: boolean;
  category?: string | null;
  disagreement?: boolean | null;
  vision?: boolean;
  body?: string | null;
  created_at?: string | null;
  /** True once a moderator hid the entry; upstream still returns it, often with its body. */
  hidden?: boolean;
};

export type RawComment = {
  id?: number;
  user?: { login?: string | null } | null;
  body?: string | null;
  created_at?: string | null;
  /** True once a moderator hid the comment; upstream still returns it, often with its body. */
  hidden?: boolean;
};

/** One observation-field value embedded in a record — `ofvs[]` upstream. */
export type RawObservationFieldValue = {
  /** The field value's own id — the by-id page sort key, distinct from `field_id`. */
  id?: number;
  name?: string | null;
  /** The field's type: `text`, `numeric`, `taxon`, `date`, `datetime`, … */
  datatype?: string | null;
  value?: string | null;
  /** On a `taxon` field whose value upstream resolved, the full taxon record; null otherwise. */
  taxon?: RawTaxon | null;
};

/** One link from a record to an external database that holds a copy of it, e.g. its GBIF occurrence. */
export type RawOutlink = {
  source?: string | null;
  url?: string | null;
};

export type RawObservation = {
  id?: number;
  uuid?: string | null;
  uri?: string | null;
  observed_on?: string | null;
  time_observed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  taxon?: RawTaxon | null;
  community_taxon?: RawTaxon | null;
  place_guess?: string | null;
  location?: string | null;
  public_positional_accuracy?: number | null;
  obscured?: boolean;
  geoprivacy?: string | null;
  taxon_geoprivacy?: string | null;
  quality_grade?: string | null;
  license_code?: string | null;
  captive?: boolean;
  photos?: RawPhoto[] | null;
  sounds?: RawSound[] | null;
  annotations?: RawAnnotation[] | null;
  identifications?: RawIdentification[] | null;
  comments?: RawComment[] | null;
  description?: string | null;
  ofvs?: RawObservationFieldValue[] | null;
  user?: { login?: string | null } | null;
  identifications_count?: number | null;
  num_identification_agreements?: number | null;
  num_identification_disagreements?: number | null;
  identification_disagreements_count?: number | null;
  community_taxon_id?: number | null;
  /** `[]` when no external database holds the record; upstream sends it on every record. */
  outlinks?: RawOutlink[] | null;
};

export type RawGeoJsonPolygon = {
  type?: string;
  coordinates?: unknown;
};

export type RawPlace = {
  id?: number;
  name?: string | null;
  display_name?: string | null;
  place_type?: number | null;
  admin_level?: number | null;
  bounding_box_geojson?: RawGeoJsonPolygon | null;
  ancestor_place_ids?: number[] | null;
  location?: string | null;
  slug?: string | null;
  observations_count?: number | null;
};

export type RawControlledValue = {
  id?: number;
  label?: string | null;
  blocking?: boolean;
};

export type RawControlledTerm = {
  id?: number;
  label?: string | null;
  multivalued?: boolean;
  values?: RawControlledValue[] | null;
};

export type RawPopularFieldValue = {
  count?: number | null;
  controlled_attribute?: { id?: number; label?: string | null } | null;
  controlled_value?: { id?: number; label?: string | null } | null;
};

/**
 * One authority's listing for a taxon. `status` is that authority's own free
 * text ("Special Concern", "G4"), while `iucn` is the normalised scale the
 * `csi` search filter reads.
 */
export type RawConservationStatus = {
  status?: string | null;
  authority?: string | null;
  iucn?: number | null;
  url?: string | null;
  place?: { name?: string | null; display_name?: string | null } | null;
};

/** One entry of `taxon_photos`: a photo wrapped alongside a duplicate taxon record. */
export type RawTaxonPhoto = {
  photo?: RawPhoto | null;
};

/** `/taxa/{id}` — 95 KB for a common species, and the only fat document here. */
export type RawTaxonDocument = RawTaxon & {
  extinct?: boolean;
  vision?: boolean;
  listed_taxa_count?: number | null;
  ancestors?: RawTaxon[] | null;
  children?: RawTaxon[] | null;
  conservation_statuses?: RawConservationStatus[] | null;
  conservation_status?: RawConservationStatus | null;
  taxon_photos?: RawTaxonPhoto[] | null;
  wikipedia_summary?: string | null;
  wikipedia_url?: string | null;
};

/**
 * One row of `/observations/species_counts` or
 * `/identifications/similar_species` — both wrap a full taxon record in a
 * `count` whose meaning differs by endpoint.
 */
export type RawTaxonCount = {
  count?: number | null;
  taxon?: RawTaxon | null;
};

/**
 * One leaderboard row. The two endpoints differ: `/observations/observers`
 * carries `observation_count` and `species_count`, `/observations/identifiers`
 * carries `count`.
 */
export type RawLeaderboardEntry = {
  user_id?: number;
  observation_count?: number | null;
  species_count?: number | null;
  count?: number | null;
  user?: { login?: string | null } | null;
};

/** `/observations/histogram` — `results` is an object keyed by the requested interval. */
export type RawHistogram = {
  results?: Record<string, Record<string, number>> | null;
};

/** One entry of `/search`: a scored wrapper around a record of one of four kinds. */
export type RawSearchResult = {
  type?: string | null;
  score?: number | null;
  matches?: string[] | null;
  record?: (RawTaxon & RawPlace & { login?: string | null; title?: string | null }) | null;
};

// ─── Projected domain records ─────────────────────────────────────────────────

export type ProjectedPhoto = {
  square_url: string | null;
  medium_url?: string;
  attribution: string | null;
  license_code: string | null;
  open: boolean;
};

export type ProjectedSound = {
  url: string | null;
  attribution: string | null;
  license_code: string | null;
};

export type ProjectedAnnotation = {
  attribute: string | null;
  value: string | null;
  attribute_id: number;
  value_id: number;
  by: string | null;
};

/** The five-field taxon slice embedded in an observation record. */
export type TaxonSummary = {
  id: number;
  name: string | null;
  rank: string | null;
  common_name: string | null;
  iconic_taxon_name: string | null;
};

/** A standalone taxon result — a resolve-name candidate or a ranked species row. */
export type TaxonRecord = TaxonSummary & {
  rank_level?: number;
  observations_count?: number;
  photo?: ProjectedPhoto;
};

export type Coordinate = {
  lat: number;
  lng: number;
  accuracy_m: number | null;
};

export type ProjectedIdentification = {
  id: number;
  taxon: TaxonSummary | null;
  by: string | null;
  current: boolean;
  category: string | null;
  disagreement: boolean | null;
  from_vision: boolean;
  body: string | null;
  created_at: string | null;
  /** Upstream's flag, relayed only when upstream sent the key — never defaulted. */
  hidden?: boolean;
};

export type ProjectedComment = {
  id: number;
  by: string | null;
  body: string | null;
  created_at: string | null;
  /** Upstream's flag, relayed only when upstream sent the key — never defaulted. */
  hidden?: boolean;
};

/** A filled observation field — name, type, and value as the record carries them. */
export type ProjectedObservationField = {
  name: string | null;
  value: string;
  datatype: string | null;
  /** The taxon a taxon-type value names, only when upstream resolved one. */
  taxon?: TaxonSummary;
};

/** An external copy of the record — source name and URL, verbatim. */
export type ProjectedOutlink = {
  source: string | null;
  url: string | null;
};

export type ProjectedObservation = {
  id: number;
  uuid: string | null;
  url: string | null;
  observed_on: string | null;
  observed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  taxon: TaxonSummary | null;
  place_guess: string | null;
  coordinate: Coordinate | null;
  obscured: boolean;
  geoprivacy: string | null;
  taxon_geoprivacy: string | null;
  quality_grade: QualityGrade;
  license_code: string | null;
  captive: boolean;
  photo: ProjectedPhoto | null;
  photo_count: number;
  sound_count: number;
  observer: string | null;
  identifications_count: number;
  agreements: number;
  disagreements: number;
  community_taxon_id: number | null;
  /** In upstream order; absent when upstream sent no `outlinks` array. */
  outlinks?: ProjectedOutlink[];
  photos?: ProjectedPhoto[];
  annotations?: ProjectedAnnotation[];
  sounds?: ProjectedSound[];
  identifications?: ProjectedIdentification[];
  identifications_total?: number;
  identifications_shown?: number;
  identifications_hidden?: number;
  comments?: ProjectedComment[];
  comments_total?: number;
  comments_shown?: number;
  comments_hidden?: number;
  community_taxon?: TaxonSummary | null;
  identification_disagreements_count?: number;
  description?: string | null;
  observation_fields?: ProjectedObservationField[];
  observation_fields_total?: number;
  observation_fields_shown?: number;
};

export type BoundingBox = {
  swlat: number;
  swlng: number;
  nelat: number;
  nelng: number;
};

export type ProjectedPlace = {
  id: number;
  name: string | null;
  display_name: string | null;
  place_type: number | null;
  admin_level: number | null;
  bbox: BoundingBox | null;
  ancestor_place_ids: number[];
  location: { lat: number; lng: number } | null;
  slug: string | null;
};

export type ControlledTerm = {
  id: number;
  label: string | null;
  multivalued: boolean;
  values: Array<{ id: number; label: string | null; blocking: boolean }>;
};

export type ObservedUsage = {
  attribute: string | null;
  term_id: number | null;
  value: string | null;
  term_value_id: number | null;
  count: number;
};

/**
 * A photo from `/taxa/{id}`, which publishes every size variant upstream — so
 * `large_url` is relayed rather than derived, unlike an observation photo.
 */
export type ProjectedTaxonPhoto = ProjectedPhoto & {
  large_url?: string;
};

/** One rung of a taxon's ancestry, trimmed to what a rank path needs. */
export type TaxonLineage = {
  id: number;
  name: string | null;
  rank: string | null;
  common_name: string | null;
};

/** An immediate child taxon, which also carries how often it is recorded. */
export type TaxonChild = TaxonLineage & {
  observations_count: number | null;
};

/** One conservation listing, trimmed from the 640-byte upstream entry. */
export type ConservationStatus = {
  status: string | null;
  authority: string | null;
  iucn: number | null;
  /** `iucn` decoded on the published scale; null when `iucn` is null or off it. */
  iucn_code: IucnCode | null;
  place: string | null;
  url: string | null;
};

/**
 * The projected taxon profile. The flat scalars are the `summary` section for
 * overflow accounting; the five object and array keys below them are the
 * sections an agent can name in a re-call.
 */
export type ProjectedTaxonDocument = {
  id: number;
  name: string | null;
  rank: string | null;
  rank_level: number | null;
  common_name: string | null;
  iconic_taxon_name: string | null;
  is_active: boolean;
  current_synonymous_taxon_ids: number[] | null;
  extinct: boolean;
  observations_count: number | null;
  listed_taxa_count: number | null;
  vision: boolean;
  taxonomy: TaxonLineage[];
  children: TaxonChild[];
  conservation: {
    statuses: ConservationStatus[];
    global_status: ConservationStatus | null;
  };
  photos: ProjectedTaxonPhoto[];
  encyclopedia: {
    wikipedia_summary: string | null;
    wikipedia_url: string | null;
  };
};

/** One ranked species row from `/observations/species_counts`. */
export type SpeciesCount = {
  /** Absolute place in the ranking, counted from page 1. */
  position: number;
  taxon_id: number;
  name: string | null;
  common_name: string | null;
  rank: string | null;
  iconic_taxon_name: string | null;
  observation_count: number;
  photo?: ProjectedPhoto;
};

/**
 * One related taxon. The retained public `misidentification_count` counts
 * observations carrying current, non-hidden identifications of both taxa.
 */
export type SimilarSpecies = {
  taxon_id: number;
  name: string | null;
  common_name: string | null;
  rank: string | null;
  observations_count: number | null;
  misidentification_count: number;
  photo?: ProjectedPhoto;
};

/** Which leaderboard an entry came from, and therefore what `count` measures. */
export type LeaderboardKind = 'observers' | 'identifiers';

export type LeaderboardEntry = {
  rank: number;
  login: string | null;
  count: number;
  species_count?: number;
};

/** One bucket of a phenology histogram, in upstream key order. */
export type HistogramBucket = {
  key: string;
  count: number;
};

/** Which record kind a `/search` hit or a taxon autocomplete hit resolved to. */
export type CandidateKind = 'taxon' | 'place' | 'project' | 'user';

export type ResolvedCandidate = {
  kind: CandidateKind;
  id: number;
  name: string | null;
  /** Present on `kind: 'user'` only — the identifier leaderboards and observations relay. */
  login?: string;
  common_name?: string;
  rank?: string;
  /** On `kind: 'taxon'` only, whenever upstream sends it. */
  is_active?: boolean;
  /** On an inactive taxon only — upstream's array, `[]` included. */
  current_synonymous_taxon_ids?: number[];
  display_name?: string;
  slug?: string;
  matched_term?: string;
  score?: number;
  observations_count?: number;
  photo?: ProjectedPhoto;
};

/** Which embedded arrays a caller asked an observation projection to carry. */
export type ObservationExpansion =
  | 'photos'
  | 'annotations'
  | 'sounds'
  | 'identifications'
  | 'comments';
