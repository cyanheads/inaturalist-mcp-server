/**
 * @fileoverview One observation with its identification thread, as injectable
 * conversation context — the same projection `inaturalist_get_observation`
 * returns for a single id.
 * @module mcp-server/resources/definitions/inaturalist-observation.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { ObservationSchema } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import type { ObservationExpansion } from '@/services/inaturalist/types.js';

export const inaturalistObservationResource = resource(
  'inaturalist://observations/{observation_id}',
  {
    name: 'inaturalist-observation',
    description:
      'One iNaturalist observation by numeric id, with its community identification thread expanded — who identified what, whether each identification agrees, and the consensus taxon — plus the observer’s description and filled observation fields. The thread keeps its first 40 identifications and the list its first 40 filled fields, both in upstream order; identifications_total beside identifications_shown, and observation_fields_total beside observation_fields_shown, say whether either was cut, and the record’s url opens the full record. An obscured coordinate is a locality with an accuracy radius, never a sighting position, and a null license_code means all rights reserved.',
    mimeType: 'application/json',
    // Shorter than the taxon resource's: an observation's thread accrues
    // identifications, so a stale read misreports the community consensus.
    cacheHint: { ttlMs: 900_000, cacheScope: 'public' },

    params: z.object({
      observation_id: z
        .string()
        .regex(/^[1-9]\d*$/)
        .describe(
          'Numeric iNaturalist observation id, e.g. 401617560. Find current ids for an area with inaturalist_search_observations.',
        ),
    }),

    output: ObservationSchema,

    async handler(params, ctx) {
      const observationId = Number(params.observation_id);
      ctx.log.info('Reading an observation resource', { observationId });

      const include = new Set<ObservationExpansion>(['identifications']);
      const { observations } = await getINaturalistService().getObservations(
        [observationId],
        include,
        ctx,
      );

      const observation = observations[0];
      if (!observation) {
        throw notFound(`iNaturalist holds no observation with id ${observationId}.`, {
          observation_id: observationId,
          recovery: {
            hint: 'Check the observation id, or find current ones for this area with inaturalist_search_observations.',
          },
        });
      }
      return observation;
    },
  },
);
