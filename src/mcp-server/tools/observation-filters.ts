/**
 * @fileoverview The filter surface every area-scoped iNaturalist tool shares —
 * Zod shape fragments plus the in-process validation upstream does not perform.
 *
 * The API answers almost any malformed query with HTTP 200 and a plausible
 * result set: a lone `lat` searches the whole 387M-record index, a `d1` it
 * cannot parse drops the date filter entirely, and a `term_value_id` without its
 * `term_id` is ignored. Each helper here returns a result rather than throwing,
 * so the calling handler keeps its own literal `ctx.fail` and its own recovery
 * string.
 *
 * @module mcp-server/tools/observation-filters
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { QueryParams } from '@/services/inaturalist/inaturalist-service.js';
import {
  ICONIC_TAXA,
  QUALITY_GRADES,
  RANK_LEVEL,
  type Rank,
} from '@/services/inaturalist/vocabularies.js';

/** A validated filter fragment, or the sentence explaining what the caller must change. */
export type FilterResult<T> = { ok: true; value: T } | { ok: false; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when a `YYYY-MM-DD` string names a day that exists. Upstream drops a
 * `2026-02-30` or `2025-13-01` bound exactly as it drops `notadate`, so the
 * shape regex alone does not stop the silent widening. A value the pattern
 * already rejects passes here, so a malformed date carries one issue, not two.
 * `setUTCFullYear` rather than `Date.UTC`, which reads years 0–99 as 1900–1999
 * and would reject `0000-02-29`, a day upstream honours.
 */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return true;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * An observed-on bound. The pattern is what JSON Schema advertises; the
 * calendar refinement rejects at the same schema layer, so an impossible date
 * fails exactly the way a malformed one does.
 */
const observedOnDate = z
  .string()
  .regex(ISO_DATE)
  .refine(isCalendarDate, { message: 'not a real calendar date — check the month and day.' })
  .optional();

/**
 * Form clients submit every optional string field, blank when the user left it
 * empty. A blank is "unset", never a value to validate, so it is dropped before
 * the field's own validator runs. Wrap an optional string schema with this; the
 * advertised JSON Schema is unchanged, since only the inner schema is emitted.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/** The upstream result window: `page × per_page` past this answers HTTP 403. */
export const RESULT_WINDOW = 10_000;

/**
 * The addressable window on `/observations/observers` and
 * `/observations/identifiers` — far tighter than the 10,000 above, and unsignalled:
 * past it both endpoints answer 200 with an empty result set, which is
 * indistinguishable from a genuine zero-hit.
 */
export const LEADERBOARD_WINDOW = 500;

/**
 * The three mutually exclusive ways to name an area. Supplied partially or in
 * two forms at once, upstream silently widens to the global index, so the shape
 * is validated as a unit by {@link resolveArea}.
 */
export const areaInputShape = {
  place_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Numeric iNaturalist place id from inaturalist_find_places. Mutually exclusive with the lat/lng/radius triple and the bounding box. A non-numeric value answers HTTP 500 upstream.',
    ),
  lat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('Latitude of the search centre, in decimal degrees. Requires lng and radius.'),
  lng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe('Longitude of the search centre, in decimal degrees. Requires lat and radius.'),
  radius: z
    .number()
    .max(500)
    .optional()
    .describe(
      'Search radius around lat/lng, in KILOMETRES, greater than 0. Requires lat and lng. The upstream publishes no bound; 500 is a verified ceiling this server imposes.',
    ),
  nelat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe(
      'North-east corner latitude of the bounding box, at or north of swlat. All four corners or none.',
    ),
  nelng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe(
      'North-east corner longitude of the bounding box. All four corners or none. West of swlng is accepted: it describes a box crossing the antimeridian.',
    ),
  swlat: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe('South-west corner latitude of the bounding box. All four corners or none.'),
  swlng: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe('South-west corner longitude of the bounding box. All four corners or none.'),
};

/**
 * Observed-on date bounds. A value upstream cannot parse — malformed or not a
 * real calendar day — drops the filter silently, and d1 after d2 narrows to
 * zero; {@link resolveDateRange} checks the order.
 */
export const dateRangeInputShape = {
  d1: blankAsUnset(observedOnDate).describe(
    'Earliest observation date, YYYY-MM-DD. Inclusive. Must be on or before d2.',
  ),
  d2: blankAsUnset(observedOnDate).describe('Latest observation date, YYYY-MM-DD. Inclusive.'),
};

/** The two defaults that most determine what an answer means, plus the annotation pair. */
export const observationFilterInputShape = {
  quality_grade: z
    .array(z.enum(QUALITY_GRADES))
    .min(1)
    .default(['research'])
    .describe(
      'Identification confidence tiers to include. Defaults to research-grade only; adding "needs_id" roughly doubles the corpus and lowers identification confidence.',
    ),
  captive: z
    .boolean()
    .default(false)
    .describe(
      'Whether to include captive and cultivated records — zoo animals, garden plantings. Defaults to wild organisms only.',
    ),
  term_id: z
    .array(z.number().int().min(1))
    .optional()
    .describe(
      'Annotation attribute ids, from inaturalist_list_reference topic controlled_terms — e.g. 1 for Life Stage.',
    ),
  term_value_id: z
    .array(z.number().int().min(1))
    .optional()
    .describe(
      'Annotation value ids, from the same attribute listing — e.g. 6 for Larva. Requires term_id; sent alone it is ignored upstream and the unfiltered corpus comes back.',
    ),
  iconic_taxa: z
    .array(z.enum(ICONIC_TAXA))
    .optional()
    .describe(
      'Broad organism groups, by their scientific iconic-taxon name. A common-name value such as "Birds" matches nothing upstream, so only the listed values are accepted.',
    ),
};

export type AreaInput = {
  place_id?: number | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  radius?: number | undefined;
  nelat?: number | undefined;
  nelng?: number | undefined;
  swlat?: number | undefined;
  swlng?: number | undefined;
};

function present(...values: Array<number | undefined>): number {
  return values.filter((value) => value !== undefined).length;
}

/**
 * Reduces the three area forms to the upstream parameters for exactly one of
 * them, or explains why the combination cannot be sent. No area at all is a
 * valid global search and resolves to an empty fragment.
 */
export function resolveArea(input: AreaInput): FilterResult<QueryParams> {
  const triple = present(input.lat, input.lng, input.radius);
  const box = present(input.nelat, input.nelng, input.swlat, input.swlng);
  const place = input.place_id === undefined ? 0 : 1;
  const forms = place + (triple > 0 ? 1 : 0) + (box > 0 ? 1 : 0);

  if (forms === 0) return { ok: true, value: {} };
  if (forms > 1) {
    return {
      ok: false,
      message:
        'The area was given in more than one form. Use exactly one of place_id, the lat/lng/radius triple, or the four-corner bounding box.',
    };
  }
  if (triple > 0 && triple < 3) {
    return {
      ok: false,
      message: `The coordinate triple is incomplete — ${triple} of lat, lng and radius were supplied. A partial triple is not narrowed upstream; it searches the entire global index.`,
    };
  }
  if (box > 0 && box < 4) {
    return {
      ok: false,
      message: `The bounding box is incomplete — ${box} of nelat, nelng, swlat and swlng were supplied.`,
    };
  }

  if (place === 1) return { ok: true, value: { place_id: input.place_id } };
  if (triple === 3) {
    // Upstream answers a radius of 0 or less with HTTP 500, which the client then retries.
    if ((input.radius ?? 0) <= 0) {
      return {
        ok: false,
        message: `radius must be greater than 0 kilometres; ${input.radius} was supplied. Upstream fails on a radius of 0 or less rather than returning an empty result.`,
      };
    }
    return { ok: true, value: { lat: input.lat, lng: input.lng, radius: input.radius } };
  }
  const bboxProblem = checkBoundingBox(input);
  if (bboxProblem) return { ok: false, message: bboxProblem };
  return {
    ok: true,
    value: {
      nelat: input.nelat,
      nelng: input.nelng,
      swlat: input.swlat,
      swlng: input.swlng,
    },
  };
}

/**
 * The corner-order rule for a complete bounding box, shared with
 * `inaturalist_find_places`, which validates its own corners. A box whose
 * `nelat` is south of `swlat` answers HTTP 500 upstream. `nelng` west of
 * `swlng` is deliberately allowed: that box crosses the antimeridian, and
 * upstream serves it.
 *
 * @returns The sentence naming the problem, or undefined when the box is valid.
 */
export function checkBoundingBox(box: {
  nelat?: number | undefined;
  swlat?: number | undefined;
}): string | undefined {
  if (box.nelat === undefined || box.swlat === undefined || box.nelat >= box.swlat) return;
  return `nelat ${box.nelat} is south of swlat ${box.swlat}. The north-east corner must be at or north of the south-west corner; upstream fails on an inverted box rather than returning an empty result.`;
}

/**
 * Validates the observed-on range. `d1` after `d2` answers HTTP 200 with zero
 * results, which reads as a genuine zero-hit. Equal bounds are a single day.
 * Both are already `YYYY-MM-DD`, so string order is date order.
 */
export function resolveDateRange(input: {
  d1?: string | undefined;
  d2?: string | undefined;
}): FilterResult<QueryParams> {
  const { d1, d2 } = input;
  if (d1 !== undefined && d2 !== undefined && d1 > d2) {
    return {
      ok: false,
      message: `d1 ${d1} is after d2 ${d2}. Upstream answers an inverted range with zero results rather than an error.`,
    };
  }
  return { ok: true, value: { d1, d2 } };
}

/**
 * Validates the identification rank band. Upstream compares rank levels, so an
 * `hrank` at a finer level than `lrank` matches nothing and answers HTTP 200
 * with zero results. Ranks at the same level — an equal pair, or species and
 * hybrid — are a valid exact-level band.
 */
export function resolveRankRange(input: {
  hrank?: Rank | undefined;
  lrank?: Rank | undefined;
}): FilterResult<QueryParams> {
  const { hrank, lrank } = input;
  if (hrank !== undefined && lrank !== undefined && RANK_LEVEL[hrank] < RANK_LEVEL[lrank]) {
    return {
      ok: false,
      message: `hrank "${hrank}" is finer than lrank "${lrank}". hrank is the highest (coarsest) rank to accept and lrank the lowest (finest); inverted, upstream matches nothing and answers with zero results.`,
    };
  }
  return { ok: true, value: { hrank, lrank } };
}

/**
 * Validates the annotation pair. `term_value_id` alone is silently ignored
 * upstream, so the caller reads an unfiltered corpus believing it was filtered.
 */
export function resolveAnnotation(input: {
  term_id?: readonly number[] | undefined;
  term_value_id?: readonly number[] | undefined;
}): FilterResult<QueryParams> {
  const attributes = input.term_id ?? [];
  const values = input.term_value_id ?? [];
  if (values.length > 0 && attributes.length === 0) {
    return {
      ok: false,
      message:
        'term_value_id was supplied without term_id. Upstream ignores the value on its own and returns the unfiltered corpus.',
    };
  }
  return {
    ok: true,
    value: {
      ...(attributes.length > 0 ? { term_id: [...attributes] } : {}),
      ...(values.length > 0 ? { term_value_id: [...values] } : {}),
    },
  };
}

/**
 * The ways to widen an empty answer, one per narrowing filter the call actually
 * supplied, joined into a sentence — guidance naming a filter the caller never
 * set sends it after a cause that is not there. Undefined when nothing the
 * caller controls narrowed the query.
 */
export function wideningGuidance(
  input: {
    d1?: string | undefined;
    d2?: string | undefined;
    taxon_id?: number | undefined;
    quality_grade: readonly string[];
  },
  hasArea: boolean,
): string | undefined {
  const options = [
    ...(input.d1 !== undefined || input.d2 !== undefined ? ['widen or drop d1/d2'] : []),
    ...(hasArea ? ['widen the area'] : []),
    ...(input.taxon_id !== undefined
      ? ['drop taxon_id or confirm it with inaturalist_resolve_name']
      : []),
    ...(input.quality_grade.includes('needs_id')
      ? []
      : ['set quality_grade to include "needs_id"']),
  ];
  const last = options.pop();
  if (last === undefined) return;
  const sentence = options.length > 0 ? `${options.join(', ')}, or ${last}` : last;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * True when a page request would reach past an addressable window. `/observations`
 * answers HTTP 403 past 10,000; the leaderboard endpoints instead return an
 * empty page past 500, which is indistinguishable from a genuine zero-hit.
 */
export function exceedsWindow(page: number, perPage: number, window: number): boolean {
  return page * perPage > window;
}
