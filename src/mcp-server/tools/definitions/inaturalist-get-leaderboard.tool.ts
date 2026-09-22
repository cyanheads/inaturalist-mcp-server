/**
 * @fileoverview Ranks the most active observers or identifiers for an area,
 * period, and taxon.
 * @module mcp-server/tools/definitions/inaturalist-get-leaderboard.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaInputShape,
  dateRangeInputShape,
  exceedsWindow,
  LEADERBOARD_WINDOW,
  observationFilterInputShape,
  resolveArea,
  resolveDateRange,
  wideningGuidance,
} from '@/mcp-server/tools/observation-filters.js';
import { inlineText } from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';

const { quality_grade } = observationFilterInputShape;

export const inaturalistGetLeaderboard = tool('inaturalist_get_leaderboard', {
  description:
    'Rank the most active observers or identifiers for an area, period, and taxon — who knows this place or this group. kind selects which: observers are ranked by how many observations they recorded, identifiers by how many identifications they made. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Both endpoints rank only the top 500 entries, so page multiplied by per_page must stay at or below 500 — narrow the area, period, or taxon to bring someone further down into reach. For the most-recorded species rather than the most active people, use inaturalist_get_species_counts.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    kind: z
      .enum(['observers', 'identifiers'])
      .describe(
        'Which leaderboard: "observers" ranks by observations recorded, "identifiers" by identifications made.',
      ),
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
    quality_grade,
    page: z.number().int().min(1).default(1).describe('Page number. Defaults to 1.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(25)
      .describe(
        'Entries per page, maximum 250. An entry costs roughly 140 bytes across structuredContent and the rendered text together, so 250 is a full page near 34 KB — and two such pages cover the whole 500-entry window these endpoints rank.',
      ),
  }),

  output: z.object({
    kind: z.enum(['observers', 'identifiers']).describe('Which leaderboard was ranked.'),
    count_metric: z
      .enum(['observations', 'identifications'])
      .describe('What the count on each entry measures.'),
    total_results: z
      .number()
      .describe(
        'How many people upstream reports as matching. Far larger than the 500 this leaderboard can actually address.',
      ),
    entries: z
      .array(
        z
          .object({
            rank: z.number().describe('Absolute rank across the leaderboard, counted from page 1.'),
            login: z
              .string()
              .nullable()
              .describe('The member’s login. No other profile field is relayed.'),
            count: z
              .number()
              .describe('Observations recorded, or identifications made — see count_metric.'),
            species_count: z
              .number()
              .optional()
              .describe(
                'Distinct species this observer recorded. Present on the observers arm only; the identifiers endpoint publishes none.',
              ),
          })
          .describe('One ranked member.'),
      )
      .describe('The ranked members, most active first.'),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
      })
      .describe('The server-applied default that determines what this answer means.'),
    truncated: z.boolean().describe('True when the page filled per_page and more entries follow.'),
    shown: z.number().describe('How many entries this page carries.'),
    cap: z.number().describe('The per_page that was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nobody matched, or how to reach further down the ranking.'),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) => `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')}`,
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
      reason: 'leaderboard_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page multiplied by per_page would reach past the 500 entries these endpoints rank.',
      recovery:
        'This leaderboard only ranks the top 500 entries; page and per_page must multiply to 500 or less. Narrow the area, date range, or taxon_id to bring a specific user’s rank into the top 500 instead.',
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

    // Past 500 both endpoints answer 200 with an empty page, which an agent
    // reads as "nobody matched" rather than as the end of the window.
    if (exceedsWindow(input.page, input.per_page, LEADERBOARD_WINDOW)) {
      throw ctx.fail(
        'leaderboard_window_exceeded',
        `page ${input.page} × per_page ${input.per_page} reaches past the ${LEADERBOARD_WINDOW} entries these endpoints rank; upstream would answer with an empty page and no error.`,
        { ...ctx.recoveryFor('leaderboard_window_exceeded') },
      );
    }

    const params: QueryParams & { page: number; per_page: number } = {
      ...area.value,
      ...dates.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      page: input.page,
      per_page: input.per_page,
    };

    ctx.log.info('Ranking a leaderboard', { kind: input.kind, perPage: input.per_page });

    const { total, entries } = await getINaturalistService().getLeaderboard(
      input.kind,
      params,
      ctx,
    );

    // The baseline disclosure rides every path — the enrichment block declares
    // these three as required, and `ctx.enrich.truncated` below overwrites them
    // on the one path where the page actually filled.
    ctx.enrich({
      applied_filters: { quality_grade: input.quality_grade },
      truncated: false,
      shown: entries.length,
      cap: input.per_page,
    });

    const countMetric =
      input.kind === 'observers' ? ('observations' as const) : ('identifications' as const);

    if (entries.length === 0) {
      const lead =
        input.kind === 'observers'
          ? 'Nobody has recorded observations matching those filters.'
          : 'Nobody has made identifications matching those filters.';
      const guidance = wideningGuidance(input, Object.keys(area.value).length > 0);
      ctx.enrich.notice(guidance ? `${lead} ${guidance}` : lead);
      return { kind: input.kind, count_metric: countMetric, total_results: total, entries };
    }

    const nextPageReachable = !exceedsWindow(input.page + 1, input.per_page, LEADERBOARD_WINDOW);
    if (entries.length >= input.per_page) {
      ctx.enrich.truncated({
        shown: entries.length,
        cap: input.per_page,
        guidance: nextPageReachable
          ? `Raise page to reach further down the ranking, up to the ${LEADERBOARD_WINDOW}-entry ceiling these endpoints serve.`
          : `This page ends at the ${LEADERBOARD_WINDOW}-entry ceiling these endpoints serve, though ${total} people match. Narrow the area, date range, or taxon_id to rank a smaller field.`,
      });
    }

    return { kind: input.kind, count_metric: countMetric, total_results: total, entries };
  },

  format: (result) => {
    const lines: string[] = [
      `**kind:** ${result.kind} · **count_metric:** ${result.count_metric} · **total_results:** ${result.total_results}`,
    ];
    for (const entry of result.entries) {
      const species =
        entry.species_count === undefined ? '' : ` · ${entry.species_count} species_count`;
      lines.push(
        `${entry.rank}. **${inlineText(entry.login ?? 'login not published')}** — ${entry.count} ${result.count_metric}${species}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
