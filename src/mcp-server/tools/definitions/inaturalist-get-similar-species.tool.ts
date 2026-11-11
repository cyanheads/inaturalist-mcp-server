/**
 * @fileoverview Lists related taxa ranked by observations identified as both taxa.
 * @module mcp-server/tools/definitions/inaturalist-get-similar-species.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyLimit,
  LIMIT_CAPS,
  limitSchema,
  radiusClampNotice,
  SERVED_CAPS,
} from '@/mcp-server/tools/limit-policy.js';
import {
  areaInputShape,
  captiveCohortNotice,
  dateRangeInputShape,
  observationFilterInputShape,
  resolveArea,
  resolveDateRange,
} from '@/mcp-server/tools/observation-filters.js';
import { inlineText, PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';
import {
  getINaturalistService,
  type QueryParams,
} from '@/services/inaturalist/inaturalist-service.js';

const { quality_grade, captive } = observationFilterInputShape;

const SimilarSpeciesSchema = z
  .object({
    taxon_id: z
      .number()
      .describe('Taxon id of the look-alike — pass it to inaturalist_get_taxon for its profile.'),
    name: z.string().nullable().describe('Scientific name.'),
    common_name: z.string().nullable().describe('Preferred common name, when one is recorded.'),
    rank: z.string().nullable().describe('Taxonomic rank, e.g. "species".'),
    observations_count: z
      .number()
      .nullable()
      .describe(
        'How many observations this look-alike has overall. Null when upstream published none.',
      ),
    misidentification_count: z
      .number()
      .describe(
        'Observations identified as both taxa under the call’s filters: a symmetric count of current, non-hidden identifications, including finer taxa through their ancestors. Withdrawn identifications are excluded. The ranking key.',
      ),
    photo: PhotoSchema.optional().describe('Representative photo, when the taxon carries one.'),
  })
  .describe('One look-alike and how often it is confused with the queried taxon.');

export const inaturalistGetSimilarSpecies = tool('inaturalist_get_similar_species', {
  description:
    'List related taxa ranked by observations carrying current identifications of both taxa. This is co-identification evidence, not a directional correction count or an exhaustive list of visually similar organisms. Scope it to an area in exactly one form (place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box), or leave the area off for global results. The taxon must be a genus or finer (genus, species, or below). Resolve the organism name to a taxon id with inaturalist_resolve_name first.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    taxon_id: z
      .number()
      .int()
      .min(1)
      .describe(
        'Numeric taxon id to find look-alikes for, at genus or finer — a genus, species, or subspecies; a family or anything coarser is refused. Resolve a name to an id with inaturalist_resolve_name.',
      ),
    ...areaInputShape,
    ...dateRangeInputShape,
    quality_grade,
    captive,
    limit: limitSchema(
      LIMIT_CAPS.similarSpecies,
      20,
      'Maximum related taxa to return.',
      SERVED_CAPS.similarSpecies,
    ),
  }),

  output: z.object({
    taxon_id: z.number().describe('The taxon the look-alikes were found for.'),
    similar_species: z
      .array(SimilarSpeciesSchema)
      .describe('Look-alikes ranked by misidentification_count, most-confused first.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('How many look-alikes upstream returned, before the limit was applied.'),
    truncated: z
      .boolean()
      .describe(
        'True when the local limit cut the list or upstream reached its ceiling, so more related taxa may exist.',
      ),
    shown: z.number().describe('How many look-alikes this response carries.'),
    cap: z.number().describe('The limit that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Misidentification count of the last look-alike shown. The ranking is descending, so no omitted look-alike exceeds it.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no look-alikes are recorded, or when the limit cut the set.'),
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
      reason: 'unknown_taxon_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the taxon_id does not exist.',
      recovery:
        'Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.',
      thrownBy: 'service',
    },
    {
      reason: 'taxon_rank_too_coarse',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the taxon is coarser than genus, such as a family, order, or class.',
      recovery:
        'Pass a genus or species id: resolve a specific organism by name with inaturalist_resolve_name, or walk children with inaturalist_get_taxon down to a genus, which takes several calls from a class (order, family, subfamily, tribe, subtribe, genus).',
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

  async handler(requestedInput, ctx) {
    requestedInput = {
      ...requestedInput,
      quality_grade: [...new Set(requestedInput.quality_grade)],
    };
    const { applied, notice: limitNotice } = applyLimit(
      requestedInput.limit,
      SERVED_CAPS.similarSpecies,
      ctx,
      'inaturalist_get_similar_species',
      'limit',
    );
    const input = { ...requestedInput, limit: applied };
    const area = resolveArea(input);
    if (!area.ok) {
      throw ctx.fail('invalid_geography', area.message);
    }
    const radiusNotice = radiusClampNotice(
      area.radiusClamp,
      ctx,
      'inaturalist_get_similar_species',
    );
    const leadNotices = [limitNotice, radiusNotice, captiveCohortNotice(input)]
      .filter(Boolean)
      .join(' ');

    const dates = resolveDateRange(input);
    if (!dates.ok) {
      throw ctx.fail('inverted_date_range', dates.message);
    }

    const params: QueryParams = {
      ...area.value,
      ...dates.value,
      taxon_id: input.taxon_id,
      quality_grade: input.quality_grade,
      captive: input.captive,
    };

    ctx.log.info('Fetching the confusion set for a taxon', {
      taxonId: input.taxon_id,
      limit: input.limit,
    });

    const { similar } = await getINaturalistService().getSimilarSpecies(params, ctx);
    const shown = similar.slice(0, input.limit);
    ctx.enrich.total(similar.length);
    // The baseline disclosure rides every path — the enrichment block declares
    // these three as required, and `ctx.enrich.truncated` below overwrites them
    // on the one path where the limit actually cut the set.
    ctx.enrich({ truncated: false, shown: shown.length, cap: input.limit });

    if (shown.length === 0) {
      // Names only the scoping filters the call supplied.
      const scope = [
        ...(Object.keys(area.value).length > 0 ? ['the area filter'] : []),
        ...(input.d1 !== undefined || input.d2 !== undefined ? ['the d1/d2 range'] : []),
      ];
      ctx.enrich.notice(
        [
          leadNotices,
          scope.length === 0
            ? 'No related taxa were returned for these filters.'
            : `No related taxa were returned for these filters. Re-run without ${scope.join(' and ')} to broaden the result.`,
        ]
          .filter(Boolean)
          .join(' '),
      );
    } else if (similar.length > shown.length || similar.length >= SERVED_CAPS.similarSpecies) {
      // The ranking is descending, so the last count shown bounds every
      // look-alike the limit cut.
      const ceiling = shown.at(-1)?.misidentification_count;
      ctx.enrich.truncated({
        shown: shown.length,
        cap: input.limit,
        ...(ceiling === undefined ? {} : { ceiling }),
        guidance: [
          leadNotices,
          input.limit < SERVED_CAPS.similarSpecies
            ? `Raise limit (max ${SERVED_CAPS.similarSpecies}) to see more returned taxa. Upstream serves at most 24 and publishes no paging, so further taxa may be omitted.`
            : 'Upstream serves at most 24 related taxa and publishes no paging, so this list may be cut. Narrow the area or date filters to explore a smaller set.',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else if (leadNotices) ctx.enrich.notice(leadNotices);

    return { taxon_id: input.taxon_id, similar_species: shown };
  },

  format: (result) => {
    const lines: string[] = [
      `**taxon_id:** ${result.taxon_id} · **look-alikes returned:** ${result.similar_species.length}`,
    ];
    for (const [index, species] of result.similar_species.entries()) {
      lines.push(
        '',
        `${index + 1}. **${inlineText(species.common_name ?? 'no common name')}** (*${inlineText(species.name ?? 'name not recorded')}*) — ${species.misidentification_count} observations identified as both · ${inlineText(species.rank ?? 'rank not recorded')} · ${species.observations_count ?? 'observation count not published'} observations · taxon_id ${species.taxon_id}`,
      );
      if (species.photo) lines.push(...renderPhoto(species.photo, 'Photo'));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
