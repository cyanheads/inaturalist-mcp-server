/**
 * @fileoverview Ranks the distinct species recorded in an area and period,
 * most-observed first.
 * @module mcp-server/tools/definitions/inaturalist-get-species-counts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaInputShape,
  dateRangeInputShape,
  emptyPageNotice,
  observationFilterInputShape,
  observerProjectInputShape,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
  resolveObserver,
  wideningGuidance,
} from '@/mcp-server/tools/observation-filters.js';
import { inlineText, PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';

const SpeciesSchema = z
  .object({
    position: z
      .number()
      .describe(
        'Absolute place in this ranking, counted from page 1 — 7 is the seventh most-observed species. Not the taxonomic rank, which is rank.',
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
  .describe('One species and how often it was recorded in the requested area and period.');

export const inaturalistGetSpeciesCounts = tool('inaturalist_get_species_counts', {
  description:
    'Rank the distinct species recorded in an area and period, most-observed first — the "what lives here" answer, without paging through individual sightings. An area is given in exactly one form: place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box. Narrow to a clade by passing taxon_id, e.g. the birds of a park, or to one observer or one project by user_id, user_login, or project_id. Defaults to research-grade, wild-only records and echoes those defaults back. For the most active people rather than the most recorded species, use inaturalist_get_leaderboard.',
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
    page: z.number().int().min(1).default(1).describe('Page number. Defaults to 1.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe(
        'Species per page, maximum 50. A ranked species costs roughly 860 bytes across structuredContent and the rendered text together, so 50 is a full page near 43 KB. Upstream would serve 500 in one page — raise page rather than asking for it.',
      ),
  }),

  output: z.object({
    total_results: z
      .number()
      .describe(
        'How many distinct species match. An estimate over a live index — it drifts between calls seconds apart.',
      ),
    species: z
      .array(SpeciesSchema)
      .describe(
        'The species, ranked by observation_count, most-observed first, each at its absolute position.',
      ),
  }),

  enrichment: {
    applied_filters: z
      .object({
        quality_grade: z.array(z.string()).describe('Identification tiers actually searched.'),
        captive: z.boolean().describe('Whether captive and cultivated records were included.'),
      })
      .describe('The server-applied defaults that determine what this answer means.'),
    truncated: z.boolean().describe('True when the page filled per_page and more species follow.'),
    shown: z.number().describe('How many species this page carries.'),
    cap: z.number().describe('The per_page that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Observation count of the last species shown. The ranking is descending, so no species left off this page exceeds it.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, when the page is past the last one holding species, or how to reach the species beyond this page.',
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

    const observer = resolveObserver(input);
    if (!observer.ok) {
      throw ctx.fail('conflicting_observer', observer.message, {
        ...ctx.recoveryFor('conflicting_observer'),
      });
    }

    const params: QueryParams & { page: number; per_page: number } = {
      ...area.value,
      ...annotation.value,
      ...dates.value,
      ...observer.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
      iconic_taxa: input.iconic_taxa,
      page: input.page,
      per_page: input.per_page,
    };

    const hasArea = Object.keys(area.value).length > 0;
    ctx.log.info('Ranking species for an area', { perPage: input.per_page, hasArea });

    const { total, species } = await getINaturalistService().getSpeciesCounts(params, ctx);

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
          emptyPageNotice({ page: input.page, perPage: input.per_page, total, noun: 'species' }),
        );
      } else {
        const lead = 'No species recorded for those filters.';
        const guidance = wideningGuidance(input, hasArea);
        ctx.enrich.notice(guidance ? `${lead} ${guidance}` : lead);
      }
      return { total_results: total, species };
    }

    if (species.length >= input.per_page && input.page * input.per_page < total) {
      // The ranking is descending, so the last count shown bounds every species
      // this page left off.
      const ceiling = species.at(-1)?.observation_count;
      ctx.enrich.truncated({
        shown: species.length,
        cap: input.per_page,
        ...(ceiling === undefined ? {} : { ceiling }),
        guidance: `${total} distinct species match. Raise page to walk further down the ranking, or raise per_page (max 50).`,
      });
    }

    return { total_results: total, species };
  },

  format: (result) => {
    const lines: string[] = [`**total_results:** ${result.total_results} distinct species`];
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
