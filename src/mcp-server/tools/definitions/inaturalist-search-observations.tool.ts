/**
 * @fileoverview Searches georeferenced iNaturalist sightings by area, date,
 * taxon, quality grade, annotation, conservation status, observer, project,
 * and licence.
 * @module mcp-server/tools/definitions/inaturalist-search-observations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { applyLimit, LIMIT_CAPS, limitSchema } from '@/mcp-server/tools/limit-policy.js';
import {
  areaInputShape,
  blankAsUnset,
  dateRangeInputShape,
  emptyFilterNotice,
  emptyPageNotice,
  exceedsWindow,
  observationFilterInputShape,
  observerProjectInputShape,
  RESULT_WINDOW,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
  resolveObserver,
  resolveRankRange,
} from '@/mcp-server/tools/observation-filters.js';
import {
  renderObservation,
  SearchObservationSchema,
} from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';
import type { ObservationExpansion } from '@/services/inaturalist/types.js';
import {
  CONSERVATION_STATUS_CODES,
  LICENSE_CODES,
  RANKS,
} from '@/services/inaturalist/vocabularies.js';

const RESPONSE_BUDGET_BYTES = 50_000;
const RESPONSE_OVERHEAD_BYTES = 4_096;
const utf8 = new TextEncoder();

const ORDER_BY = [
  'created_at',
  'geo_score',
  'id',
  'observed_on',
  'random',
  'species_guess',
  'updated_at',
  'votes',
] as const;

/**
 * One licence code. Upstream reads `CC0` and `CC-BY` exactly as `cc0` and
 * `cc-by`, and callers write licences that way, so a case variant is lowercased
 * before the enum; anything outside the seven codes — the topic's `null`
 * included — narrows upstream to zero and is refused here instead.
 */
const licenseCode = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(LICENSE_CODES),
);

const SearchPageSchema = z.object({
  total_results: z
    .number()
    .describe(
      'How many records upstream reports as matching. An estimate over a live index — it drifts between calls seconds apart.',
    ),
  observations: z.array(SearchObservationSchema).describe('The matching sightings, projected.'),
  deferred: z
    .array(
      z
        .object({
          observation_id: z
            .number()
            .describe(
              'Observation id to retrieve through inaturalist_get_observation with the same include values.',
            ),
        })
        .describe('One fetched observation deferred for a by-id call.'),
    )
    .describe(
      'Ordered ids of the fetched-page suffix omitted from observations to meet the response budget. Empty when the whole page fits; independent of has_more.',
    ),
  next_cursor: z
    .string()
    .optional()
    .describe(
      'Pass back as cursor to continue past this page. Present only when has_more is true and the page was ordered by id descending; under any other ordering, raise page instead.',
    ),
  has_more: z
    .boolean()
    .describe(
      'True when the fetched page filled the applied per_page and more records follow, independent of deferred ids. On the page path an exactly full final page is false; under a cursor, where the offset is unknown, every full page is true.',
    ),
});

type SearchPage = z.infer<typeof SearchPageSchema>;

export const inaturalistSearchObservations = tool('inaturalist_search_observations', {
  description:
    'Search georeferenced wildlife sightings by area, date, taxon, quality grade, annotation, conservation status, observer, project, and licence. Returns a projected record per sighting with coordinates, licence, first photo, and identification counts. An area is given in exactly one form — place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box — and defaults to research-grade, wild-only records, which are echoed back on every call. Identifications and comments are deliberately not expandable here (one thread is 28 KB); fetch them for specific records with inaturalist_get_observation. page walks the first 10,000 results under any ordering; past 10,000, order by id descending (order_by "id", order "desc") and pass each page’s next_cursor as cursor.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    ...areaInputShape,
    taxon_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Restrict to this taxon and its descendants. Resolve a name to an id with inaturalist_resolve_name.',
      ),
    ...dateRangeInputShape,
    ...observationFilterInputShape,
    ...observerProjectInputShape,
    hrank: z
      .enum(RANKS)
      .optional()
      .describe(
        'Highest (coarsest) taxonomic rank of the identification to accept. Must be at or above lrank; ranks compare by rank level.',
      ),
    lrank: z
      .enum(RANKS)
      .optional()
      .describe(
        'Lowest (finest) taxonomic rank of the identification to accept. Equal to hrank for an exact-rank match.',
      ),
    csi: z
      .array(z.enum(CONSERVATION_STATUS_CODES))
      .optional()
      .describe(
        'IUCN-normalised conservation status codes to include, e.g. ["EN","CR"]. Decode them with inaturalist_list_reference topic conservation_status_codes.',
      ),
    threatened: z
      .boolean()
      .optional()
      .describe('Restrict to taxa considered threatened where observed.'),
    native: z.boolean().optional().describe('Restrict to taxa native to the observation location.'),
    introduced: z
      .boolean()
      .optional()
      .describe('Restrict to taxa introduced to the observation location.'),
    endemic: z
      .boolean()
      .optional()
      .describe('Restrict to taxa endemic to the observation location.'),
    licensed: z
      .boolean()
      .optional()
      .describe(
        'Restrict to records whose own license_code is not null — any licence, NonCommercial and NoDerivatives variants included. For specific licences, use license.',
      ),
    photo_licensed: z
      .boolean()
      .optional()
      .describe(
        'Restrict to records with at least one licensed photo, under any licence. For specific licences, use photo_license.',
      ),
    license: z
      .array(licenseCode)
      .optional()
      .describe(
        'Restrict to records whose own license_code is one of these, e.g. ["cc-by","cc0"] for reuse with attribution only. Decode the codes with inaturalist_list_reference topic licenses; all-rights-reserved records have no code to pass.',
      ),
    sounds: z
      .boolean()
      .optional()
      .describe(
        'True selects observations with sounds; false selects those without. Omit for either. Use include: ["sounds"] to expand sound metadata; no media is downloaded.',
      ),
    photo_license: z
      .array(licenseCode)
      .optional()
      .describe(
        'Restrict to records carrying at least one photo under one of these licence codes. Matched independently of the record’s own license_code, so check each photo’s license_code before reusing it.',
      ),
    q: blankAsUnset(z.string().min(1).optional()).describe(
      'Free text matched across observation properties.',
    ),
    search_on: z
      .enum(['names', 'tags', 'description', 'place'])
      .optional()
      .describe('Narrow what q matches against. Requires q.'),
    order_by: z
      .enum(ORDER_BY)
      .default('observed_on')
      .describe(
        'Sort field. Set "id" with order "desc" to walk past 10,000 results: that is the one ordering next_cursor continues, so it is the only one that issues a next_cursor. A cursor forces it.',
      ),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Page number within the first 10,000 results, under any ordering. Defaults to 1. Mutually exclusive with cursor.',
      ),
    cursor: blankAsUnset(
      z
        .string()
        .regex(/^[1-9]\d*$/)
        .optional(),
    ).describe(
      'next_cursor from a previous id-descending page, to continue past the 10,000-result window — a positive integer observation id, sent upstream as id_below. Mutually exclusive with page, and forces order_by "id", order "desc".',
    ),
    per_page: limitSchema(
      LIMIT_CAPS.searchObservations,
      10,
      'Records fetched per page. Complete records may be deferred to keep the response within its byte budget; retrieve deferred ids through inaturalist_get_observation with the same include values.',
    ),
    include: z
      .array(z.enum(['photos', 'annotations', 'sounds']))
      .optional()
      .describe(
        'Embedded arrays to expand per record. Check photo_count and sound_count first — expanding costs context.',
      ),
  }),

  output: SearchPageSchema,

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z
          .array(z.string())
          .describe(
            'Identification tiers actually searched, normalized to unique values in first-appearance order.',
          ),
        captive: z.boolean().describe('Captive-only when true, wild-only when false.'),
        order_by: z.string().describe('Sort field actually sent upstream.'),
        order: z.string().describe('Sort direction actually sent upstream.'),
        ordering_forced_by_cursor: z
          .boolean()
          .describe('True when a cursor overrode the requested ordering.'),
      })
      .describe('The server-applied defaults and overrides that determine what this answer means.'),
    truncated: z.boolean().describe('True when records were deferred or more pages follow.'),
    shown: z.number().describe('How many records this page carries.'),
    cap: z.number().describe('The per_page that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Composed guidance for applied limits, ignored filters, empty pages, deferred ids and pagination.',
      ),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) =>
        `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')} · captive: ${filters.captive} · ordered by ${filters.order_by} ${filters.order}${filters.ordering_forced_by_cursor ? ' (forced by cursor)' : ''}`,
    },
  },

  errors: [
    {
      reason: 'unknown_place_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because place_id does not exist.',
      recovery: 'Find the area with inaturalist_find_places and pass the place id it returns.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_geography',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An area was given partially, in two forms at once, with a radius of 0 or less, or with nelat south of swlat.',
      recovery:
        'Pass lat, lng and a radius above 0 together, or all four of nelat, nelng, swlat and swlng with nelat at or north of swlat, or a single place_id from inaturalist_find_places.',
    },
    {
      reason: 'inverted_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'd1 is after d2.',
      recovery:
        'Pass d1 on or before d2 — both bounds are inclusive, so equal dates select a single day.',
    },
    {
      reason: 'inverted_rank_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'hrank is a finer rank than lrank.',
      recovery:
        'Set hrank to the coarser rank and lrank to the finer one, or pass the same rank to both for an exact-rank match; list the ranks with inaturalist_list_reference topic ranks.',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page multiplied by per_page would reach past the upstream 10,000-result window.',
      recovery:
        'Past 10,000 results only the cursor continues, and only on an id-descending walk: re-run with order_by "id" and order "desc", then pass each page\'s next_cursor as cursor. Otherwise narrow the filters to bring the records into the first 10,000.',
    },
    {
      reason: 'conflicting_pagination',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both page and cursor were supplied.',
      recovery:
        'Pass page alone to walk the first 10,000 results, or cursor alone to continue past that window.',
    },
    {
      reason: 'unpaired_annotation_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'term_value_id was supplied without term_id.',
      recovery:
        'Pass term_id alongside term_value_id; list the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.',
    },
    {
      reason: 'search_on_without_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'search_on was supplied without q.',
      recovery:
        'Pass q alongside search_on, or drop search_on to search every observation property.',
    },
    {
      reason: 'conflicting_observer',
      code: JsonRpcErrorCode.ValidationError,
      when: 'user_id and user_login were both supplied.',
      recovery:
        'Pass one observer, as user_id or user_login — each names the observer on its own, and a mismatched pair matches nothing.',
    },
    {
      reason: 'unknown_taxon_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the taxon_id does not exist.',
      recovery:
        'Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_user',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the user_id or user_login names no observer.',
      recovery:
        'Resolve the observer with inaturalist_resolve_name type user and pass the id or login it returns.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_project_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the project_id does not exist.',
      recovery:
        'Resolve the project name with inaturalist_resolve_name type project and pass the id it returns.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    input = { ...input, quality_grade: [...new Set(input.quality_grade)] };
    const area = resolveArea(input);
    if (!area.ok) {
      throw ctx.fail('invalid_geography', area.message);
    }

    const dates = resolveDateRange(input);
    if (!dates.ok) {
      throw ctx.fail('inverted_date_range', dates.message);
    }

    const ranks = resolveRankRange(input);
    if (!ranks.ok) {
      throw ctx.fail('inverted_rank_range', ranks.message);
    }

    const annotation = resolveAnnotation(input);
    if (!annotation.ok) {
      throw ctx.fail('unpaired_annotation_value', annotation.message);
    }

    const observer = resolveObserver(input);
    if (!observer.ok) {
      throw ctx.fail('conflicting_observer', observer.message);
    }

    if (input.search_on !== undefined && input.q === undefined) {
      throw ctx.fail(
        'search_on_without_query',
        'search_on narrows what q matches, so it does nothing without q.',
      );
    }

    if (input.cursor !== undefined && input.page !== undefined) {
      throw ctx.fail(
        'conflicting_pagination',
        'page and cursor are different mechanisms and cannot be combined.',
      );
    }

    const limit = applyLimit(
      input.per_page,
      LIMIT_CAPS.searchObservations,
      ctx,
      'inaturalist_search_observations',
      'per_page',
    );
    const perPage = limit.applied;
    const page = input.page ?? 1;
    const usingCursor = input.cursor !== undefined;
    if (!usingCursor && exceedsWindow(page, perPage, RESULT_WINDOW)) {
      throw ctx.fail(
        'result_window_exceeded',
        `page ${page} × per_page ${perPage} reaches past the ${RESULT_WINDOW}-result window upstream will serve.`,
      );
    }

    const orderBy = usingCursor ? 'id' : input.order_by;
    const order = usingCursor ? 'desc' : input.order;
    const params: QueryParams = {
      ...area.value,
      ...annotation.value,
      ...dates.value,
      ...ranks.value,
      ...observer.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      csi: input.csi,
      threatened: input.threatened,
      native: input.native,
      introduced: input.introduced,
      endemic: input.endemic,
      licensed: input.licensed,
      photo_licensed: input.photo_licensed,
      sounds: input.sounds,
      license: input.license,
      photo_license: input.photo_license,
      q: input.q,
      search_on: input.search_on,
      order_by: orderBy,
      order,
      per_page: perPage,
      ...(usingCursor ? { id_below: input.cursor } : { page }),
    };

    ctx.log.info('Searching observations', {
      perPage,
      usingCursor,
      hasArea: Object.keys(area.value).length > 0,
    });

    const include = new Set<ObservationExpansion>(input.include ?? []);
    const { total, observations } = await getINaturalistService().searchObservations(
      params,
      include,
      ctx,
    );
    const ignoredFilters = emptyFilterNotice(input);
    const notices = [limit.notice, ignoredFilters].filter(
      (notice): notice is string => notice !== undefined,
    );

    /** Required disclosure on every path; nonempty pages update it after budgeting. */
    ctx.enrich({
      applied_filters: {
        quality_grade: input.quality_grade,
        captive: input.captive,
        order_by: orderBy,
        order,
        ordering_forced_by_cursor: usingCursor,
      },
      truncated: false,
      shown: observations.length,
      cap: perPage,
    });

    if (observations.length === 0) {
      // On the page path a non-zero total means this page, not the filters, came
      // back empty. A cursor walk has no page offset, and its upstream total
      // counts only what lies below the cursor.
      ctx.enrich.notice(
        [
          ...notices,
          !usingCursor && total > 0
            ? emptyPageNotice({ page, perPage, total, noun: 'records' })
            : zeroHitNotice(input),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return { total_results: total, observations, deferred: [], has_more: false };
    }

    // A full page is necessary but not sufficient: on the page path the offset
    // is known, so an exactly-full final page is reported as the end rather than
    // sending the agent after a page that does not exist. Under a cursor the
    // offset is unknown and a full page is the only signal there is.
    const hasMore = observations.length >= perPage && (usingCursor || page * perPage < total);
    // `id_below` continues only an id-descending walk: under any other ordering
    // it repeats or skips records, and under `id asc` it walks back over page 1.
    const idDescending = orderBy === 'id' && order === 'desc';
    const last = observations.at(-1);
    const nextCursor = hasMore && idDescending && last ? String(last.id) : undefined;
    if (hasMore) {
      let guidance = `More records match. Raise page to ${page + 1} to continue.`;
      if (nextCursor) {
        guidance = `More records match. Pass cursor "${nextCursor}" to continue; beyond 10,000 results the cursor is the only mechanism that works.`;
      } else if (exceedsWindow(page + 1, perPage, RESULT_WINDOW)) {
        guidance = `This page ends at the 10,000-result window upstream serves, and no cursor continues order_by "${orderBy}", order "${order}". To continue past it, re-run with order_by "id" and order "desc" and follow next_cursor, or narrow the filters.`;
      }
      notices.push(guidance);
    }

    const result: SearchPage = {
      total_results: total,
      observations,
      deferred: [],
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      has_more: hasMore,
    };
    /** The delivery formatter sizes both surfaces; the reserve covers enrichment, its trailer and SDK metadata. */
    let shown = observations.length;
    while (
      shown > 0 &&
      utf8.encode(JSON.stringify({ content: formatSearchPage(result), structuredContent: result }))
        .byteLength >
        RESPONSE_BUDGET_BYTES - RESPONSE_OVERHEAD_BYTES
    ) {
      shown -= 1;
      result.observations = observations.slice(0, shown);
      result.deferred = observations.slice(shown).map(({ id }) => ({ observation_id: id }));
    }
    if (result.deferred.length > 0)
      notices.push(
        'Some fetched records were deferred to keep this response within its byte budget. Retrieve every deferred observation_id with inaturalist_get_observation using the same include values. Deferred records remain available even when has_more is false.',
      );
    ctx.enrich({
      truncated: hasMore || result.deferred.length > 0,
      shown: result.observations.length,
      cap: perPage,
    });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return result;
  },

  format: formatSearchPage,
});

function formatSearchPage(result: SearchPage) {
  const lines: string[] = [
    `**total_results:** ${result.total_results} (upstream estimate) · **returned:** ${result.observations.length} · **has_more:** ${result.has_more} · **next_cursor:** ${result.next_cursor ?? 'none'}`,
  ];
  for (const observation of result.observations) {
    lines.push('');
    lines.push(...renderObservation(observation));
  }
  lines.push(`**deferred:** ${JSON.stringify(result.deferred)}`);
  if (result.deferred.length > 0)
    lines.push(
      'Retrieve deferred observation_id values through inaturalist_get_observation with the same include values.',
    );
  return [{ type: 'text' as const, text: lines.join('\n') }];
}

/**
 * Names the filter most likely to be responsible for an empty page, so the agent
 * relaxes one thing rather than guessing. Composed by condition, most specific
 * first, and never naming a filter the call did not supply.
 */
function zeroHitNotice(input: {
  quality_grade: readonly string[];
  captive: boolean;
  sounds?: boolean | undefined;
  taxon_id?: number | undefined;
  d1?: string | undefined;
  d2?: string | undefined;
  term_id?: readonly number[] | undefined;
  radius?: number | undefined;
  user_id?: number | undefined;
  user_login?: string | undefined;
  project_id?: number | undefined;
}): string {
  const fragments: string[] = [];

  if (input.quality_grade.length === 1 && input.quality_grade[0] === 'research') {
    fragments.push(
      'Only research-grade records were searched. Add "needs_id" to quality_grade to include sightings whose identification is not yet community-confirmed.',
    );
  }
  if (!input.captive) {
    fragments.push(
      'Only wild records were searched. To search captive/cultivated-only records, use captive: true in a separate call.',
    );
  }
  if (input.sounds !== undefined) {
    fragments.push(
      `sounds: ${input.sounds} selected records ${input.sounds ? 'with' : 'without'} sound attachments. Omit sounds to search either cohort.`,
    );
  }
  if (input.d1 !== undefined || input.d2 !== undefined) {
    fragments.push(
      `No sightings fall in ${input.d1 ?? 'any start'}…${input.d2 ?? 'any end'}. Widen the range, or call inaturalist_get_histogram with the same filters to see which months have records.`,
    );
  }
  if (input.term_id?.length) {
    fragments.push(
      input.taxon_id === undefined
        ? 'No sightings carry that annotation. Check the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.'
        : 'No sightings carry that annotation. Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.',
    );
  }
  if (input.radius !== undefined) {
    fragments.push(
      `No sightings within ${input.radius} km of that point. Raise radius, or search a named area with a place_id from inaturalist_find_places.`,
    );
  }
  const observerKey = input.user_id !== undefined ? 'user_id' : 'user_login';
  if (input.user_id !== undefined || input.user_login !== undefined) {
    fragments.push(
      `No sightings by that observer match the other filters. Confirm ${observerKey} with inaturalist_resolve_name type user, or drop it.`,
    );
  }
  if (input.project_id !== undefined) {
    fragments.push(
      'No sightings in that project match the other filters. Confirm project_id with inaturalist_resolve_name type project, or drop it.',
    );
  }

  if (fragments.length > 0) return fragments.join(' ');
  return input.taxon_id === undefined
    ? 'No sightings matched. Relax one filter at a time.'
    : 'No sightings matched. Relax one filter at a time. Confirm taxon_id with inaturalist_resolve_name, or drop it.';
}
