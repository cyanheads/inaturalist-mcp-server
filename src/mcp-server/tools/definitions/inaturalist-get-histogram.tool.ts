/**
 * @fileoverview Builds a phenology histogram for a taxon in an area — which
 * months, weeks, or years it is recorded in.
 * @module mcp-server/tools/definitions/inaturalist-get-histogram.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { radiusClampNotice } from '@/mcp-server/tools/limit-policy.js';
import {
  annotationFilterNotice,
  areaInputShape,
  blankAsUnset,
  captiveCohortNotice,
  creationDateRangeInputShape,
  dateRangeInputShape,
  emptyFilterNotice,
  observationFilterInputShape,
  observerProjectInputShape,
  optionsSentence,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
  resolveObserver,
} from '@/mcp-server/tools/observation-filters.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';

const INTERVALS = [
  'year',
  'month',
  'week',
  'day',
  'hour',
  'month_of_year',
  'week_of_year',
] as const;

const { quality_grade, captive, term_id, term_value_id, iconic_taxa } = observationFilterInputShape;

/** Bounds returned rows, not serialized bytes; wide explicit ranges can still exceed it. */
const HISTOGRAM_BUCKET_CAP = 25_000;

export const inaturalistGetHistogram = tool('inaturalist_get_histogram', {
  description:
    'Build a phenology histogram for a taxon in an area — which months, weeks, or years it is recorded in. The default month_of_year interval answers "when does this bloom or appear here" in twelve buckets; absolute intervals (year, month, week, day, hour) bucket real dates and disclose their window start. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Omit taxon_id to chart every taxon in the area. Narrow to one life stage or reproductive state with an annotation pair (term_id and term_value_id, e.g. Life Stage = Larva, or Flowers and Fruits = Flowers), or to broad groups with iconic_taxa. Defaults to research-grade, wild-only records and echoes those defaults back.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    taxon_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Restrict to this taxon and its descendants. Omit to chart every taxon in the area. Resolve a name to an id with inaturalist_resolve_name.',
      ),
    ...areaInputShape,
    ...observerProjectInputShape,
    interval: blankAsUnset(z.enum(INTERVALS).default('month_of_year')).describe(
      `Bucketing. month_of_year and week_of_year fold every year together into a seasonal curve. Absolute intervals default the selected date family's missing lower bound from its upper bound, otherwise today UTC: year/month subtract 100 calendar years, week 10 years, day one year, hour seven days. The start is disclosed; no upper bound is added. At most ${HISTOGRAM_BUCKET_CAP} buckets are returned, oldest first, with continuation guidance when cut.`,
    ),
    date_field: blankAsUnset(z.enum(['observed', 'created']).default('observed')).describe(
      'Which date to bucket by: when the organism was observed, or when the record was uploaded.',
    ),
    ...dateRangeInputShape,
    ...creationDateRangeInputShape,
    d1: dateRangeInputShape.d1.describe(
      `Earliest observation date, YYYY-MM-DD. Inclusive. Must be on or before d2. For absolute observed-date intervals, a missing d1 is derived from d2 or today UTC and disclosed as window_start. Wide ranges can exceed the ${HISTOGRAM_BUCKET_CAP}-bucket cap; continuation names d1, or created_d1 for upload-date bucketing.`,
    ),
    quality_grade,
    captive,
    term_id,
    term_value_id,
    iconic_taxa,
  }),

  output: z.object({
    interval: z.enum(INTERVALS).describe('The bucketing that was applied.'),
    buckets: z
      .array(
        z
          .object({
            key: z
              .string()
              .describe(
                'Bucket label, in upstream order — "1"…"12" for month_of_year, a date for the absolute intervals.',
              ),
            count: z.number().describe('Matching observations in this bucket.'),
          })
          .describe('One histogram bucket.'),
      )
      .describe(
        `Every bucket upstream returned, in order, including the zero ones — up to ${HISTOGRAM_BUCKET_CAP}, the first in upstream key order. See the truncated/shown/cap enrichment when more exist.`,
      ),
    total: z
      .number()
      .describe(
        'Observations in the upstream histogram window: sum of every returned bucket count, including buckets past the cap; not an all-time taxon count.',
      ),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Captive-only when true, wild-only when false.'),
        date_field: z.string().describe('Which date the buckets were built from.'),
        window_start: z
          .string()
          .optional()
          .describe(
            'Inclusive lower bound on the bucketed date for absolute intervals; absent for seasonal intervals.',
          ),
      })
      .describe('Effective cohort defaults, bucketed date family, and absolute window start.'),
    truncated: z
      .boolean()
      .describe(`True when upstream returned more than ${HISTOGRAM_BUCKET_CAP} buckets.`),
    shown: z.number().describe('How many buckets this response carries.'),
    cap: z.number().describe('The bucket cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Generated window start, filter guidance, and continuation when buckets are cut.'),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) =>
        `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')} · captive: ${filters.captive} · bucketed by ${filters.date_field} date${filters.window_start !== undefined ? ` · window_start ${filters.window_start}` : ''}`,
    },
  },

  errors: [
    {
      reason: 'conflicting_observer',
      code: JsonRpcErrorCode.ValidationError,
      when: 'user_id and user_login were both supplied.',
      recovery:
        'Pass one observer, as user_id or user_login — each names the observer on its own, and a mismatched pair matches nothing.',
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
      when: 'd1 is after d2, or created_d1 is after created_d2.',
      recovery:
        'Pass d1 on or before d2 and created_d1 on or before created_d2 — both ranges are inclusive, so equal dates select a single calendar day.',
    },
    {
      reason: 'unpaired_annotation_value',
      code: JsonRpcErrorCode.ValidationError,
      when: 'term_value_id was supplied without term_id.',
      recovery:
        'Pass term_id alongside term_value_id; list the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.',
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
      reason: 'rate_budget_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'This server has spent its daily iNaturalist request budget for the current UTC day.',
      recovery:
        'The upstream daily request allowance is spent; retry after the next UTC midnight, or raise INATURALIST_DAILY_REQUEST_BUDGET only if this deployment does not share an egress IP.',
      retryable: false,
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

    const observer = resolveObserver(input);
    if (!observer.ok) {
      throw ctx.fail('conflicting_observer', observer.message);
    }

    const annotation = resolveAnnotation(input);
    if (!annotation.ok) {
      throw ctx.fail('unpaired_annotation_value', annotation.message);
    }

    const params: QueryParams & { interval: string } = {
      ...area.value,
      ...annotation.value,
      ...dates.value,
      ...observer.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      interval: input.interval,
      date_field: input.date_field,
    };

    const absolute = input.interval !== 'month_of_year' && input.interval !== 'week_of_year';
    const lowerField = input.date_field === 'created' ? 'created_d1' : 'd1';
    const upperField = input.date_field === 'created' ? 'created_d2' : 'd2';
    const windowStart = absolute
      ? (input[lowerField] ??
        subtractCalendarDate(
          input[upperField] ?? new Date().toISOString().slice(0, 10),
          input.interval === 'year' || input.interval === 'month'
            ? 100
            : input.interval === 'week'
              ? 10
              : input.interval === 'day'
                ? 1
                : 0,
          input.interval === 'hour' ? 7 : 0,
        ))
      : undefined;
    const generatedStart = windowStart !== undefined && input[lowerField] === undefined;

    ctx.log.info('Building a phenology histogram', {
      interval: input.interval,
      hasTaxon: input.taxon_id !== undefined,
    });

    const allBuckets = await getINaturalistService().getHistogram(
      windowStart !== undefined ? { ...params, [lowerField]: windowStart } : params,
      ctx,
    );
    const total = allBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const buckets = allBuckets.slice(0, HISTOGRAM_BUCKET_CAP);
    const firstOmitted = allBuckets[HISTOGRAM_BUCKET_CAP];

    // Declared required, so written on every path — the truncated() call below
    // overwrites these only where the cap actually bit.
    ctx.enrich({
      applied_filters: {
        quality_grade: input.quality_grade,
        captive: input.captive,
        date_field: input.date_field,
        ...(windowStart !== undefined ? { window_start: windowStart } : {}),
      },
      truncated: false,
      shown: buckets.length,
      cap: HISTOGRAM_BUCKET_CAP,
    });

    // `total` covers every bucket upstream returned, not just the shown window,
    // so a genuinely empty answer is recognised even when the cap bites — and
    // its notice replaces the truncation guidance, since narrowing the range
    // would not help. The notice is written once, on whichever call applies.
    const radiusNotice = radiusClampNotice(area.radiusClamp, ctx, 'inaturalist_get_histogram');
    const notice = [
      radiusNotice,
      emptyFilterNotice(input),
      annotationFilterNotice(input),
      generatedStart
        ? `Using generated ${lowerField}=${windowStart} as the histogram window start. total sums this window's upstream buckets, including any not shown.`
        : undefined,
      captiveCohortNotice(input),
      total === 0
        ? zeroHitNotice(input, Object.keys(area.value).length > 0, windowStart)
        : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (firstOmitted !== undefined) {
      ctx.enrich.truncated({
        shown: buckets.length,
        cap: HISTOGRAM_BUCKET_CAP,
        guidance: [
          notice,
          total !== 0
            ? `Upstream returned ${allBuckets.length} buckets; only the first ${HISTOGRAM_BUCKET_CAP} are shown. ${continuationNotice(firstOmitted.key, input.interval, input.date_field, lowerField, windowStart)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    return { interval: input.interval, buckets, total };
  },

  format: (result) => {
    const lines: string[] = [
      `**interval:** ${result.interval} · **total:** ${result.total} observations in the upstream window · ${result.buckets.length} buckets shown`,
      '',
      '| key | count |',
      '|:--|--:|',
      ...result.buckets.map((bucket) => `| ${bucket.key} | ${bucket.count} |`),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Subtract UTC calendar units, clamping leap days and the supported four-digit date floor. */
function subtractCalendarDate(value: string, years: number, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  const year = date.getUTCFullYear() - years;
  if (year < 0) return '0000-01-01';
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCFullYear(year, month + 1, 0);
  date.setUTCDate(Math.min(day, date.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return date.getUTCFullYear() < 0 ? '0000-01-01' : date.toISOString().slice(0, 10);
}

/** Date-only filters can overlap UTC or coarse buckets; never replace a previously returned count. */
function continuationNotice(
  key: string,
  interval: (typeof INTERVALS)[number],
  dateField: 'observed' | 'created',
  lowerField: 'd1' | 'created_d1',
  windowStart: string | undefined,
): string {
  const date =
    interval === 'year'
      ? `${key.slice(0, 4)}-01-01`
      : interval === 'month'
        ? `${key.slice(0, 7)}-01`
        : key.slice(0, 10);
  const conservative =
    dateField === 'created' || interval === 'hour' ? subtractCalendarDate(date, 0, 1) : date;
  const start =
    windowStart !== undefined && conservative < windowStart ? windowStart : conservative;
  return `To reach the first omitted bucket (${key}), repeat this call with ${lowerField}=${start}; retain all other filters and upper bounds. Date-only bounds can overlap earlier or partial boundary buckets: deduplicate keys, preserving counts from earlier responses rather than replacing or adding repeated counts. Boundary counts may be partial; this does not reconstruct complete bucket totals. Alternatively choose a coarser interval.`;
}

/**
 * Names what most likely emptied every bucket: the date range when one was
 * set, otherwise the annotation or iconic-group filter when one was given, the
 * taxon only when one was given, and the area only when one was named. A
 * `term_value_id` from another attribute zeroes every bucket, so an annotation
 * filter always carries the pairing check. The finding says no records match
 * the filters, never that none exist: the default cohort leaves out needs_id,
 * casual and captive records. Under `captive: true` no quality remedy is
 * offered — captive records are graded casual, and the cohort notice says so.
 */
function zeroHitNotice(
  input: {
    quality_grade: readonly string[];
    captive: boolean;
    taxon_id?: number | undefined;
    d1?: string | undefined;
    d2?: string | undefined;
    created_d1?: string | undefined;
    created_d2?: string | undefined;
    term_id?: readonly number[] | undefined;
    iconic_taxa?: readonly string[] | undefined;
    user_id?: number | undefined;
    user_login?: string | undefined;
    project_id?: number | undefined;
  },
  hasArea: boolean,
  windowStart?: string,
): string {
  const where = hasArea ? ' in that area' : '';
  const hasTaxon = input.taxon_id !== undefined;
  const of = hasTaxon ? ' of this taxon' : '';
  const hasAnnotation = (input.term_id?.length ?? 0) > 0;
  const iconic = input.iconic_taxa?.length ? input.iconic_taxa.join(', ') : undefined;
  const narrowing = [
    ...(input.user_id !== undefined ? ['the user_id observer filter'] : []),
    ...(input.user_login !== undefined ? ['the user_login observer filter'] : []),
    ...(input.project_id !== undefined ? ['the project_id filter'] : []),
    ...(hasAnnotation ? ['the annotation filter'] : []),
    ...(iconic ? [`iconic_taxa ${iconic}`] : []),
  ];

  let finding =
    windowStart !== undefined
      ? `Every bucket is zero — no records${of}${where} match the histogram window and other filters.`
      : `Every bucket is zero — no records${of}${where} match these filters.`;
  const bounds = [
    ...(input.d1 !== undefined || input.d2 !== undefined
      ? [`observation-date d1/d2 ${input.d1 ?? 'any start'}…${input.d2 ?? 'any end'}`]
      : []),
    ...(input.created_d1 !== undefined || input.created_d2 !== undefined
      ? [
          `upload-date created_d1/created_d2 ${input.created_d1 ?? 'any start'}…${input.created_d2 ?? 'any end'}`,
        ]
      : []),
  ];
  if (bounds.length > 0) {
    finding = `Every bucket is zero — no records${of}${where} match the combined filters. The supplied ${bounds.join(' and ')} may narrow the intersection; widen or drop those bounds.`;
  } else if (narrowing.length > 0) {
    finding = `Every bucket is zero — no records${of}${where} match ${narrowing.join(' and ')}.`;
  }
  const filterChecks = [
    ...(input.user_id !== undefined || input.user_login !== undefined
      ? [
          'Drop the observer filter or confirm the observer with inaturalist_resolve_name type user.',
        ]
      : []),
    ...(input.project_id !== undefined
      ? ['Drop project_id or confirm the project with inaturalist_resolve_name type project.']
      : []),
    ...(hasAnnotation
      ? [
          `Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms${hasTaxon ? ' and taxon_id' : ''}, or drop the annotation filter.`,
        ]
      : []),
    ...(iconic ? ['Drop iconic_taxa or choose another group.'] : []),
  ];
  const researchOnly = input.quality_grade.length === 1 && input.quality_grade[0] === 'research';
  let qualityRemedy: string | undefined;
  if (!input.captive) {
    qualityRemedy = hasTaxon
      ? researchOnly
        ? 'add "needs_id" to quality_grade'
        : undefined
      : 'relax quality_grade';
  }
  const remedy = optionsSentence([
    ...(hasTaxon ? ['confirm the taxon with inaturalist_resolve_name'] : []),
    ...(hasArea ? ['widen the area'] : []),
    ...(qualityRemedy ? [qualityRemedy] : []),
  ]);
  return [finding, ...filterChecks, remedy].filter(Boolean).join(' ');
}
