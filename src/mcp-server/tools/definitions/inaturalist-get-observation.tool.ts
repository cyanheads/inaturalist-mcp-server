/**
 * @fileoverview Fetches up to ten observations by id with their community
 * identification thread.
 * @module mcp-server/tools/definitions/inaturalist-get-observation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ObservationSchema, renderObservation } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import type { ObservationExpansion } from '@/services/inaturalist/types.js';

export const inaturalistGetObservation = tool('inaturalist_get_observation', {
  description:
    'Fetch up to 10 observations by id with their community identification thread — who identified what, whether each identification agrees, and the consensus taxon the community landed on. The whole batch costs one upstream request, so resolving ten ids here is far cheaper than ten separate lookups. A missing id is reported per id in unresolved rather than failing the batch; the call fails only when nothing resolved.',
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
        'Embedded arrays to expand per record. identifications is the default and is what carries the thread; the others cost context, so check photo_count and sound_count first.',
      ),
  }),

  output: z.object({
    observations: z
      .array(ObservationSchema)
      .describe('The observations that resolved, with the expansions that were requested.'),
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
    notice: z.string().optional().describe('Guidance when part of the batch did not resolve.'),
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

    const include = new Set<ObservationExpansion>(input.include);
    const { observations, unresolved } = await getINaturalistService().getObservations(
      input.observation_id,
      include,
      ctx,
    );

    if (observations.length === 0) {
      throw ctx.fail(
        'not_found',
        `None of the ${input.observation_id.length} requested observation ids resolved.`,
        { ...ctx.recoveryFor('not_found') },
      );
    }

    if (unresolved.length > 0) {
      ctx.enrich.notice(
        `${unresolved.length} of ${input.observation_id.length} ids returned no observation; they may have been deleted or never existed.`,
      );
    }

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
