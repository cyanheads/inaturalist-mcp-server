/**
 * @fileoverview Searches georeferenced iNaturalist sightings by area, date,
 * taxon, quality grade, annotation, and conservation status.
 * @module mcp-server/tools/definitions/inaturalist-search-observations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaInputShape,
  blankAsUnset,
  dateRangeInputShape,
  exceedsWindow,
  observationFilterInputShape,
  RESULT_WINDOW,
  resolveAnnotation,
  resolveArea,
} from '@/mcp-server/tools/observation-filters.js';
import { ObservationSchema, renderObservation } from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';
import type { ObservationExpansion } from '@/services/inaturalist/types.js';
import { CONSERVATION_STATUS_CODES, RANKS } from '@/services/inaturalist/vocabularies.js';

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

export const inaturalistSearchObservations = tool('inaturalist_search_observations', {
  description:
    'Search georeferenced wildlife sightings by area, date, taxon, quality grade, annotation, and conservation status. Returns a projected record per sighting with coordinates, licence, first photo, and identification counts. An area is given in exactly one form — place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box — and defaults to research-grade, wild-only records, which are echoed back on every call. Identifications and comments are deliberately not expandable here (one thread is 28 KB); fetch them for specific records with inaturalist_get_observation. Results past 10,000 need the cursor from the previous page rather than a higher page number.',
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
    hrank: z
      .enum(RANKS)
      .optional()
      .describe('Highest taxonomic rank of the identification to accept.'),
    lrank: z
      .enum(RANKS)
      .optional()
      .describe('Lowest taxonomic rank of the identification to accept.'),
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
      .describe('Restrict to records whose own license_code is not null.'),
    photo_licensed: z
      .boolean()
      .optional()
      .describe('Restrict to records with at least one licensed photo.'),
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
        'Sort field. Forced to id when cursor is supplied, since a cursor only continues an id ordering.',
      ),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Page number within the first 10,000 results. Defaults to 1. Mutually exclusive with cursor.',
      ),
    cursor: blankAsUnset(z.string().min(1).optional()).describe(
      'next_cursor from a previous page, to continue past the 10,000-result window. Mutually exclusive with page, and forces an id ordering.',
    ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe(
        'Records per page, maximum 25. A projected record costs roughly 1.9 KB across structuredContent and the rendered text together, so 25 is a full page near 49 KB and the default of 10 near 20 KB. Walk further with page or cursor rather than a larger page.',
      ),
    include: z
      .array(z.enum(['photos', 'annotations', 'sounds']))
      .optional()
      .describe(
        'Embedded arrays to expand per record. Check photo_count and sound_count first — expanding costs context.',
      ),
  }),

  output: z.object({
    total_results: z
      .number()
      .describe(
        'How many records upstream reports as matching. An estimate over a live index — it drifts between calls seconds apart.',
      ),
    observations: z.array(ObservationSchema).describe('The matching sightings, projected.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass back as cursor to continue past this page. Absent when has_more is false.'),
    has_more: z.boolean().describe('True when this page filled per_page, so more records follow.'),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Whether captive and cultivated records were included.'),
        order_by: z.string().describe('Sort field actually sent upstream.'),
        order: z.string().describe('Sort direction actually sent upstream.'),
        ordering_forced_by_cursor: z
          .boolean()
          .describe('True when a cursor overrode the requested ordering.'),
      })
      .describe('The server-applied defaults and overrides that determine what this answer means.'),
    truncated: z.boolean().describe('True when the page filled per_page and more records follow.'),
    shown: z.number().describe('How many records this page carries.'),
    cap: z.number().describe('The per_page that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, or how to continue past a full page.'),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) =>
        `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')} · captive: ${filters.captive} · ordered by ${filters.order_by} ${filters.order}${filters.ordering_forced_by_cursor ? ' (forced by cursor)' : ''}`,
    },
  },

  errors: [
    {
      reason: 'invalid_geography',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An area was given partially or in two forms at once.',
      recovery:
        'Pass lat, lng and radius together, or all four of nelat, nelng, swlat and swlng, or a single place_id from inaturalist_find_places.',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page multiplied by per_page would reach past the upstream 10,000-result window.',
      recovery:
        'Continue past 10,000 results by passing cursor set to next_cursor from the previous page instead of raising page.',
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
      reason: 'unknown_taxon_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the taxon_id does not exist.',
      recovery:
        'Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const area = resolveArea(input);
    if (!area.ok) {
      throw ctx.fail('invalid_geography', area.message, {
        ...ctx.recoveryFor('invalid_geography'),
      });
    }

    const annotation = resolveAnnotation(input);
    if (!annotation.ok) {
      throw ctx.fail('unpaired_annotation_value', annotation.message, {
        ...ctx.recoveryFor('unpaired_annotation_value'),
      });
    }

    if (input.search_on !== undefined && input.q === undefined) {
      throw ctx.fail(
        'search_on_without_query',
        'search_on narrows what q matches, so it does nothing without q.',
        { ...ctx.recoveryFor('search_on_without_query') },
      );
    }

    if (input.cursor !== undefined && input.page !== undefined) {
      throw ctx.fail(
        'conflicting_pagination',
        'page and cursor are different mechanisms and cannot be combined.',
        { ...ctx.recoveryFor('conflicting_pagination') },
      );
    }

    const page = input.page ?? 1;
    const usingCursor = input.cursor !== undefined;
    if (!usingCursor && exceedsWindow(page, input.per_page, RESULT_WINDOW)) {
      throw ctx.fail(
        'result_window_exceeded',
        `page ${page} × per_page ${input.per_page} reaches past the ${RESULT_WINDOW}-result window upstream will serve.`,
        { ...ctx.recoveryFor('result_window_exceeded') },
      );
    }

    const orderBy = usingCursor ? 'id' : input.order_by;
    const order = usingCursor ? 'desc' : input.order;
    const params: QueryParams = {
      ...area.value,
      ...annotation.value,
      taxon_id: input.taxon_id,
      d1: input.d1,
      d2: input.d2,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      hrank: input.hrank,
      lrank: input.lrank,
      csi: input.csi,
      threatened: input.threatened,
      native: input.native,
      introduced: input.introduced,
      endemic: input.endemic,
      licensed: input.licensed,
      photo_licensed: input.photo_licensed,
      q: input.q,
      search_on: input.search_on,
      order_by: orderBy,
      order,
      per_page: input.per_page,
      ...(usingCursor ? { id_below: input.cursor } : { page }),
    };

    ctx.log.info('Searching observations', {
      perPage: input.per_page,
      usingCursor,
      hasArea: Object.keys(area.value).length > 0,
    });

    const include = new Set<ObservationExpansion>(input.include ?? []);
    const { total, observations } = await getINaturalistService().searchObservations(
      params,
      include,
      ctx,
    );

    // The baseline disclosure rides every path — the enrichment block declares
    // these three as required, and `ctx.enrich.truncated` below overwrites them
    // on the one path where the page actually filled.
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
      cap: input.per_page,
    });

    if (observations.length === 0) {
      ctx.enrich.notice(zeroHitNotice(input));
      return { total_results: total, observations, has_more: false };
    }

    // A full page is necessary but not sufficient: on the page path the offset
    // is known, so an exactly-full final page is reported as the end rather than
    // sending the agent after a page that does not exist. Under a cursor the
    // offset is unknown and a full page is the only signal there is.
    const hasMore =
      observations.length >= input.per_page && (usingCursor || page * input.per_page < total);
    const last = observations.at(-1);
    const nextCursor = hasMore && last ? String(last.id) : undefined;
    if (hasMore) {
      ctx.enrich.truncated({
        shown: observations.length,
        cap: input.per_page,
        guidance: nextCursor
          ? `More records match. Pass cursor "${nextCursor}" to continue; beyond 10,000 results the cursor is the only mechanism that works.`
          : 'More records match. Raise page, or switch to the cursor past 10,000 results.',
      });
    }

    return {
      total_results: total,
      observations,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      has_more: hasMore,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**total_results:** ${result.total_results} (upstream estimate) · **returned:** ${result.observations.length} · **has_more:** ${result.has_more} · **next_cursor:** ${result.next_cursor ?? 'none'}`,
    ];
    for (const observation of result.observations) {
      lines.push('');
      lines.push(...renderObservation(observation));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Names the filter most likely to be responsible for an empty page, so the agent
 * relaxes one thing rather than guessing. Composed by condition, most specific
 * first.
 */
function zeroHitNotice(input: {
  quality_grade: readonly string[];
  captive: boolean;
  d1?: string | undefined;
  d2?: string | undefined;
  term_id?: readonly number[] | undefined;
  radius?: number | undefined;
}): string {
  const fragments: string[] = [];

  if (input.quality_grade.length === 1 && input.quality_grade[0] === 'research') {
    fragments.push(
      'Only research-grade records were searched. Add "needs_id" to quality_grade to include sightings whose identification is not yet community-confirmed.',
    );
  }
  if (!input.captive) {
    fragments.push(
      'Captive and cultivated records were excluded. Set captive to true to include zoo animals and garden plantings.',
    );
  }
  if (input.d1 !== undefined || input.d2 !== undefined) {
    fragments.push(
      `No sightings fall in ${input.d1 ?? 'any start'}…${input.d2 ?? 'any end'}. Widen the range, or call inaturalist_get_histogram to see which months this taxon is recorded in here.`,
    );
  }
  if (input.term_id?.length) {
    fragments.push(
      'No sightings carry that annotation. Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.',
    );
  }
  if (input.radius !== undefined) {
    fragments.push(
      `No sightings within ${input.radius} km of that point. Raise radius, or search a named area with a place_id from inaturalist_find_places.`,
    );
  }

  return fragments.length > 0
    ? fragments.join(' ')
    : 'No sightings matched. Relax one filter at a time — taxon_id and the date range are the usual culprits.';
}
