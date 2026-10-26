/**
 * @fileoverview Fetches up to ten observations by id with their community
 * identification thread.
 * @module mcp-server/tools/definitions/inaturalist-get-observation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { clampLimits, LIMIT_CAPS, recordClamp } from '@/mcp-server/tools/limit-policy.js';
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
  description: `Fetch up to ${LIMIT_CAPS.observationBatch} distinct observations by id with their community identification thread — who identified what, whether each identification agrees, and the consensus taxon the community landed on. The whole attempted batch costs one upstream request. Records come back in requested order; remaining distinct ids are deferred for another call with the same include. Missing attempted ids appear in unresolved; the call fails only when nothing resolved and no deferred work remains. Long threads and observation-field lists share a response budget across resolved records — up to ${THREAD_ENTRY_BUDGET} entries per array for one record, ${threadCap(LIMIT_CAPS.observationBatch)} for a full batch — and every record reports the size of each array beside what it kept.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    observation_id: z
      .array(z.number().int().min(1))
      .min(1)
      .max(clampLimits ? LIMIT_CAPS.submittedObservationIds : LIMIT_CAPS.observationBatch)
      .describe(
        `Observation ids to fetch, 1 to ${clampLimits ? LIMIT_CAPS.submittedObservationIds : LIMIT_CAPS.observationBatch} submitted ids. The first ${LIMIT_CAPS.observationBatch} distinct ids are attempted; any remaining distinct ids are deferred to another call. Find current ids for an area with inaturalist_search_observations.`,
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
    deferred: z
      .array(
        z
          .object({ observation_id: z.number().describe('An id not attempted in this call.') })
          .describe('One id to request in a subsequent call.'),
      )
      .describe(
        'Distinct ids beyond the attempted batch, in requested order. Empty when no work remains.',
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
      when: 'None of the attempted ids resolved to an observation and no deferred ids remain.',
      recovery:
        'Check the observation ids, or find current ones for this area with inaturalist_search_observations.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching observations by id', { count: input.observation_id.length });

    const distinct = [...new Set(input.observation_id)];
    const attempted = distinct.slice(0, LIMIT_CAPS.observationBatch);
    const deferred = distinct
      .slice(LIMIT_CAPS.observationBatch)
      .map((observation_id) => ({ observation_id }));
    const requested = attempted.length;
    if (input.observation_id.length > LIMIT_CAPS.observationBatch)
      recordClamp(
        input.observation_id.length,
        LIMIT_CAPS.observationBatch,
        ctx,
        'inaturalist_get_observation',
        'observation_id',
      );
    const include = new Set<ObservationExpansion>(input.include);
    const { observations, unresolved } = await getINaturalistService().getObservations(
      attempted,
      include,
      ctx,
    );

    if (observations.length === 0 && deferred.length === 0) {
      throw ctx.fail('not_found', `None of the ${requested} requested observation ids resolved.`);
    }

    // The notice is last-wins, so both conditions are composed into one write.
    const notice = [
      unresolved.length > 0
        ? `${unresolved.length} of ${requested} ids returned no observation; they may have been deleted or never existed.`
        : undefined,
      describeCuts(observations),
      deferred.length > 0
        ? `${deferred.length} distinct ids were deferred. Call inaturalist_get_observation with the deferred ids and the same include (${input.include.join(', ') || 'empty array'}).`
        : undefined,
    ].filter((segment) => segment !== undefined);
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));

    return {
      observations,
      unresolved: unresolved.map((observation_id) => ({ observation_id })),
      deferred,
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
    if (result.deferred.length > 0)
      lines.push(
        `**Deferred ids:** ${result.deferred.map((entry) => entry.observation_id).join(', ')}`,
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
