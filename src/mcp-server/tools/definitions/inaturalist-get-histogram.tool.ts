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
  resolveArea,
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

const { quality_grade, captive } = observationFilterInputShape;

export const inaturalistGetHistogram = tool('inaturalist_get_histogram', {
  description:
    'Build a phenology histogram for a taxon in an area — which months, weeks, or years it is recorded in. The default month_of_year interval answers "when does this bloom or appear here" in twelve buckets; the absolute intervals (year, month, week, day, hour) bucket real dates and upstream applies a default start date to them. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Omit taxon_id to chart every taxon in the area. Defaults to research-grade, wild-only records and echoes those defaults back.',
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
        'Bucketing. month_of_year and week_of_year fold every year together into a seasonal curve; the rest bucket absolute dates.',
      ),
    date_field: z
      .enum(['observed', 'created'])
      .default('observed')
      .describe(
        'Which date to bucket by: when the organism was observed, or when the record was uploaded.',
      ),
    ...dateRangeInputShape,
    quality_grade,
    captive,
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
      .describe('Every bucket upstream returned, in order, including the zero ones.'),
    total: z.number().describe('Sum of every bucket count.'),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Whether captive and cultivated records were included.'),
        date_field: z.string().describe('Which date the buckets were built from.'),
      })
      .describe('The server-applied defaults that determine what this answer means.'),
    notice: z.string().optional().describe('Guidance when every bucket came back zero.'),
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
      when: 'An area was given partially or in two forms at once.',
      recovery:
        'Pass lat, lng and radius together, or all four of nelat, nelng, swlat and swlng, or a single place_id from inaturalist_find_places.',
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

    const params: QueryParams & { interval: string } = {
      ...area.value,
      taxon_id: input.taxon_id,
      d1: input.d1,
      d2: input.d2,
      quality_grade: input.quality_grade,
      captive: input.captive,
      interval: input.interval,
      date_field: input.date_field,
    };

    ctx.log.info('Building a phenology histogram', {
      interval: input.interval,
      hasTaxon: input.taxon_id !== undefined,
    });

    const buckets = await getINaturalistService().getHistogram(params, ctx);
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

    ctx.enrich({
      applied_filters: {
        quality_grade: input.quality_grade,
        captive: input.captive,
        date_field: input.date_field,
      },
    });

    if (total === 0) {
      ctx.enrich.notice(
        'Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.',
      );
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
