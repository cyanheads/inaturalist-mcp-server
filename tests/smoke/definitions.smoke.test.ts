/**
 * @fileoverview Smoke coverage for every tool this server registers: the
 * defaults each input schema applies, and the one handler that answers without
 * an upstream call, run end to end through `format()`.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { inaturalistFindPlaces } from '@/mcp-server/tools/definitions/inaturalist-find-places.tool.js';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { inaturalistListReference } from '@/mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import { inaturalistResolveName } from '@/mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';

describe('definition smoke test', () => {
  it('serves a static vocabulary and renders every entry', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'iconic_taxa' });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(inaturalistListReference.output));
    expect(result.source).toBe('static');
    expect(result.entries).toHaveLength(14);

    const [block] = inaturalistListReference.format?.(result) ?? [];
    expect(block).toMatchObject({ type: 'text' });
    expect(block && 'text' in block ? block.text : '').toContain('`Aves`');
  });

  it('rejects taxon_id on a topic that does not take it', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'ranks', taxon_id: 48662 });

    await expect(inaturalistListReference.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'taxon_id_not_applicable' },
    });
  });

  it('applies the documented defaults on every registered tool', () => {
    expect(inaturalistResolveName.input.parse({ q: 'monarch' })).toMatchObject({
      type: 'taxon',
      limit: 10,
    });
    expect(inaturalistFindPlaces.input.parse({ q: 'Seattle' })).toMatchObject({ per_page: 10 });
    expect(inaturalistSearchObservations.input.parse({ place_id: 1 })).toMatchObject({
      quality_grade: ['research'],
      captive: false,
      order_by: 'observed_on',
      order: 'desc',
      per_page: 10,
    });
    expect(inaturalistGetObservation.input.parse({ observation_id: [401617560] })).toMatchObject({
      include: ['identifications'],
    });
  });
});
