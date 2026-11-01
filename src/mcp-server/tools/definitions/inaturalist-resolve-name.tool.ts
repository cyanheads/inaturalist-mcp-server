/**
 * @fileoverview Resolves a common or scientific name, a place, a project, or an
 * observer to the integer id the rest of the surface takes.
 * @module mcp-server/tools/definitions/inaturalist-resolve-name.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { applyLimit, LIMIT_CAPS, limitSchema } from '@/mcp-server/tools/limit-policy.js';
import {
  blankAsUnset,
  emptyPageNotice,
  RESULT_WINDOW,
} from '@/mcp-server/tools/observation-filters.js';
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
  'No taxon matched that text. Try fewer words, check the spelling, or try the scientific name; taxon matching uses word starts within a name.';
const NO_TAXON_MATCH_AT_RANK =
  'No taxon of that rank matched that text. Re-run without rank, or list valid ranks with inaturalist_list_reference topic ranks.';
const NO_RECORD_MATCH =
  'No place, project, or observer matched that text. Try fewer words, or set type to any to search every record kind at once.';
const NO_ANY_MATCH =
  'Nothing matched that text across taxa, places, projects, or observers. Try fewer words or a different spelling.';

export const inaturalistResolveName = tool('inaturalist_resolve_name', {
  description:
    'Resolve organism, place, project, or observer names to identifiers. Taxon lookup matches word starts within a name, not only its beginning; other types use cross-kind search with limited spelling tolerance. Without page, candidates retain relevance order. Explicit taxon pages browse name matches in ascending taxon-ID order; this can differ from autocomplete matching across languages. A miss returns found false with recovery guidance.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    q: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'The name to resolve. Taxon queries match word starts within a name or an exact numeric taxon id; other types match record text with limited spelling tolerance.',
      ),
    type: blankAsUnset(
      z.enum(['taxon', 'place', 'project', 'user', 'any']).default('taxon'),
    ).describe(
      'Which kind of record to resolve. "taxon" uses autocomplete unless an explicit page browses name matches in taxon-ID order; numeric taxon IDs always use autocomplete. Other types use scored cross-kind search, and "any" searches all kinds. For place geometry and containment, use inaturalist_find_places.',
    ),
    rank: blankAsUnset(z.enum(RANKS).optional()).describe(
      'Restrict taxon candidates to one rank. Honoured only on type "taxon" — the cross-kind search has no rank filter.',
    ),
    limit: limitSchema(
      LIMIT_CAPS.resolveName,
      10,
      'Maximum candidates to return, applied to every type.',
    ),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional page for browsing beyond relevance-ranked suggestions. Taxon name pages use ascending taxon-ID order from page 1; numeric taxon IDs have only one page. Keep limit unchanged while paging. page × applied limit must not exceed 10,000.',
      ),
  }),

  output: z.object({
    found: z
      .boolean()
      .describe(
        'True when candidates matched, including an empty explicit page past an existing match set.',
      ),
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
            name: z
              .string()
              .nullable()
              .describe(
                'Scientific name on taxa, place name, project title, or an observer’s display name — which falls back to the login when the observer set none.',
              ),
            login: z
              .string()
              .optional()
              .describe(
                'Observer login, on users only — the value inaturalist_get_leaderboard entries and an observation’s observer carry.',
              ),
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
      .describe(
        'Candidates in relevance order, or ascending taxon-ID order on explicit taxon name pages.',
      ),
    guidance: z
      .string()
      .optional()
      .describe(
        'Why nothing matched and what to try instead. Present only when found is false — this is the primary result of a miss.',
      ),
  }),

  enrichment: {
    notice: z.string().optional().describe('Composed clamp, continuation, or empty-page guidance.'),
    totalCount: z
      .number()
      .describe('Total candidates upstream matched, before the limit was applied.'),
    truncated: z
      .boolean()
      .describe('True when further matching candidates remain beyond this slice.'),
    shown: z.number().describe('Number of candidates returned on this slice.'),
    cap: z.number().describe('Applied candidate limit.'),
  },

  errors: [
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An explicit page multiplied by the applied limit exceeds 10,000.',
      recovery:
        'Use an earlier page, narrow the query text, or add a taxon rank filter to keep the requested window within 10,000 candidates.',
    },
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
      throw ctx.fail('rank_not_applicable', `rank does not apply to type "${input.type}".`);
    }

    const { applied: limit, notice } = applyLimit(
      input.limit,
      LIMIT_CAPS.resolveName,
      ctx,
      'inaturalist_resolve_name',
      'limit',
    );
    if (notice) ctx.enrich.notice(notice);
    const lastPage = Math.floor(RESULT_WINDOW / limit);
    if (input.page !== undefined && input.page > lastPage) {
      throw ctx.fail('result_window_exceeded', 'page × applied limit must not exceed 10,000.');
    }
    ctx.log.info('Resolving a name', { type: input.type, limit });
    const service = getINaturalistService();

    const page = input.page === undefined ? {} : { page: input.page };
    const result =
      input.type === 'taxon'
        ? await service.autocompleteTaxa({ q: input.q, rank: input.rank, limit, ...page }, ctx)
        : await service.searchRecords(
            { q: input.q, sources: SOURCES[input.type], limit, ...page },
            ctx,
          );

    ctx.enrich.total(result.total);

    // The taxon autocomplete returns related taxa past its per_page, so limit
    // is applied here on every route rather than trusted to upstream.
    const numeric = input.type === 'taxon' && Number.isInteger(Number(input.q));
    const candidates =
      numeric && input.page !== undefined && input.page > 1
        ? []
        : result.candidates.slice(0, limit);
    const total = numeric ? Math.min(result.total, 1) : result.total;
    const offset = ((input.page ?? 1) - 1) * (numeric ? 1 : limit);
    const truncated = candidates.length > 0 && offset + candidates.length < total;
    ctx.enrich({ truncated, shown: candidates.length, cap: limit });
    if (candidates.length === 0 && total > 0 && input.page !== undefined) {
      ctx.enrich.notice(
        [
          notice,
          emptyPageNotice({
            page: input.page,
            perPage: numeric ? 1 : limit,
            total,
            noun: 'candidates',
          }),
        ]
          .filter(Boolean)
          .join(' '),
      );
      return { found: true, candidates };
    }
    if (candidates.length > 0) {
      if (truncated) {
        const recovery =
          input.page === undefined
            ? 'Narrow the text, add a taxon rank where applicable, or request page: 1 to browse further. Explicit taxon name pages use ascending taxon-ID order rather than relevance order.'
            : input.page + 1 > lastPage
              ? 'The 10,000-candidate paging window is exhausted. Narrow the query text or add a taxon rank where applicable.'
              : `Request page ${input.page + 1} with the same limit to continue${input.type === 'taxon' ? ' in ascending taxon-ID order' : ''}.`;
        ctx.enrich.notice([notice, recovery].filter(Boolean).join(' '));
      }
      return { found: true, candidates };
    }

    const guidance =
      input.type === 'any'
        ? NO_ANY_MATCH
        : input.type !== 'taxon'
          ? NO_RECORD_MATCH
          : input.rank === undefined
            ? NO_TAXON_MATCH
            : NO_TAXON_MATCH_AT_RANK;
    return { found: false, candidates: [], guidance };
  },

  format: (result) => {
    const lines: string[] = [
      `**found:** ${result.found} — ${result.candidates.length === 0 ? (result.found ? 'No candidates on this page' : 'No match') : `${result.candidates.length} candidates`}`,
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
      if (candidate.login) parts.push(`login ${inlineText(candidate.login)}`);
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
