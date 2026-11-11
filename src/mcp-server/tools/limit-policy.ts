/**
 * @fileoverview Shared schema and runtime policy for bounded read limits.
 * @module mcp-server/tools/limit-policy
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Historical input maxima, retained by strict-mode schemas. */
export const LIMIT_CAPS = {
  resolveName: 30,
  findPlaces: 30,
  searchObservations: 25,
  speciesCounts: 50,
  similarSpecies: 50,
  leaderboard: 250,
  observationBatch: 10,
  submittedObservationIds: 100,
  /** Above the longest by-id array measured (1,393 comments), so one call can take a whole thread. */
  arrayLimit: 1_500,
  radius: 20_040,
} as const;

/** Upstream served ceilings, independent of accepted input maxima. */
export const SERVED_CAPS = { findPlaces: 20, similarSpecies: 24 } as const;

/** Startup snapshot used by validation and execution alike. */
export const clampLimits = getServerConfig().clampLimits;

type LimitTool =
  | 'inaturalist_get_histogram'
  | 'inaturalist_resolve_name'
  | 'inaturalist_find_places'
  | 'inaturalist_search_observations'
  | 'inaturalist_get_species_counts'
  | 'inaturalist_get_similar_species'
  | 'inaturalist_get_leaderboard'
  | 'inaturalist_get_observation';
type LimitField = 'limit' | 'per_page' | 'observation_id' | 'array_limit' | 'radius';
const clampCounter = createCounter(
  'mcp.inaturalist.limits.clamped',
  'Read limits reduced to their documented ceiling',
  '{clamps}',
);

/** Positive safe integer schema; strict mode advertises and enforces its ceiling. */
export function limitSchema(
  cap: number,
  defaultValue: number,
  description: string,
  servedCap = cap,
) {
  const positive = z.number().int().positive();
  return (clampLimits ? positive : positive.max(cap))
    .default(defaultValue)
    .describe(
      servedCap === cap
        ? `${description} Ceiling: ${cap}; oversized values are ${clampLimits ? 'clamped' : 'rejected'}.`
        : `${description} Served ceiling: ${servedCap}; requests above it are reduced to ${servedCap}. ${clampLimits ? 'Positive safe integer requests are accepted.' : `Strict mode accepts requests up to ${cap} and rejects larger values.`}`,
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

/** Records a resolved radius clamp and returns its caller-visible notice, when present. */
export function radiusClampNotice(
  clamp: { requested: number; applied: number } | undefined,
  ctx: Context,
  tool: LimitTool,
): string | undefined {
  return clamp ? applyLimit(clamp.requested, clamp.applied, ctx, tool, 'radius').notice : undefined;
}
