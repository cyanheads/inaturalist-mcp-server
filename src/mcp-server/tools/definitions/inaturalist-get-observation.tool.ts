/**
 * @fileoverview Fetches up to ten observations by id with their community
 * identification thread.
 * @module mcp-server/tools/definitions/inaturalist-get-observation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  applyLimit,
  clampLimits,
  LIMIT_CAPS,
  limitSchema,
  recordClamp,
} from '@/mcp-server/tools/limit-policy.js';
import { ObservationSchema, renderObservation } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { THREAD_ENTRY_BUDGET, threadCap } from '@/services/inaturalist/projections.js';
import type { ObservationExpansion, ProjectedObservation } from '@/services/inaturalist/types.js';

/**
 * Every capped array of one record with its page counts, in the order the
 * record block renders their headings, so the cut notice lists them that way.
 */
function cappedArrays(observation: ProjectedObservation) {
  return [
    [
      'observation_fields',
      observation.observation_fields_shown,
      observation.observation_fields_total,
    ],
    ['identifications', observation.identifications_shown, observation.identifications_total],
    ['comments', observation.comments_shown, observation.comments_total],
  ] as const;
}

/**
 * The one response-level continuation of every capped array of every record,
 * and the notice naming each record whose arrays continue, the entries this
 * page kept, and the call that continues them. An array with entries past this
 * page took the whole per-record share, so the next page of all of them starts
 * at `arrayOffset + share`.
 */
function describeCuts(
  observations: readonly ProjectedObservation[],
  arrayOffset: number,
  arrayLimit: number,
): { next_array_offset: number | null; notice?: string } {
  const cuts: string[] = [];
  for (const observation of observations) {
    const parts = cappedArrays(observation)
      .filter(
        ([, shown, total]) =>
          shown !== undefined && total !== undefined && arrayOffset + shown < total,
      )
      .map(([arm, shown, total]) => `${arm} ${shown} of ${total}`);
    if (parts.length > 0) cuts.push(`observation ${observation.id} — ${parts.join(', ')}`);
  }
  if (cuts.length === 0) return { next_array_offset: null };

  const records = observations.length;
  const next = arrayOffset + threadCap(records, arrayLimit);
  const range = `entries ${arrayOffset + 1}–${next} of each, by ascending id`;
  const raise =
    arrayLimit < LIMIT_CAPS.arrayLimit
      ? `, or raise array_limit (ceiling ${LIMIT_CAPS.arrayLimit}) for more per ${records === 1 ? 'call' : 'record'}`
      : '';
  return {
    next_array_offset: next,
    notice:
      records === 1
        ? `Arrays cut to ${range}: ${cuts.join('; ')}. Pass array_offset ${next} (next_array_offset) with the same include for the next entries${raise}.`
        : `Arrays cut to ${range}, sharing array_limit ${arrayLimit} across ${records} records: ${cuts.join('; ')}. Pass array_offset ${next} (next_array_offset) with the same observation_id and include for the next entries${raise}.`,
  };
}

export const inaturalistGetObservation = tool('inaturalist_get_observation', {
  description: `Fetch up to ${LIMIT_CAPS.observationBatch} distinct observations by id with their community identification thread — who identified what, whether each identification agrees, and the consensus taxon the community landed on. The whole attempted batch costs one upstream request. Records come back in requested order; remaining distinct ids are deferred for another call with the same include. Missing attempted ids appear in unresolved; the call fails only when nothing resolved and no deferred work remains. Identifications, comments, and observation fields are sorted by ascending id (creation order) and share the array_limit budget across resolved records — by default up to ${THREAD_ENTRY_BUDGET} entries per array for one record, ${threadCap(LIMIT_CAPS.observationBatch)} for a full batch; every record reports the size of each array beside what it kept, and next_array_offset pages the rest.`,
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
        `Embedded arrays to expand per record. identifications is the default and is what carries the thread; the others cost context, so check photo_count and sound_count first. identifications and comments — like the observation_fields every record carries — are sorted by ascending id and share the array_limit budget (default ${THREAD_ENTRY_BUDGET}) across the batch: each record keeps min(array_limit, max(4, floor(array_limit ÷ records returned))) entries per array from array_offset, and reports identifications_total, comments_total, and observation_fields_total beside what it kept.`,
      ),
    array_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Absolute index into every capped array (identifications, comments, observation_fields), each sorted by ascending id: 0 starts at the earliest entry. Pass the previous reply’s next_array_offset to continue; new entries append, so offsets stay valid as a thread grows. For the newest identifications, include only identifications and set this to identifications_total minus array_limit. Past the end returns empty arrays with their totals.',
      ),
    array_limit: limitSchema(
      LIMIT_CAPS.arrayLimit,
      THREAD_ENTRY_BUDGET,
      'Entry budget per capped array, shared across the records returned: each record keeps min(array_limit, max(4, floor(array_limit ÷ records))) entries of each. One call can take a whole thread of one record.',
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
    array_offset: z
      .number()
      .describe('The array_offset this page of every capped array starts at.'),
    next_array_offset: z
      .number()
      .nullable()
      .describe(
        'Pass as array_offset with the same observation_id and include to continue every capped array of every record. Null when no array holds entries past this page.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .describe(
        'True when a capped array of any record holds entries past this page; next_array_offset continues it.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when part of the batch did not resolve, when array_limit was clamped, or when a thread or observation-field list continues past this page.',
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

  async handler(input, ctx) {
    ctx.log.info('Fetching observations by id', { count: input.observation_id.length });
    const { applied: arrayLimit, notice: clampNotice } = applyLimit(
      input.array_limit,
      LIMIT_CAPS.arrayLimit,
      ctx,
      'inaturalist_get_observation',
      'array_limit',
    );

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
    const arrayOffset = input.array_offset;
    const { observations, unresolved } = await getINaturalistService().getObservations(
      attempted,
      include,
      ctx,
      { arrayOffset, arrayLimit },
    );

    if (observations.length === 0 && deferred.length === 0) {
      throw ctx.fail('not_found', `None of the ${requested} requested observation ids resolved.`);
    }

    const pages = describeCuts(observations, arrayOffset, arrayLimit);
    // The notice is last-wins, so every condition is composed into one write.
    const notice = [
      clampNotice,
      unresolved.length > 0
        ? `${unresolved.length} of ${requested} ids returned no observation; they may have been deleted or never existed.`
        : undefined,
      pages.notice,
      deferred.length > 0
        ? `${deferred.length} distinct ids were deferred. Call inaturalist_get_observation with the deferred ids and the same include (${input.include.join(', ') || 'empty array'})${arrayOffset > 0 ? ', from array_offset 0' : ''}.`
        : undefined,
    ].filter((segment) => segment !== undefined);
    ctx.enrich({ truncated: pages.next_array_offset !== null });
    if (notice.length > 0) ctx.enrich.notice(notice.join(' '));

    return {
      observations,
      unresolved: unresolved.map((observation_id) => ({ observation_id })),
      deferred,
      array_offset: arrayOffset,
      next_array_offset: pages.next_array_offset,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const observation of result.observations) {
      lines.push(...renderObservation(observation, result.array_offset));
      lines.push('');
    }
    lines.push(
      `**Array page:** array_offset ${result.array_offset} · next_array_offset ${result.next_array_offset ?? 'null — no capped array continues past this page'}`,
    );
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
