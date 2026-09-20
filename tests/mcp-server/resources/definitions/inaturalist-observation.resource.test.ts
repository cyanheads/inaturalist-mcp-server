/**
 * @fileoverview Tests for the inaturalist://observations/{observation_id}
 * resource — the happy path (identifications expanded by default), the
 * notFound() miss with its recovery hint, and the observation_id path-param
 * schema rejecting a value that is not a positive integer.
 * @module tests/mcp-server/resources/definitions/inaturalist-observation.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistObservationResource } from '@/mcp-server/resources/definitions/inaturalist-observation.resource.js';
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

describe('happy path', () => {
  it('resolves the id with the identifications expansion, always', async () => {
    const observation = projectedObservation();
    fake.getObservations.mockResolvedValue({ observations: [observation], unresolved: [] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = inaturalistObservationResource.params!.parse({
      observation_id: '401617560',
    });

    const result = await inaturalistObservationResource.handler(params, ctx);

    expect(result).toEqual(observation);
    expect(fake.getObservations).toHaveBeenCalledWith(
      [401617560],
      new Set(['identifications']),
      ctx,
    );
  });
});

describe('miss', () => {
  it('throws notFound with a recovery hint pointing at inaturalist_search_observations', async () => {
    fake.getObservations.mockResolvedValue({ observations: [], unresolved: [999_999_999_999] });
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = inaturalistObservationResource.params!.parse({
      observation_id: '999999999999',
    });

    let error: unknown;
    try {
      await inaturalistObservationResource.handler(params, ctx);
    } catch (e) {
      error = e;
    }

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        observation_id: 999_999_999_999,
        recovery: { hint: expect.stringContaining('inaturalist_search_observations') },
      },
    });
  });
});

describe('params schema', () => {
  it('accepts a positive-integer observation_id string', () => {
    expect(() =>
      inaturalistObservationResource.params!.parse({ observation_id: '401617560' }),
    ).not.toThrow();
  });

  it('rejects an observation_id of "0", which is not a positive integer', () => {
    expect(() => inaturalistObservationResource.params!.parse({ observation_id: '0' })).toThrow();
  });

  it('rejects a non-numeric observation_id', () => {
    expect(() =>
      inaturalistObservationResource.params!.parse({ observation_id: 'not-an-id' }),
    ).toThrow();
  });
});
