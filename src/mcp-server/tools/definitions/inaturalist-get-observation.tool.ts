/**
 * @fileoverview Fetches up to ten observations by id with their community
 * identification thread.
 * @module mcp-server/tools/definitions/inaturalist-get-observation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ObservationSchema, renderObservation } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { THREAD_ENTRY_BUDGET, threadCap } from '@/services/inaturalist/projections.js';
import type { ObservationExpansion, ProjectedObservation } from '@/services/inaturalist/types.js';

/**
 * Names every record whose identifications, comments, or filled observation
 * fields the shared budget cut, and how to reach the rest. Undefined when
 * nothing was cut.
 */
function describeCuts(observations: readonly ProjectedObservation[]): string | undefined {
  const cut: string[] = [];
  for (const observation of observations) {
    const arms = [
      ['identifications', observation.identifications_shown, observation.identifications_total],
      ['comments', observation.comments_shown, observation.comments_total],
      [
        'observation_fields',
        observation.observation_fields_shown,
        observation.observation_fields_total,
      ],
    ] as const;
    const parts = arms
      .filter(([, shown, total]) => shown !== undefined && total !== undefined && shown < total)
      .map(([arm, shown, total]) => `${arm} ${shown} of ${total}`);
    if (parts.length > 0) cut.push(`observation ${observation.id} — ${parts.join(', ')}`);
  }
  if (cut.length === 0) return;

  const cap = threadCap(observations.length);
  return observations.length === 1
    ? `Arrays cut to the first ${cap} entries each, in upstream order: ${cut.join('; ')}. Open the record's url for the full record.`
    : `Arrays cut to the first ${cap} entries each, in upstream order, to share the response across ${observations.length} records: ${cut.join('; ')}. Re-request a single id for up to ${THREAD_ENTRY_BUDGET} entries per array, or open a record's url for the full record.`;
}

export const inaturalistGetObservation = tool('inaturalist_get_observation', {
  description:
    'Fetch up to 10 observations by id with their community identification thread — who identified what, whether each identification agrees, and the consensus taxon the community landed on. The whole batch costs one upstream request, so resolving ten ids here is far cheaper than ten separate lookups. Records come back in the requested order. A missing id is reported per id in unresolved rather than failing the batch; the call fails only when nothing resolved. Long threads and long observation-field lists are cut to fit one response budget shared across the batch — up to 40 identifications, 40 comments, and 40 filled fields for a single id, 4 of each per record for ten — and every record reports the size of each array beside what it kept.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    observation_id: z
      .array(z.number().int().min(1))
      .min(1)
      .max(10)
      .describe(
        'Observation ids to fetch, 1 to 10. Find current ids for an area with inaturalist_search_observations.',
      ),
    include: z
      .array(z.enum(['identifications', 'comments', 'photos', 'annotations', 'sounds']))
      .default(['identifications'])
      .describe(
        'Embedded arrays to expand per record. identifications is the default and is what carries the thread; the others cost context, so check photo_count and sound_count first. identifications and comments — like the observation_fields every record carries — share a 40-entry budget across the batch: each record keeps at most 40 ÷ records returned entries per array (never fewer than 4), and reports identifications_total, comments_total, and observation_fields_total beside what it kept — request one id alone for the 40-entry view.',
      ),
  }),

  output: z.object({
    observations: z
      .array(ObservationSchema)
      .describe(
        'The observations that resolved, in the requested order with unresolved ids left out, carrying the expansions that were requested.',
      ),
    unresolved: z
      .array(
        z
          .object({
            observation_id: z.number().describe('A requested id upstream returned no record for.'),
          })
          .describe('One id that did not resolve.'),
      )
      .describe(
        'Requested ids upstream returned nothing for. They may have been deleted, or never existed.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when part of the batch did not resolve, or when a thread or observation-field list was cut to fit the response.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested ids resolved to an observation.',
      recovery:
        'Check the observation ids, or find current ones for this area with inaturalist_search_observations.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching observations by id', { count: input.observation_id.length });

    const requested = new Set(input.observation_id).size;
    const include = new Set<ObservationExpansion>(input.include);
    const { observations, unresolved } = await getINaturalistService().getObservations(
      input.observation_id,
      include,
      ctx,
    );

    if (observations.length === 0) {
      throw ctx.fail('not_found', `None of the ${requested} requested observation ids resolved.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    // The notice is last-wins, so both conditions are composed into one write.
    const notice = [
      unresolved.length > 0
        ? `${unresolved.length} of ${requested} ids returned no observation; they may have been deleted or never existed.`
        : undefined,
      describeCuts(observations),
    ].filter((segment) => segment !== undefined);
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));

    return {
      observations,
      unresolved: unresolved.map((observation_id) => ({ observation_id })),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const observation of result.observations) {
      lines.push(...renderObservation(observation));
      lines.push('');
    }
    if (result.unresolved.length > 0) {
      lines.push(
        `**Unresolved ids:** ${result.unresolved.map((entry) => entry.observation_id).join(', ')}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
