/**
 * @fileoverview Builds a phenology histogram for a taxon in an area — which
 * months, weeks, or years it is recorded in.
 * @module mcp-server/tools/definitions/inaturalist-get-histogram.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaInputShape,
  dateRangeInputShape,
  observationFilterInputShape,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
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

/**
 * A fine interval (day, hour) over a wide date range is unbounded upstream —
 * `interval=day&d1=1900-01-01` measured 25,531 buckets / 388,530 bytes,
 * against the design's 50,000-byte advertised maximum for a list tool. A
 * bucket costs at most ~58 bytes combined across structuredContent and the
 * rendered markdown row (a 10-char day key, a JSON entry plus trailing comma,
 * and a `| key | count |` row up to a 5-digit count), so 800 buckets lands
 * near 46,800 bytes worst case — under budget with headroom for the fixed
 * header, table heading, and enrichment trailer.
 */
const HISTOGRAM_BUCKET_CAP = 800;

export const inaturalistGetHistogram = tool('inaturalist_get_histogram', {
  description:
    'Build a phenology histogram for a taxon in an area — which months, weeks, or years it is recorded in. The default month_of_year interval answers "when does this bloom or appear here" in twelve buckets; the absolute intervals (year, month, week, day, hour) bucket real dates and upstream applies a default start date to them. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Omit taxon_id to chart every taxon in the area. Narrow to one life stage or reproductive state with an annotation pair (term_id and term_value_id, e.g. Life Stage = Larva, or Flowers and Fruits = Flowers), or to broad groups with iconic_taxa. Defaults to research-grade, wild-only records and echoes those defaults back.',
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
    interval: z
      .enum(INTERVALS)
      .default('month_of_year')
      .describe(
        `Bucketing. month_of_year and week_of_year fold every year together into a seasonal curve; the rest bucket absolute dates. day and hour over a wide date range can generate thousands of buckets — the response is capped at ${HISTOGRAM_BUCKET_CAP}, kept from the start of the range; narrow d1/d2 or use a coarser interval to see the rest.`,
      ),
    date_field: z
      .enum(['observed', 'created'])
      .default('observed')
      .describe(
        'Which date to bucket by: when the organism was observed, or when the record was uploaded.',
      ),
    ...dateRangeInputShape,
    d1: dateRangeInputShape.d1.describe(
      `Earliest observation date, YYYY-MM-DD. Inclusive. Must be on or before d2. With interval set to day or hour, a wide range can exceed the ${HISTOGRAM_BUCKET_CAP}-bucket cap — narrow d1/d2 to reach buckets past it.`,
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
        'Sum of every bucket count upstream returned, including buckets past the cap that are not in the buckets array.',
      ),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Whether captive and cultivated records were included.'),
        date_field: z.string().describe('Which date the buckets were built from.'),
      })
      .describe('The server-applied defaults that determine what this answer means.'),
    truncated: z
      .boolean()
      .describe(`True when upstream returned more than ${HISTOGRAM_BUCKET_CAP} buckets.`),
    shown: z.number().describe('How many buckets this response carries.'),
    cap: z.number().describe('The bucket cap that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when every bucket came back zero, or when the cap was reached.'),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) =>
        `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')} · captive: ${filters.captive} · bucketed by ${filters.date_field} date`,
    },
  },

  errors: [
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
  ],

  async handler(input, ctx) {
    const area = resolveArea(input);
    if (!area.ok) {
      throw ctx.fail('invalid_geography', area.message, {
        ...ctx.recoveryFor('invalid_geography'),
      });
    }

    const dates = resolveDateRange(input);
    if (!dates.ok) {
      throw ctx.fail('inverted_date_range', dates.message, {
        ...ctx.recoveryFor('inverted_date_range'),
      });
    }

    const annotation = resolveAnnotation(input);
    if (!annotation.ok) {
      throw ctx.fail('unpaired_annotation_value', annotation.message, {
        ...ctx.recoveryFor('unpaired_annotation_value'),
      });
    }

    const params: QueryParams & { interval: string } = {
      ...area.value,
      ...annotation.value,
      ...dates.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      interval: input.interval,
      date_field: input.date_field,
    };

    ctx.log.info('Building a phenology histogram', {
      interval: input.interval,
      hasTaxon: input.taxon_id !== undefined,
    });

    const allBuckets = await getINaturalistService().getHistogram(params, ctx);
    const total = allBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const buckets = allBuckets.slice(0, HISTOGRAM_BUCKET_CAP);
    const truncated = allBuckets.length > HISTOGRAM_BUCKET_CAP;

    // Declared required, so written on every path — the truncated() call below
    // overwrites these only where the cap actually bit.
    ctx.enrich({
      applied_filters: {
        quality_grade: input.quality_grade,
        captive: input.captive,
        date_field: input.date_field,
      },
      truncated: false,
      shown: buckets.length,
      cap: HISTOGRAM_BUCKET_CAP,
    });

    // `total` covers every bucket upstream returned, not just the shown window,
    // so a genuinely empty answer is recognised even when the cap bites — and
    // its notice replaces the truncation guidance, since narrowing the range
    // would not help. The notice is written once, on whichever call applies.
    const notice =
      total === 0 ? zeroHitNotice(input, Object.keys(area.value).length > 0) : undefined;
    if (truncated) {
      ctx.enrich.truncated({
        shown: buckets.length,
        cap: HISTOGRAM_BUCKET_CAP,
        guidance:
          notice ??
          `Upstream returned ${allBuckets.length} buckets; only the first ${HISTOGRAM_BUCKET_CAP} are shown. Narrow d1/d2, or choose a coarser interval, to bring the rest into range.`,
      });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    return { interval: input.interval, buckets, total };
  },

  format: (result) => {
    const lines: string[] = [
      `**interval:** ${result.interval} · **total:** ${result.total} observations across ${result.buckets.length} buckets`,
      '',
      '| key | count |',
      '|:--|--:|',
      ...result.buckets.map((bucket) => `| ${bucket.key} | ${bucket.count} |`),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Names what most likely emptied every bucket: the date range when one was
 * set, otherwise the annotation or iconic-group filter when one was given, the
 * taxon only when one was given, and the area only when one was named. A
 * `term_value_id` from another attribute zeroes every bucket, so an annotation
 * filter always carries the pairing check.
 */
function zeroHitNotice(
  input: {
    taxon_id?: number | undefined;
    d1?: string | undefined;
    d2?: string | undefined;
    term_id?: readonly number[] | undefined;
    iconic_taxa?: readonly string[] | undefined;
  },
  hasArea: boolean,
): string {
  const where = hasArea ? ' in that area' : '';
  const hasTaxon = input.taxon_id !== undefined;
  const of = hasTaxon ? ' of this taxon' : '';
  const hasAnnotation = (input.term_id?.length ?? 0) > 0;
  const iconic = input.iconic_taxa?.length ? input.iconic_taxa.join(', ') : undefined;
  const narrowing = [
    ...(hasAnnotation ? ['the annotation filter'] : []),
    ...(iconic ? [`iconic_taxa ${iconic}`] : []),
  ];

  let finding = `Every bucket is zero — ${hasTaxon ? 'this taxon has no records' : 'nothing is recorded'}${where}.`;
  if (input.d1 !== undefined || input.d2 !== undefined) {
    finding = `Every bucket is zero — no records${of}${where} fall in ${input.d1 ?? 'any start'}…${input.d2 ?? 'any end'}. Widen or drop d1/d2.`;
  } else if (narrowing.length > 0) {
    finding = `Every bucket is zero — no records${of}${where} match ${narrowing.join(' and ')}.`;
  }
  const filterChecks = [
    ...(hasAnnotation
      ? [
          `Check that each term_value_id belongs to its term_id with inaturalist_list_reference topic controlled_terms${hasTaxon ? ' and taxon_id' : ''}, or drop the annotation filter.`,
        ]
      : []),
    ...(iconic ? ['Drop iconic_taxa or choose another group.'] : []),
  ];
  const remedy = hasTaxon
    ? `Confirm the taxon with inaturalist_resolve_name${hasArea ? ', or widen the area' : ''}.`
    : `${hasArea ? 'Widen the area, or relax' : 'Relax'} quality_grade or captive.`;
  return [finding, ...filterChecks, remedy].join(' ');
}
