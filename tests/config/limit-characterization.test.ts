/**
 * @fileoverview Characterizes unchanged valid limit defaults and batch validation.
 * @module tests/config/limit-characterization.test
 */
import { describe, expect, it } from 'vitest';
import { inaturalistFindPlaces } from '@/mcp-server/tools/definitions/inaturalist-find-places.tool.js';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { inaturalistResolveName } from '@/mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';

describe('valid limit defaults', () => {
  it('accepts scalar overshoots and up to 100 submitted ids by default', () => {
    expect(inaturalistResolveName.input.safeParse({ q: 'x', limit: 31 }).success).toBe(true);
    expect(inaturalistFindPlaces.input.safeParse({ q: 'x', per_page: 31 }).success).toBe(true);
    expect(
      inaturalistGetObservation.input.safeParse({ observation_id: Array(11).fill(1) }).success,
    ).toBe(true);
  });
  it('keeps defaults, at-cap calls and invalid scalar limits distinct', () => {
    expect(inaturalistResolveName.input.parse({ q: 'x' }).limit).toBe(10);
    expect(inaturalistFindPlaces.input.parse({ q: 'x' }).per_page).toBe(10);
    expect(inaturalistResolveName.input.parse({ q: 'x', limit: 30 }).limit).toBe(30);
    for (const limit of [0, -1, 2.5])
      expect(inaturalistResolveName.input.safeParse({ q: 'x', limit }).success).toBe(false);
    expect(
      inaturalistGetObservation.input.parse({ observation_id: [1, 1] }).observation_id,
    ).toEqual([1, 1]);
  });
});
