/**
 * @fileoverview Shared clamping validation, startup snapshot and telemetry contract.
 * @module tests/config/limit-policy.test
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: () => ({ add }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  add.mockClear();
});

describe('limit policy', () => {
  it.each(['false', 'true'])(
    'loads .env mode %s before constructing every advertised limit schema from a neutral working directory',
    (mode) => {
      const cwd = mkdtempSync(join(tmpdir(), 'inaturalist-policy-'));
      const env = { ...process.env };
      delete env.INATURALIST_CLAMP_LIMITS;
      writeFileSync(
        join(cwd, '.env'),
        `INATURALIST_CLAMP_LIMITS=${mode}\nINATURALIST_USER_AGENT=explicit-agent\n`,
      );
      const source = new URL('../../src/mcp-server/tools/limit-policy.ts', import.meta.url)
        .pathname;
      const toolsRoot = new URL('../../src/mcp-server/tools/definitions/', import.meta.url)
        .pathname;
      const core = import.meta.resolve('@cyanheads/mcp-ts-core');
      try {
        const result = execFileSync(
          'bun',
          [
            '--no-env-file',
            '--eval',
            `const {z}=await import(${JSON.stringify(core)}); const p=await import(${JSON.stringify(source)}); const specs=[['resolve-name','inaturalistResolveName','limit'],['find-places','inaturalistFindPlaces','per_page'],['search-observations','inaturalistSearchObservations','per_page'],['get-species-counts','inaturalistGetSpeciesCounts','per_page'],['get-similar-species','inaturalistGetSimilarSpecies','limit'],['get-leaderboard','inaturalistGetLeaderboard','per_page'],['get-observation','inaturalistGetObservation','observation_id']]; const schemas=[]; let searchValidation; for(const [file,name,field] of specs){ const tool=(await import(${JSON.stringify(toolsRoot)}+'inaturalist-'+file+'.tool.ts'))[name]; schemas.push(z.toJSONSchema(tool.input).properties[field]); if(file==='search-observations') searchValidation=[26,0,-1,2.5].map(per_page=>tool.input.safeParse({per_page}).success); } console.log(JSON.stringify({mode:p.clampLimits,schemas,searchValidation}));`,
          ],
          { cwd, env, encoding: 'utf8', timeout: 20000 },
        );
        const snapshot = JSON.parse(result.trim()) as {
          mode: boolean;
          searchValidation: boolean[];
          schemas: Array<{ maximum?: number; maxItems?: number }>;
        };
        expect(snapshot.mode).toBe(mode === 'true');
        expect(snapshot.searchValidation).toEqual([mode === 'true', false, false, false]);
        expect(snapshot.schemas.slice(0, 6).map((schema) => schema.maximum)).toEqual(
          mode === 'false' ? [30, 30, 25, 50, 50, 250] : Array(6).fill(Number.MAX_SAFE_INTEGER),
        );
        expect(snapshot.schemas[6]?.maxItems).toBe(mode === 'false' ? 10 : 100);
      } finally {
        rmSync(cwd, { recursive: true });
      }
    },
  );
  it.each(['true', 'false'])('validates safe positive integers in %s mode', async (mode) => {
    vi.stubEnv('INATURALIST_CLAMP_LIMITS', mode);
    vi.resetModules();
    const { limitSchema } = await import('@/mcp-server/tools/limit-policy.js');
    const schema = limitSchema(30, 10, 'Candidates');
    expect(schema.parse(undefined)).toBe(10);
    expect(schema.parse(30)).toBe(30);
    expect(schema.safeParse(31).success).toBe(mode === 'true');
    const json = z.toJSONSchema(schema);
    expect(json.maximum).toBe(mode === 'false' ? 30 : Number.MAX_SAFE_INTEGER);
    for (const value of [0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '31'])
      expect(schema.safeParse(value).success).toBe(false);
    expect(schema.description).toContain('30');
  });
  it('records one event only for an overshoot, with bounded labels', async () => {
    vi.stubEnv('INATURALIST_CLAMP_LIMITS', 'true');
    vi.resetModules();
    const { applyLimit } = await import('@/mcp-server/tools/limit-policy.js');
    const ctx = createMockContext();
    const log = vi.spyOn(ctx.log, 'info');
    expect(applyLimit(30, 30, ctx, 'inaturalist_resolve_name', 'limit')).toEqual({ applied: 30 });
    expect(add).not.toHaveBeenCalled();
    expect(applyLimit(31, 30, ctx, 'inaturalist_resolve_name', 'limit')).toEqual({
      applied: 30,
      notice: 'limit 31 was clamped to 30.',
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(1, {
      tool: 'inaturalist_resolve_name',
      field: 'limit',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith('Read limit clamped', {
      tool: 'inaturalist_resolve_name',
      field: 'limit',
      requested: 31,
      applied: 30,
    });
  });
  it('keeps schemas and policy fixed after startup', async () => {
    vi.stubEnv('INATURALIST_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const policy = await import('@/mcp-server/tools/limit-policy.js');
    vi.stubEnv('INATURALIST_CLAMP_LIMITS', 'true');
    expect(policy.clampLimits).toBe(false);
    expect(policy.limitSchema(30, 10, 'Candidates').safeParse(31).success).toBe(false);
    const { inaturalistGetObservation } = await import(
      '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js'
    );
    expect(
      inaturalistGetObservation.input.safeParse({ observation_id: Array(11).fill(1) }).success,
    ).toBe(false);
    const schema = z.toJSONSchema(inaturalistGetObservation.input);
    expect(schema.properties?.observation_id).toMatchObject({ maxItems: 10 });
  });
});
