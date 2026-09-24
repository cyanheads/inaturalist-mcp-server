/**
 * @fileoverview Tests for the inaturalist://observations/{observation_id}
 * resource — the happy path (identifications expanded by default), the
 * 40-entry thread cap with its counts, the observer's description and
 * observation fields, the notFound() miss with its recovery hint, and the
 * observation_id path-param schema rejecting a value that is not a positive
 * integer.
 * @module tests/mcp-server/resources/definitions/inaturalist-observation.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistObservationResource } from '@/mcp-server/resources/definitions/inaturalist-observation.resource.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
import type { RawObservation } from '@/services/inaturalist/types.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import {
  projectedObservation,
  rawIdentification,
  rawObservation,
} from '../../../helpers/fixtures.js';

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

/**
 * A resource read is one record, so its thread keeps the full 40-entry budget.
 * Resources carry no enrichment trailer, so the cut is disclosed through the
 * record's own counts. Runs the real service and projection behind a strict
 * fetch mock.
 */
describe('thread cap and detail fields on a real read', () => {
  async function read(record: RawObservation) {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/\d+$/,
        respond: () => Response.json({ total_results: 1, results: [record] }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const ctx = createMockContext({ tenantId: 'test-tenant' });
      const params = inaturalistObservationResource.params!.parse({
        observation_id: String(record.id),
      });
      return await inaturalistObservationResource.handler(params, ctx);
    } finally {
      http.restore();
    }
  }

  const withThread = (count: number) =>
    rawObservation({
      id: 5890862,
      identifications: Array.from({ length: count }, (_, i) => rawIdentification({ id: i + 1 })),
    });

  it('cuts a thread past 40 to its first 40 entries and reports the upstream total', async () => {
    const result = await read(withThread(1113));

    expect(result.identifications?.map((entry) => entry.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    expect(result.identifications_total).toBe(1113);
    expect(result.identifications_shown).toBe(40);
    expect(result).not.toHaveProperty('comments_total');
    expect(inaturalistObservationResource.output?.parse(result)).toEqual(result);
  });

  it('keeps a thread of exactly 40 whole', async () => {
    const result = await read(withThread(40));

    expect(result.identifications).toHaveLength(40);
    expect(result.identifications_total).toBe(40);
    expect(result.identifications_shown).toBe(40);
  });

  it("carries the observer's description and filled observation fields", async () => {
    const result = await read(
      rawObservation({
        id: 402402822,
        description: 'caterpillar on narrow-leaf milkweed',
        ofvs: [
          { name: 'Habitat_Description', value: 'Garden' },
          { name: 'Blank', value: ' ' },
        ],
      }),
    );

    expect(result.description).toBe('caterpillar on narrow-leaf milkweed');
    expect(result.observation_fields).toEqual([{ name: 'Habitat_Description', value: 'Garden' }]);
    expect(result.observation_fields_total).toBe(1);
    expect(result.observation_fields_shown).toBe(1);
  });

  it('cuts filled observation fields past 40 to the first 40 and reports the filled total', async () => {
    const result = await read(
      rawObservation({
        id: 5890862,
        ofvs: [
          { name: 'Blank', value: '' },
          ...Array.from({ length: 906 }, (_, i) => ({ name: `Field ${i}`, value: 'alive' })),
        ],
      }),
    );

    expect(result.observation_fields?.map((field) => field.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `Field ${i}`),
    );
    expect(result.observation_fields_total).toBe(906);
    expect(result.observation_fields_shown).toBe(40);
    expect(inaturalistObservationResource.output?.parse(result)).toEqual(result);
  });
});
