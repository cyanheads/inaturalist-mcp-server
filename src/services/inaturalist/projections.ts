/**
 * @fileoverview Pure projections from iNaturalist's raw payloads down to the
 * records this server returns. Upstream responses cannot be trimmed at the
 * source — `fields=` is accepted and ignored — so every byte is fetched and
 * projected here.
 * @module services/inaturalist/projections
 */

import type {
  BoundingBox,
  ConservationStatus,
  ControlledTerm,
  Coordinate,
  HistogramBucket,
  LeaderboardEntry,
  LeaderboardKind,
  ObservationExpansion,
  ObservedUsage,
  ProjectedAnnotation,
  ProjectedComment,
  ProjectedIdentification,
  ProjectedObservation,
  ProjectedObservationField,
  ProjectedPhoto,
  ProjectedPlace,
  ProjectedSound,
  ProjectedTaxonDocument,
  ProjectedTaxonPhoto,
  RawAnnotation,
  RawComment,
  RawConservationStatus,
  RawControlledTerm,
  RawGeoJsonPolygon,
  RawHistogram,
  RawIdentification,
  RawLeaderboardEntry,
  RawObservation,
  RawObservationFieldValue,
  RawPhoto,
  RawPlace,
  RawPopularFieldValue,
  RawSound,
  RawTaxon,
  RawTaxonCount,
  RawTaxonDocument,
  SimilarSpecies,
  SpeciesCount,
  TaxonChild,
  TaxonLineage,
  TaxonRecord,
  TaxonSummary,
} from './types.js';
import { toQualityGrade } from './vocabularies.js';

/**
 * The host the upstream spec names for openly-licensed media. Any other host —
 * including one this server does not recognize — resolves to `open: false`,
 * because not recognizing a host is not evidence that a photo is open.
 */
const OPEN_MEDIA_HOST = 'inaturalist-open-data.s3.amazonaws.com';

/** Size qualifiers the spec documents for a photo path's last segment. */
const PHOTO_SIZE_SEGMENT = /^(?:original|large|medium|small|thumb|square)\.[A-Za-z0-9]+$/;

/** Decoded annotation vocabulary, keyed `"<attributeId>|<valueId>"`. */
export type ControlledTermIndex = {
  attributes: ReadonlyMap<number, string | null>;
  values: ReadonlyMap<string, string | null>;
};

/**
 * Splits the `"lat,lng"` string upstream uses for a coordinate, pairing it with
 * the public accuracy radius. Returns `null` when the observation carries no
 * public coordinate, which is a fact about the record rather than a parse
 * failure — an obscured observation still reports a locality and its radius.
 */
export function parseLocation(
  location: string | null | undefined,
  accuracyMetres: number | null | undefined,
): Coordinate | null {
  if (typeof location !== 'string') return null;
  const [rawLat, rawLng, ...rest] = location.split(',');
  if (rest.length > 0 || rawLat === undefined || rawLng === undefined) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, accuracy_m: typeof accuracyMetres === 'number' ? accuracyMetres : null };
}

/**
 * Reduces a place's five-point bounding polygon to its corner pair by taking the
 * min and max of the coordinates upstream holds.
 *
 * The result is relayed as computed and never repaired: a place crossing the
 * antimeridian genuinely has a degenerate box upstream, and correcting it here
 * would assert a boundary iNaturalist does not hold.
 */
export function bboxFromPolygon(geojson: RawGeoJsonPolygon | null | undefined): BoundingBox | null {
  const rings = geojson?.coordinates;
  if (!Array.isArray(rings)) return null;

  let swlat = Number.POSITIVE_INFINITY;
  let swlng = Number.POSITIVE_INFINITY;
  let nelat = Number.NEGATIVE_INFINITY;
  let nelng = Number.NEGATIVE_INFINITY;
  let seen = false;

  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const point of ring) {
      if (!Array.isArray(point)) continue;
      const [lng, lat] = point;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      swlat = Math.min(swlat, lat);
      swlng = Math.min(swlng, lng);
      nelat = Math.max(nelat, lat);
      nelng = Math.max(nelng, lng);
      seen = true;
    }
  }

  return seen ? { swlat, swlng, nelat, nelng } : null;
}

/** True when a media URL is served from the host the spec reserves for open licences. */
function isOpenMediaHost(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).hostname === OPEN_MEDIA_HOST;
  } catch {
    return false;
  }
}

/**
 * Swaps the size qualifier in a photo URL's last path segment — the substitution
 * the spec documents, with every variant sharing the source extension. A segment
 * that does not match the documented shape yields nothing rather than a guess.
 */
function deriveSizeVariant(url: string | null | undefined, size: string): string | undefined {
  if (typeof url !== 'string') return;
  const cut = url.lastIndexOf('/');
  if (cut === -1) return;
  const segment = url.slice(cut + 1);
  if (!PHOTO_SIZE_SEGMENT.test(segment)) return;
  const dot = segment.lastIndexOf('.');
  return `${url.slice(0, cut + 1)}${size}${segment.slice(dot)}`;
}

/**
 * Projects one photo. `attribution` and `license_code` are relayed verbatim — a
 * null licence means all rights reserved, which is a fact about the record and
 * is never coerced to a string. `medium_url` is used as upstream supplies it
 * (the taxon endpoints publish every variant) and derived only otherwise.
 */
export function projectPhoto(raw: RawPhoto | null | undefined): ProjectedPhoto | null {
  if (!raw) return null;
  const square = raw.square_url ?? raw.url ?? null;
  const medium = raw.medium_url ?? deriveSizeVariant(square, 'medium');
  return {
    square_url: square,
    ...(medium ? { medium_url: medium } : {}),
    attribution: raw.attribution ?? null,
    license_code: raw.license_code ?? null,
    open: isOpenMediaHost(square),
  };
}

function projectSound(raw: RawSound): ProjectedSound {
  return {
    url: raw.file_url ?? raw.url ?? null,
    attribution: raw.attribution ?? null,
    license_code: raw.license_code ?? null,
  };
}

/** Builds the lookup `decodeAnnotations` reads, from a `/controlled_terms` page. */
export function buildControlledTermIndex(terms: readonly ControlledTerm[]): ControlledTermIndex {
  const attributes = new Map<number, string | null>();
  const values = new Map<string, string | null>();
  for (const term of terms) {
    attributes.set(term.id, term.label);
    for (const value of term.values) values.set(`${term.id}|${value.id}`, value.label);
  }
  return { attributes, values };
}

/**
 * Decodes annotation id pairs against the cached vocabulary. An id pair the
 * vocabulary does not carry emits `attribute: null` with both ids intact — a
 * fabricated label would be worse than an undecoded one.
 */
export function decodeAnnotations(
  raw: readonly RawAnnotation[] | null | undefined,
  index: ControlledTermIndex | undefined,
): ProjectedAnnotation[] {
  const out: ProjectedAnnotation[] = [];
  for (const annotation of raw ?? []) {
    const attributeId = annotation.controlled_attribute_id;
    const valueId = annotation.controlled_value_id;
    if (typeof attributeId !== 'number' || typeof valueId !== 'number') continue;
    out.push({
      attribute: index?.attributes.get(attributeId) ?? null,
      value: index?.values.get(`${attributeId}|${valueId}`) ?? null,
      attribute_id: attributeId,
      value_id: valueId,
      by: annotation.user?.login ?? null,
    });
  }
  return out;
}

/** The five-field taxon slice an observation record carries. */
export function projectTaxonSummary(raw: RawTaxon | null | undefined): TaxonSummary | null {
  if (!raw || typeof raw.id !== 'number') return null;
  return {
    id: raw.id,
    name: raw.name ?? null,
    rank: raw.rank ?? null,
    common_name: raw.preferred_common_name ?? null,
    iconic_taxon_name: raw.iconic_taxon_name ?? null,
  };
}

/**
 * Projects a standalone taxon record — an autocomplete candidate, a ranked
 * species row, a look-alike. Each upstream record is 5.7–11.7 KB; this is
 * roughly 250 bytes of it.
 */
export function projectTaxonRecord(raw: RawTaxon | null | undefined): TaxonRecord | null {
  const summary = projectTaxonSummary(raw);
  if (!summary || !raw) return null;
  const photo = projectPhoto(raw.default_photo);
  return {
    ...summary,
    ...(typeof raw.rank_level === 'number' ? { rank_level: raw.rank_level } : {}),
    ...(typeof raw.observations_count === 'number'
      ? { observations_count: raw.observations_count }
      : {}),
    ...(photo ? { photo } : {}),
  };
}

function projectIdentification(raw: RawIdentification): ProjectedIdentification {
  return {
    id: raw.id ?? 0,
    taxon: projectTaxonSummary(raw.taxon),
    by: raw.user?.login ?? null,
    current: raw.current ?? false,
    category: raw.category ?? null,
    disagreement: raw.disagreement ?? null,
    from_vision: raw.vision ?? false,
    body: raw.body ?? null,
    created_at: raw.created_at ?? null,
  };
}

function projectComment(raw: RawComment): ProjectedComment {
  return {
    id: raw.id ?? 0,
    by: raw.user?.login ?? null,
    body: raw.body ?? null,
    created_at: raw.created_at ?? null,
  };
}

/**
 * Entries of each capped by-id array — `identifications[]`, `comments[]`, and
 * `observation_fields[]` — one response spends per array, shared across every
 * record it returns, so the arrays of a ten-record batch cost about what one
 * record's do. Sized from the measured per-entry reply cost — see the by-id
 * array cap in `docs/design.md`.
 */
export const THREAD_ENTRY_BUDGET = 40;

/** The fewest entries any one record keeps per capped array, however large the batch. */
export const THREAD_ENTRY_FLOOR = 4;

/** Per-record, per-array cap for a by-id response carrying `records` observations. */
export function threadCap(records: number): number {
  return Math.max(THREAD_ENTRY_FLOOR, Math.floor(THREAD_ENTRY_BUDGET / records));
}

/**
 * Projects the first `cap` entries of a thread array in upstream order, cutting
 * before projecting, and reports how many upstream held.
 */
function projectThread<Raw, Projected>(
  raw: readonly Raw[] | null | undefined,
  project: (entry: Raw) => Projected,
  cap: number | undefined,
): { entries: Projected[]; total: number } {
  const all = raw ?? [];
  const kept = cap === undefined ? all : all.slice(0, cap);
  return { entries: kept.map(project), total: all.length };
}

/**
 * Keeps an observation field only when it carries a value — a project can
 * attach a field to a record and leave it empty, and a blank row tells a reader
 * nothing — then keeps the first `cap` filled fields in upstream order. `total`
 * counts every filled field, so the cap is measured against what a reader could
 * have seen, not against the blanks.
 */
function projectObservationFields(
  raw: readonly RawObservationFieldValue[] | null | undefined,
  cap: number | undefined,
): { entries: ProjectedObservationField[]; total: number } {
  const entries: ProjectedObservationField[] = [];
  let total = 0;
  for (const field of raw ?? []) {
    if (typeof field.value !== 'string' || field.value.trim() === '') continue;
    total += 1;
    if (cap === undefined || entries.length < cap) {
      entries.push({ name: field.name ?? null, value: field.value });
    }
  }
  return { entries, total };
}

/**
 * Projects one observation to roughly 450 bytes from the ~16 KB upstream record.
 *
 * `include` selects which embedded arrays survive; everything else — the
 * `non_owner_ids` near-duplicate of `identifications`, the 40 unlabelled
 * `place_ids`, the full 22-key `user` profile, `geojson`, votes, faves, flags —
 * is dropped outright.
 *
 * `threadCap` bounds each included thread array — and, on the detail arm, the
 * filled observation fields — to its first entries in upstream order, cut
 * before projecting, so a 1,114-entry thread costs 40 projections, not 1,114.
 * Each capped array reports its upstream total beside what it kept.
 */
export function projectObservation(
  raw: RawObservation,
  options: {
    include?: ReadonlySet<ObservationExpansion>;
    terms?: ControlledTermIndex;
    detail?: boolean;
    threadCap?: number;
  } = {},
): ProjectedObservation {
  const include = options.include ?? new Set<ObservationExpansion>();
  const photos = raw.photos ?? [];
  const sounds = raw.sounds ?? [];
  const expandedPhotos = include.has('photos')
    ? photos.map(projectPhoto).filter((photo): photo is ProjectedPhoto => photo !== null)
    : undefined;
  const identifications = include.has('identifications')
    ? projectThread(raw.identifications, projectIdentification, options.threadCap)
    : undefined;
  const comments = include.has('comments')
    ? projectThread(raw.comments, projectComment, options.threadCap)
    : undefined;
  const fields = options.detail ? projectObservationFields(raw.ofvs, options.threadCap) : undefined;

  return {
    id: raw.id ?? 0,
    uuid: raw.uuid ?? null,
    url: raw.uri ?? null,
    observed_on: raw.observed_on ?? null,
    observed_at: raw.time_observed_at ?? null,
    taxon: projectTaxonSummary(raw.taxon),
    place_guess: raw.place_guess ?? null,
    coordinate: parseLocation(raw.location, raw.public_positional_accuracy),
    obscured: raw.obscured ?? false,
    geoprivacy: raw.geoprivacy ?? null,
    taxon_geoprivacy: raw.taxon_geoprivacy ?? null,
    quality_grade: toQualityGrade(raw.quality_grade),
    license_code: raw.license_code ?? null,
    captive: raw.captive ?? false,
    photo: projectPhoto(photos[0]),
    photo_count: photos.length,
    sound_count: sounds.length,
    observer: raw.user?.login ?? null,
    identifications_count: raw.identifications_count ?? 0,
    agreements: raw.num_identification_agreements ?? 0,
    disagreements: raw.num_identification_disagreements ?? 0,
    community_taxon_id: raw.community_taxon_id ?? null,
    ...(expandedPhotos ? { photos: expandedPhotos } : {}),
    ...(include.has('annotations')
      ? { annotations: decodeAnnotations(raw.annotations, options.terms) }
      : {}),
    ...(include.has('sounds') ? { sounds: sounds.map(projectSound) } : {}),
    ...(identifications
      ? {
          identifications: identifications.entries,
          identifications_total: identifications.total,
          identifications_shown: identifications.entries.length,
        }
      : {}),
    ...(comments
      ? {
          comments: comments.entries,
          comments_total: comments.total,
          comments_shown: comments.entries.length,
        }
      : {}),
    ...(fields
      ? {
          community_taxon: projectTaxonSummary(raw.community_taxon),
          identification_disagreements_count: raw.identification_disagreements_count ?? 0,
          description: raw.description ?? null,
          observation_fields: fields.entries,
          observation_fields_total: fields.total,
          observation_fields_shown: fields.entries.length,
        }
      : {}),
  };
}

/**
 * Projects a place, dropping `geometry_geojson` — 246,887 bytes of it for two
 * nearby results — and reducing the bounding polygon to its corner pair.
 *
 * `place_type` and `admin_level` are relayed as the raw integers upstream
 * returns: the spec publishes no code table for either, so no label is invented
 * and `display_name` carries the human-readable context.
 */
export function projectPlace(raw: RawPlace): ProjectedPlace {
  const centre = parseLocation(raw.location, null);
  return {
    id: raw.id ?? 0,
    name: raw.name ?? null,
    display_name: raw.display_name ?? null,
    place_type: raw.place_type ?? null,
    admin_level: raw.admin_level ?? null,
    bbox: bboxFromPolygon(raw.bounding_box_geojson),
    ancestor_place_ids: raw.ancestor_place_ids ?? [],
    location: centre ? { lat: centre.lat, lng: centre.lng } : null,
    slug: raw.slug ?? null,
  };
}

/** Projects the `/controlled_terms` page to the annotation vocabulary. */
export function projectControlledTerm(raw: RawControlledTerm): ControlledTerm {
  return {
    id: raw.id ?? 0,
    label: raw.label ?? null,
    multivalued: raw.multivalued ?? false,
    values: (raw.values ?? []).map((value) => ({
      id: value.id ?? 0,
      label: value.label ?? null,
      blocking: value.blocking ?? false,
    })),
  };
}

/**
 * Projects observed annotation usage for one taxon. The per-entry
 * `month_of_year` breakdown is dropped — the question this answers is which
 * annotations exist for a taxon, not when they were recorded.
 */
export function projectObservedUsage(raw: RawPopularFieldValue): ObservedUsage {
  return {
    attribute: raw.controlled_attribute?.label ?? null,
    value: raw.controlled_value?.label ?? null,
    count: raw.count ?? 0,
  };
}

/**
 * Projects a photo from `/taxa/{id}`, which publishes every size variant, so
 * `large_url` is relayed rather than derived.
 */
export function projectTaxonPhoto(raw: RawPhoto | null | undefined): ProjectedTaxonPhoto | null {
  const photo = projectPhoto(raw);
  if (!photo || !raw) return null;
  return { ...photo, ...(raw.large_url ? { large_url: raw.large_url } : {}) };
}

/** One ancestry rung, trimmed to the four fields a rank path renders. */
export function projectTaxonLineage(raw: RawTaxon | null | undefined): TaxonLineage | null {
  if (!raw || typeof raw.id !== 'number') return null;
  return {
    id: raw.id,
    name: raw.name ?? null,
    rank: raw.rank ?? null,
    common_name: raw.preferred_common_name ?? null,
  };
}

/** An immediate child, which also carries how often it is recorded. */
export function projectTaxonChild(raw: RawTaxon): TaxonChild | null {
  const lineage = projectTaxonLineage(raw);
  if (!lineage) return null;
  return { ...lineage, observations_count: raw.observations_count ?? null };
}

/**
 * Projects one conservation listing. `place` collapses to its display name: the
 * upstream entry embeds a full place record, and the authority plus the place
 * name is what identifies a listing.
 */
export function projectConservationStatus(raw: RawConservationStatus): ConservationStatus {
  return {
    status: raw.status ?? null,
    authority: raw.authority ?? null,
    iucn: raw.iucn ?? null,
    place: raw.place?.display_name ?? raw.place?.name ?? null,
    url: raw.url ?? null,
  };
}

/**
 * Projects the taxon profile before anything measures it. `listed_taxa` (26 KB
 * of per-country checklist membership) is dropped for its scalar count, and the
 * full taxon record duplicated inside every `taxon_photos[]` entry goes with it
 * — so the overflow path fires on a genuinely large taxon rather than on every
 * taxon.
 */
export function projectTaxonDocument(
  raw: RawTaxonDocument | null | undefined,
): ProjectedTaxonDocument | null {
  if (!raw || typeof raw.id !== 'number') return null;
  return {
    id: raw.id,
    name: raw.name ?? null,
    rank: raw.rank ?? null,
    rank_level: raw.rank_level ?? null,
    common_name: raw.preferred_common_name ?? null,
    iconic_taxon_name: raw.iconic_taxon_name ?? null,
    is_active: raw.is_active ?? false,
    extinct: raw.extinct ?? false,
    observations_count: raw.observations_count ?? null,
    listed_taxa_count: raw.listed_taxa_count ?? null,
    vision: raw.vision ?? false,
    taxonomy: (raw.ancestors ?? [])
      .map(projectTaxonLineage)
      .filter((entry): entry is TaxonLineage => entry !== null),
    children: (raw.children ?? [])
      .map(projectTaxonChild)
      .filter((entry): entry is TaxonChild => entry !== null),
    conservation: {
      statuses: (raw.conservation_statuses ?? []).map(projectConservationStatus),
      global_status: raw.conservation_status
        ? projectConservationStatus(raw.conservation_status)
        : null,
    },
    photos: (raw.taxon_photos ?? [])
      .map((entry) => projectTaxonPhoto(entry.photo))
      .filter((photo): photo is ProjectedTaxonPhoto => photo !== null),
    encyclopedia: {
      wikipedia_summary: raw.wikipedia_summary ?? null,
      wikipedia_url: raw.wikipedia_url ?? null,
    },
  };
}

/** One ranked species row. The upstream `count` is observations of that taxon. */
export function projectSpeciesCount(raw: RawTaxonCount): SpeciesCount | null {
  const record = projectTaxonRecord(raw.taxon);
  if (!record) return null;
  return {
    taxon_id: record.id,
    name: record.name,
    common_name: record.common_name,
    rank: record.rank,
    iconic_taxon_name: record.iconic_taxon_name,
    observation_count: raw.count ?? 0,
    ...(record.photo ? { photo: record.photo } : {}),
  };
}

/**
 * One look-alike. The same `{ count, taxon }` envelope as a species count, but
 * `count` here is how many times identifiers corrected this taxon to the
 * queried one — so it is named for that rather than relayed as `count`.
 */
export function projectSimilarSpecies(raw: RawTaxonCount): SimilarSpecies | null {
  const record = projectTaxonRecord(raw.taxon);
  if (!record) return null;
  return {
    taxon_id: record.id,
    name: record.name,
    common_name: record.common_name,
    rank: record.rank,
    observations_count: record.observations_count ?? null,
    misidentification_count: raw.count ?? 0,
    ...(record.photo ? { photo: record.photo } : {}),
  };
}

/**
 * Normalises the two leaderboard shapes onto one row. `/observations/observers`
 * counts observations and also reports distinct species; `/observations/identifiers`
 * counts identifications and reports neither.
 */
export function projectLeaderboardEntry(
  raw: RawLeaderboardEntry,
  rank: number,
  kind: LeaderboardKind,
): LeaderboardEntry {
  const count = (kind === 'observers' ? raw.observation_count : raw.count) ?? 0;
  return {
    rank,
    login: raw.user?.login ?? null,
    count,
    ...(kind === 'observers' && typeof raw.species_count === 'number'
      ? { species_count: raw.species_count }
      : {}),
  };
}

/**
 * Turns the histogram's interval-keyed object into an ordered array, so a
 * reading model sees the bucket sequence rather than having to trust key order
 * in a JSON object.
 */
export function histogramBuckets(raw: RawHistogram, interval: string): HistogramBucket[] {
  const table = raw.results?.[interval] ?? {};
  return Object.entries(table).map(([key, count]) => ({
    key,
    count: typeof count === 'number' ? count : 0,
  }));
}
