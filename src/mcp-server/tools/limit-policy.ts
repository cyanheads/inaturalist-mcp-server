/**
 * @fileoverview Shared schema and runtime policy for bounded read limits.
 * @module mcp-server/tools/limit-policy
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Ceilings shared by advertised schemas, handlers and descriptions. */
export const LIMIT_CAPS = {
  resolveName: 30,
  findPlaces: 30,
  searchObservations: 25,
  speciesCounts: 50,
  similarSpecies: 50,
  leaderboard: 250,
  observationBatch: 10,
  submittedObservationIds: 100,
} as const;

/** Startup snapshot used by validation and execution alike. */
export const clampLimits = getServerConfig().clampLimits;

type LimitTool =
  | 'inaturalist_resolve_name'
  | 'inaturalist_find_places'
  | 'inaturalist_search_observations'
  | 'inaturalist_get_species_counts'
  | 'inaturalist_get_similar_species'
  | 'inaturalist_get_leaderboard'
  | 'inaturalist_get_observation';
type LimitField = 'limit' | 'per_page' | 'observation_id';
const clampCounter = createCounter(
  'mcp.inaturalist.limits.clamped',
  'Read limits reduced to their documented ceiling',
  '{clamps}',
);

/** Positive safe integer schema; strict mode advertises and enforces its ceiling. */
export function limitSchema(cap: number, defaultValue: number, description: string) {
  const positive = z.number().int().positive();
  return (clampLimits ? positive : positive.max(cap))
    .default(defaultValue)
    .describe(
      `${description} Ceiling: ${cap}; oversized values are ${clampLimits ? 'clamped' : 'rejected'}.`,
    );
}

/** Emits one event with bounded tool/field labels; values remain in logs only. */
export function recordClamp(
  requested: number,
  applied: number,
  ctx: Context,
  tool: LimitTool,
  field: LimitField,
): void {
  ctx.log.info('Read limit clamped', { tool, field, requested, applied });
  clampCounter.add(1, { tool, field });
}

/** Resolves the value before request construction, pagination or local slicing. */
export function applyLimit(
  requested: number,
  cap: number,
  ctx: Context,
  tool: LimitTool,
  field: LimitField,
): { applied: number; notice?: string } {
  if (requested <= cap) return { applied: requested };
  recordClamp(requested, cap, ctx, tool, field);
  return { applied: cap, notice: `${field} ${requested} was clamped to ${cap}.` };
}
