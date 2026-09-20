/**
 * @fileoverview Resolves a common or scientific name, a place, a project, or an
 * observer to the integer id the rest of the surface takes.
 * @module mcp-server/tools/definitions/inaturalist-resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inlineText, PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { RANKS } from '@/services/inaturalist/vocabularies.js';

/** `/search` scopes by record kind through its `sources` parameter. */
const SOURCES: Readonly<Record<string, string | undefined>> = {
  place: 'places',
  project: 'projects',
  user: 'users',
  any: undefined,
};

const NO_TAXON_MATCH =
  'No taxon name starts with that text — the taxon search matches a name prefix, not words inside a name. Try the scientific name, a shorter prefix, or drop the rank filter.';
const NO_TAXON_MATCH_AT_RANK =
  'No taxon of that rank starts with that text. Re-run without rank, or list valid ranks with inaturalist_list_reference topic ranks.';
const NO_RECORD_MATCH =
  'No place, project, or observer matched that text. Try fewer words, or set type to any to search every record kind at once.';

export const inaturalistResolveName = tool('inaturalist_resolve_name', {
  description:
    'Resolve a common or scientific name to a taxon id, or a place, project, or observer name to its id. Returns ranked candidates carrying the identifiers every other tool takes. A miss is a result rather than a failure: found comes back false with guidance naming why. Taxon lookup matches a name PREFIX, not words inside a name, so "monarch butterfly" misses where "monarch" hits.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    q: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'The name to resolve. On type "taxon" this is a name prefix or an exact taxon id; on the other types it is matched across the record text.',
      ),
    type: z
      .enum(['taxon', 'place', 'project', 'user', 'any'])
      .default('taxon')
      .describe(
        'Which kind of record to resolve. "taxon" uses the taxon autocomplete; the rest use the scored cross-kind search, and "any" searches every kind at once. For a place’s bounding box and containment chain rather than just its id, use inaturalist_find_places instead.',
      ),
    rank: z
      .enum(RANKS)
      .optional()
      .describe(
        'Restrict taxon candidates to one rank. Honoured only on type "taxon" — the cross-kind search has no rank filter.',
      ),
    limit: z.number().int().min(1).max(30).default(10).describe('Maximum candidates to return.'),
  }),

  output: z.object({
    found: z.boolean().describe('True when at least one candidate matched.'),
    candidates: z
      .array(
        z
          .object({
            kind: z
              .enum(['taxon', 'place', 'project', 'user'])
              .describe('Which record kind this candidate is.'),
            id: z
              .number()
              .describe(
                'The identifier to pass onward — taxon_id, place_id, project id, or user id.',
              ),
            name: z.string().nullable().describe('Scientific name, place name, or login.'),
            common_name: z.string().optional().describe('Preferred common name, on taxa.'),
            rank: z.string().optional().describe('Taxonomic rank, on taxa.'),
            display_name: z
              .string()
              .optional()
              .describe('Place name with its administrative context, on places.'),
            slug: z.string().optional().describe('URL slug, on places and projects.'),
            matched_term: z
              .string()
              .optional()
              .describe('The name variant that actually matched the query.'),
            score: z
              .number()
              .optional()
              .describe(
                'Relevance score, on the cross-kind search only. No fixed range — meaningful only relative to other candidates in this response, which are already sorted best match first.',
              ),
            observations_count: z
              .number()
              .optional()
              .describe('How many observations the record covers.'),
            photo: PhotoSchema.optional().describe(
              'Representative photo, when the record carries one.',
            ),
          })
          .describe('One ranked candidate.'),
      )
      .describe('Ranked candidates, best match first.'),
    guidance: z
      .string()
      .optional()
      .describe(
        'Why nothing matched and what to try instead. Present only when found is false — this is the primary result of a miss.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total candidates upstream matched, before the limit was applied.'),
  },

  errors: [
    {
      reason: 'rank_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'rank was supplied with a type other than taxon.',
      recovery:
        'Drop rank, or set type to taxon where the rank filter applies; list valid ranks with inaturalist_list_reference topic ranks.',
    },
  ],

  async handler(input, ctx) {
    if (input.rank !== undefined && input.type !== 'taxon') {
      throw ctx.fail('rank_not_applicable', `rank does not apply to type "${input.type}".`, {
        ...ctx.recoveryFor('rank_not_applicable'),
      });
    }

    ctx.log.info('Resolving a name', { type: input.type, limit: input.limit });
    const service = getINaturalistService();

    const result =
      input.type === 'taxon'
        ? await service.autocompleteTaxa({ q: input.q, rank: input.rank, limit: input.limit }, ctx)
        : await service.searchRecords(
            { q: input.q, sources: SOURCES[input.type], limit: input.limit },
            ctx,
          );

    ctx.enrich.total(result.total);

    if (result.candidates.length > 0) {
      return { found: true, candidates: result.candidates };
    }

    const guidance =
      input.type !== 'taxon'
        ? NO_RECORD_MATCH
        : input.rank === undefined
          ? NO_TAXON_MATCH
          : NO_TAXON_MATCH_AT_RANK;
    return { found: false, candidates: [], guidance };
  },

  format: (result) => {
    const lines: string[] = [
      `**found:** ${result.found} — ${result.candidates.length === 0 ? 'No match' : `${result.candidates.length} candidates`}`,
    ];

    for (const candidate of result.candidates) {
      const other = candidate.display_name ?? candidate.name;
      const heading =
        candidate.kind === 'taxon'
          ? `${inlineText(candidate.common_name ?? 'no common name')} (${inlineText(candidate.name ?? 'name not published')})`
          : other === null || other === undefined
            ? '*(name not published)*'
            : inlineText(other);
      lines.push('', `## ${heading}`);

      const parts = [`kind ${candidate.kind}`, `id ${candidate.id}`];
      if (candidate.name) parts.push(`name ${inlineText(candidate.name)}`);
      if (candidate.common_name) parts.push(`common name ${inlineText(candidate.common_name)}`);
      if (candidate.rank) parts.push(`rank ${inlineText(candidate.rank)}`);
      if (candidate.display_name) parts.push(`display name ${inlineText(candidate.display_name)}`);
      if (candidate.slug) parts.push(`slug ${inlineText(candidate.slug)}`);
      if (candidate.matched_term) {
        parts.push(`matched on "${inlineText(candidate.matched_term)}"`);
      }
      if (candidate.score !== undefined) parts.push(`score ${candidate.score}`);
      if (candidate.observations_count !== undefined) {
        parts.push(`${candidate.observations_count} observations`);
      }
      lines.push(parts.join(' · '));
      if (candidate.photo) lines.push(...renderPhoto(candidate.photo, 'Photo'));
    }

    if (result.guidance) lines.push('', result.guidance);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
