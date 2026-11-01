/**
 * @fileoverview Ranks the taxa recorded in an area and period,
 * most-observed first.
 * @module mcp-server/tools/definitions/inaturalist-get-species-counts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyLimit,
  LIMIT_CAPS,
  limitSchema,
  radiusClampNotice,
} from '@/mcp-server/tools/limit-policy.js';
import {
  annotationFilterNotice,
  areaInputShape,
  blankAsUnset,
  dateRangeInputShape,
  emptyFilterNotice,
  emptyPageNotice,
  monthInputShape,
  observationFilterInputShape,
  observerProjectInputShape,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
  resolveObserver,
  resolveRankRange,
  taxonStatusInputShape,
  wideningGuidance,
} from '@/mcp-server/tools/observation-filters.js';
import { inlineText, PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';
import { RANKS } from '@/services/inaturalist/vocabularies.js';

const SpeciesSchema = z
  .object({
    position: z
      .number()
      .describe(
        'Absolute place in this ranking, counted from page 1 — 7 is the seventh most-observed taxon. Not the taxonomic rank, which is rank.',
      ),
    taxon_id: z
      .number()
      .describe(
        'Taxon id — pass it as taxon_id to any taxon-scoped tool or to inaturalist_get_taxon.',
      ),
    name: z.string().nullable().describe('Scientific name.'),
    common_name: z.string().nullable().describe('Preferred common name, when one is recorded.'),
    rank: z.string().nullable().describe('Taxonomic rank, e.g. "species".'),
    iconic_taxon_name: z
      .string()
      .nullable()
      .describe('Broad organism group, e.g. "Aves". Usable as an iconic_taxa filter value.'),
    observation_count: z
      .number()
      .describe('How many matching observations record this taxon. The ranking key.'),
    photo: PhotoSchema.optional().describe('Representative photo, when the taxon carries one.'),
  })
  .describe('One leaf taxon and how often it was recorded in the requested area and period.');

export const inaturalistGetSpeciesCounts = tool('inaturalist_get_species_counts', {
  description:
    'Rank leaf taxa recorded in an area and period, most-observed first. Includes hybrids and coarser identifications; subspecies roll up to their species. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Narrow to a clade by passing taxon_id, e.g. the birds of a park, or to one observer or one project by user_id, user_login, or project_id. Defaults to research-grade, wild-only records and echoes those defaults back. For the most active people rather than the most recorded taxa, use inaturalist_get_leaderboard.',
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
    ...taxonStatusInputShape,
    ...monthInputShape,
    rank: blankAsUnset(z.enum(RANKS).optional()).describe(
      'Exact identification rank. Unlike hrank/lrank, species does not also select hybrid.',
    ),
    page: z.number().int().min(1).default(1).describe('Page number. Defaults to 1.'),
    per_page: limitSchema(
      LIMIT_CAPS.speciesCounts,
      25,
      'Taxa per page. Raise page to continue the ranking.',
    ),
  }),

  output: z.object({
    total_results: z
      .number()
      .describe(
        'How many taxa match. An estimate over a live index — it drifts between calls seconds apart.',
      ),
    species: z
      .array(SpeciesSchema)
      .describe(
        'The taxa, ranked by observation_count, most-observed first, each at its absolute position.',
      ),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Captive-only when true, wild-only when false.'),
      })
      .describe('The server-applied defaults that determine what this answer means.'),
    truncated: z.boolean().describe('True when the page filled per_page and more taxa follow.'),
    shown: z.number().describe('How many taxa this page carries.'),
    cap: z.number().describe('The per_page that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Observation count of the last taxon shown. The ranking is descending, so no taxon left off this page exceeds it.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, when the page is past the last one holding taxa, or how to reach the taxa beyond this page.',
      ),
  },

  enrichmentTrailer: {
    applied_filters: {
      render: (filters) =>
        `**Applied filters:** quality_grade ${filters.quality_grade.join(', ')} · captive: ${filters.captive}`,
    },
  },

  errors: [
    {
      reason: 'inverted_rank_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'hrank is a finer rank level than lrank.',
      recovery:
        'Set hrank to the coarser rank and lrank to the finer one; equal bounds select a rank level, while rank selects one exact rank. List ranks with inaturalist_list_reference topic ranks.',
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

  async handler(requestedInput, ctx) {
    requestedInput = {
      ...requestedInput,
      quality_grade: [...new Set(requestedInput.quality_grade)],
    };
    const { applied, notice: clampNotice } = applyLimit(
      requestedInput.per_page,
      LIMIT_CAPS.speciesCounts,
      ctx,
      'inaturalist_get_species_counts',
      'per_page',
    );
    const input = { ...requestedInput, per_page: applied };
    const area = resolveArea(input);
    if (!area.ok) {
      throw ctx.fail('invalid_geography', area.message);
    }

    const dates = resolveDateRange(input);
    if (!dates.ok) {
      throw ctx.fail('inverted_date_range', dates.message);
    }

    const annotation = resolveAnnotation(input);
    if (!annotation.ok) {
      throw ctx.fail('unpaired_annotation_value', annotation.message);
    }

    const ranks = resolveRankRange(input);
    if (!ranks.ok) throw ctx.fail('inverted_rank_range', ranks.message);

    const observer = resolveObserver(input);
    if (!observer.ok) {
      throw ctx.fail('conflicting_observer', observer.message);
    }

    const params: QueryParams & { page: number; per_page: number } = {
      ...area.value,
      ...annotation.value,
      ...dates.value,
      ...observer.value,
      ...ranks.value,
      rank: input.rank,
      introduced: input.introduced,
      native: input.native,
      threatened: input.threatened,
      endemic: input.endemic,
      csi: input.csi,
      month: input.month,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      page: input.page,
      per_page: input.per_page,
    };

    const hasArea = Object.keys(area.value).length > 0;
    ctx.log.info('Ranking taxa for an area', { perPage: input.per_page, hasArea });

    const { total, species } = await getINaturalistService().getSpeciesCounts(params, ctx);
    const radiusNotice = radiusClampNotice(area.radiusClamp, ctx, 'inaturalist_get_species_counts');
    const ignoredFilters = [
      clampNotice,
      radiusNotice,
      emptyFilterNotice(input),
      annotationFilterNotice(input),
    ]
      .filter(Boolean)
      .join(' ');

    // The baseline disclosure rides every path — the enrichment block declares
    // these three as required, and `ctx.enrich.truncated` below overwrites them
    // on the one path where the page actually filled.
    ctx.enrich({
      applied_filters: { quality_grade: input.quality_grade, captive: input.captive },
      truncated: false,
      shown: species.length,
      cap: input.per_page,
    });

    if (species.length === 0) {
      if (total > 0) {
        ctx.enrich.notice(
          [
            ignoredFilters,
            emptyPageNotice({ page: input.page, perPage: input.per_page, total, noun: 'taxa' }),
          ]
            .filter(Boolean)
            .join(' '),
        );
      } else {
        const lead = 'No taxa recorded for those filters.';
        const guidance = wideningGuidance(input, hasArea);
        ctx.enrich.notice([ignoredFilters, lead, guidance].filter(Boolean).join(' '));
      }
      return { total_results: total, species };
    }

    if (species.length >= input.per_page && input.page * input.per_page < total) {
      // The ranking is descending, so the last count shown bounds every taxon
      // this page left off.
      const ceiling = species.at(-1)?.observation_count;
      ctx.enrich.truncated({
        shown: species.length,
        cap: input.per_page,
        ...(ceiling === undefined ? {} : { ceiling }),
        guidance: [
          ignoredFilters,
          `${total} taxa match. Raise page to walk further down the ranking, or raise per_page (max ${LIMIT_CAPS.speciesCounts}).`,
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else if (ignoredFilters) ctx.enrich.notice(ignoredFilters);

    return { total_results: total, species };
  },

  format: (result) => {
    const lines: string[] = [`**total_results:** ${result.total_results} taxa`];
    for (const species of result.species) {
      lines.push(
        '',
        `${species.position}. **${inlineText(species.common_name ?? 'no common name')}** (*${inlineText(species.name ?? 'name not recorded')}*) — ${species.observation_count} observations · ${inlineText(species.rank ?? 'rank not recorded')} · ${inlineText(species.iconic_taxon_name ?? 'no iconic group')} · taxon_id ${species.taxon_id}`,
      );
      if (species.photo) lines.push(...renderPhoto(species.photo, 'Photo'));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
