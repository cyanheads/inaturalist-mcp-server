/**
 * @fileoverview Tests for inaturalist_get_observation — batch id resolution,
 * the not_found contract when nothing resolves, the per-id unresolved report
 * and its enrichment notice, the default include, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-get-observation.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { projectedObservation } from '../../../helpers/fixtures.js';

vi.mock('@/services/inaturalist/inaturalist-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/inaturalist/inaturalist-service.js')>();
  return { ...actual, getINaturalistService: vi.fn() };
});

const fake = createFakeService();

beforeEach(() => {
  resetFakeService(fake);
  vi.mocked(getINaturalistService).mockReturnValue(asService(fake));
});

describe('batch resolution', () => {
  it('resolves a batch in one call and applies the default include', async () => {
    fake.getObservations.mockResolvedValue({
      observations: [projectedObservation()],
      unresolved: [],
    });
    const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
    const input = inaturalistGetObservation.input.parse({ observation_id: [401617560] });

    const result = await inaturalistGetObservation.handler(input, ctx);

    expect(fake.getObservations).toHaveBeenCalledWith(
      [401617560],
      new Set(['identifications']),
      ctx,
    );
    expect(result).toEqual({ observations: [projectedObservation()], unresolved: [] });
  });

  it('passes a custom include set through as a Set', async () => {
    fake.getObservations.mockResolvedValue({
      observations: [projectedObservation()],
      unresolved: [],
    });
    const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
    const input = inaturalistGetObservation.input.parse({
      observation_id: [401617560],
      include: ['photos', 'comments'],
    });

    await inaturalistGetObservation.handler(input, ctx);

    expect(fake.getObservations).toHaveBeenCalledWith(
      [401617560],
      new Set(['photos', 'comments']),
      ctx,
    );
  });

  it('reports a per-id unresolved list and a notice when part of the batch did not resolve', async () => {
    fake.getObservations.mockResolvedValue({
      observations: [projectedObservation({ id: 1 })],
      unresolved: [2, 999_999_999_999],
    });
    const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
    const input = inaturalistGetObservation.input.parse({
      observation_id: [1, 2, 999_999_999_999],
    });

    const result = await inaturalistGetObservation.handler(input, ctx);

    expect(result.unresolved).toEqual([{ observation_id: 2 }, { observation_id: 999_999_999_999 }]);
    expect(getEnrichment(ctx).notice).toBe(
      '2 of 3 ids returned no observation; they may have been deleted or never existed.',
    );
  });
});

describe('not_found', () => {
  it('throws not_found when none of the requested ids resolved', async () => {
    fake.getObservations.mockResolvedValue({ observations: [], unresolved: [1, 2] });
    const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
    const input = inaturalistGetObservation.input.parse({ observation_id: [1, 2] });

    await expect(inaturalistGetObservation.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});

describe('format()', () => {
  it('renders each resolved observation and omits the unresolved line when nothing is unresolved', () => {
    const result = { observations: [projectedObservation()], unresolved: [] };
    const [block] = inaturalistGetObservation.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('## Monarch (Danaus plexippus)');
    expect(text).not.toContain('**Unresolved ids:**');
  });

  it('renders the unresolved ids as a trailing list when present', () => {
    const result = {
      observations: [projectedObservation()],
      unresolved: [{ observation_id: 2 }, { observation_id: 3 }],
    };
    const [block] = inaturalistGetObservation.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**Unresolved ids:** 2, 3');
  });
});
