/**
 * @fileoverview Lists the taxa a taxon is most often misidentified as, ranked by
 * how many times identifiers made the correction.
 * @module mcp-server/tools/definitions/inaturalist-get-similar-species.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  areaInputShape,
  dateRangeInputShape,
  observationFilterInputShape,
  resolveArea,
} from '@/mcp-server/tools/observation-filters.js';
import { PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';
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
        'How many times identifiers corrected this taxon to the queried one. The ranking key.',
      ),
    photo: PhotoSchema.optional().describe('Representative photo, when the taxon carries one.'),
  })
  .describe('One look-alike and how often it is confused with the queried taxon.');

export const inaturalistGetSimilarSpecies = tool('inaturalist_get_similar_species', {
  description:
    'List the taxa this one is most often misidentified as, ranked by how many times identifiers made the correction — the field-identification check before committing to a look-alike. Scope it to an area in exactly one form (place_id, the lat/lng/radius triple in kilometres, or a four-corner bounding box) to see the confusion set a specific region actually produces, or leave the area off for the global set. Resolve the organism name to a taxon id with inaturalist_resolve_name first.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    taxon_id: z
      .number()
      .int()
      .min(1)
      .describe(
        'Numeric taxon id to find look-alikes for. Resolve a name to an id with inaturalist_resolve_name.',
      ),
    ...areaInputShape,
    ...dateRangeInputShape,
    quality_grade,
    captive,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        'Maximum look-alikes to return. Applied in-process — the upstream endpoint publishes no page size and returns its whole confusion set.',
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
    truncated: z.boolean().describe('True when the limit cut the confusion set.'),
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

    const params: QueryParams = {
      ...area.value,
      taxon_id: input.taxon_id,
      d1: input.d1,
      d2: input.d2,
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
      ctx.enrich.notice(
        'No look-alikes are recorded for this taxon — either it is rarely misidentified, or the area filter is too narrow. Re-run without the area filter to see the global confusion set.',
      );
    } else if (similar.length > shown.length) {
      // The ranking is descending, so the last count shown bounds every
      // look-alike the limit cut.
      const ceiling = shown.at(-1)?.misidentification_count;
      ctx.enrich.truncated({
        shown: shown.length,
        cap: input.limit,
        ...(ceiling === undefined ? {} : { ceiling }),
        guidance: `${similar.length} look-alikes are recorded. Raise limit (max 50) to see the rest of the confusion set.`,
      });
    }

    return { taxon_id: input.taxon_id, similar_species: shown };
  },

  format: (result) => {
    const lines: string[] = [
      `**taxon_id:** ${result.taxon_id} · **look-alikes returned:** ${result.similar_species.length}`,
    ];
    for (const [index, species] of result.similar_species.entries()) {
      lines.push(
        '',
        `${index + 1}. **${species.common_name ?? 'no common name'}** (*${species.name ?? 'name not recorded'}*) — corrected ${species.misidentification_count} times · ${species.rank ?? 'rank not recorded'} · ${species.observations_count ?? 'observation count not published'} observations · taxon_id ${species.taxon_id}`,
      );
      if (species.photo) lines.push(...renderPhoto(species.photo, 'Photo'));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
