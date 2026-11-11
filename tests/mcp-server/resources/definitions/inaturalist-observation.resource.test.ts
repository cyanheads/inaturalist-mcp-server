/**
 * @fileoverview Tests for the inaturalist://observations/{observation_id}
 * resource — the happy path (identifications expanded by default), the
 * 40-entry thread cap with its counts, the observer's description and
 * observation fields, the declared not_found miss with its recovery hint, and the
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
  rawObservationField,
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
  it.each([null, '', '  <b>literal</b> &amp;\r\n\nend\n'])(
    'retains JSON detail states without a Markdown formatter: %j',
    async (description) => {
      const observation = projectedObservation({
        description,
        observation_fields: [],
        observation_fields_total: 0,
        observation_fields_shown: 0,
        photos: [],
        annotations: [],
        sounds: [],
      });
      fake.getObservations.mockResolvedValue({ observations: [observation], unresolved: [] });
      const result = await inaturalistObservationResource.handler(
        { observation_id: '401617560' },
        createMockContext({ errors: inaturalistObservationResource.errors }),
      );
      expect(inaturalistObservationResource.mimeType).toBe('application/json');
      expect(inaturalistObservationResource.format).toBeUndefined();
      expect(inaturalistObservationResource.output?.parse(result)).toEqual(observation);
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        description,
        observation_fields: [],
        observation_fields_total: 0,
        observation_fields_shown: 0,
        photos: [],
        annotations: [],
        sounds: [],
      });
    },
  );

  it('resolves the id with the identifications expansion, always', async () => {
    const observation = projectedObservation();
    fake.getObservations.mockResolvedValue({ observations: [observation], unresolved: [] });
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: inaturalistObservationResource.errors,
    });
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
  it('fails with the declared not_found reason, the id, and the contract recovery', async () => {
    fake.getObservations.mockResolvedValue({ observations: [], unresolved: [999_999_999_999] });
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: inaturalistObservationResource.errors,
    });
    const params = inaturalistObservationResource.params!.parse({
      observation_id: '999999999999',
    });

    await expect(inaturalistObservationResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', observation_id: 999_999_999_999 },
    });
    expect(inaturalistObservationResource.errors).toEqual([
      expect.objectContaining({
        reason: 'not_found',
        code: JsonRpcErrorCode.NotFound,
        recovery: expect.stringContaining('inaturalist_search_observations'),
      }),
    ]);
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
      const ctx = createMockContext({
        tenantId: 'test-tenant',
        errors: inaturalistObservationResource.errors,
      });
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

  it('preserves full nullable observation timestamps through the resource JSON projection', async () => {
    const result = await read(
      rawObservation({ created_at: null, updated_at: '2026-10-31T01:02:03.123456-07:00' }),
    );
    expect(inaturalistObservationResource.output?.parse(result)).toMatchObject({
      created_at: null,
      updated_at: '2026-10-31T01:02:03.123456-07:00',
    });
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      created_at: null,
      updated_at: '2026-10-31T01:02:03.123456-07:00',
    });
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

  it('relays each hidden flag and counts hidden identifications over the whole thread', async () => {
    const { hidden: _omitted, ...unkeyed } = rawIdentification({ id: 3 });
    const result = await read(
      rawObservation({
        id: 5890862,
        identifications: [
          ...Array.from({ length: 45 }, (_, i) =>
            rawIdentification({ id: 100 + i, hidden: i % 10 === 0 }),
          ),
          rawIdentification({ id: 1, hidden: true, body: 'Hidden by a moderator.' }),
          unkeyed,
        ],
      }),
    );

    // Id 140, hidden past the 40-entry cut, still counts; the unkeyed entry does not.
    expect(result).toMatchObject({
      identifications_total: 47,
      identifications_shown: 40,
      identifications_hidden: 6,
    });
    expect(result.identifications?.[0]).toMatchObject({
      id: 1,
      hidden: true,
      body: 'Hidden by a moderator.',
    });
    expect(result.identifications?.[1]).not.toHaveProperty('hidden');
    expect(result.identifications?.[2]).toMatchObject({ id: 100, hidden: true });
    expect(result).not.toHaveProperty('comments_hidden');
    expect(inaturalistObservationResource.output?.parse(result)).toEqual(result);
  });

  it('relays outlinks in upstream order, and omits the field when upstream sent no key', async () => {
    const outlinks = [
      { source: 'GBIF', url: 'http://www.gbif.org/occurrence/2006102216' },
      { source: 'GloBI', url: 'http://www.globalbioticinteractions.org/?a=1&b=2' },
    ];
    const result = await read(rawObservation({ id: 5890862, outlinks }));
    expect(result.outlinks).toEqual(outlinks);
    expect(inaturalistObservationResource.output?.parse(result)).toEqual(result);

    const { outlinks: _omitted, ...withoutKey } = rawObservation({ id: 7 });
    expect(await read(withoutKey)).not.toHaveProperty('outlinks');
  });

  it('keeps the first 40 identifications and fields by ascending id, whatever upstream order', async () => {
    const order = Array.from({ length: 50 }, (_, i) => 1 + ((i * 37) % 50));
    const result = await read(
      rawObservation({
        id: 5890862,
        identifications: order.map((id) => rawIdentification({ id })),
        ofvs: order.map((id) => ({ id, name: `Field ${id}`, value: 'alive' })),
      }),
    );

    const first40 = Array.from({ length: 40 }, (_, i) => i + 1);
    expect(result.identifications?.map((entry) => entry.id)).toEqual(first40);
    expect(result.observation_fields?.map((field) => field.name)).toEqual(
      first40.map((id) => `Field ${id}`),
    );
    expect(result).toMatchObject({ identifications_total: 50, observation_fields_total: 50 });
  });

  it('takes no paging parameter and names the tool that pages the rest', () => {
    expect(Object.keys(inaturalistObservationResource.params?.shape ?? {})).toEqual([
      'observation_id',
    ]);
    expect(inaturalistObservationResource.description).toContain('inaturalist_get_observation');
    expect(inaturalistObservationResource.description).toContain('array_offset');
    expect(inaturalistObservationResource.description).not.toContain('upstream order');
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
          { name: 'Habitat_Description', datatype: 'text', value: 'Garden' },
          { name: 'Blank', datatype: 'text', value: ' ' },
          rawObservationField(),
        ],
      }),
    );

    expect(result.description).toBe('caterpillar on narrow-leaf milkweed');
    expect(result.observation_fields).toEqual([
      { name: 'Habitat_Description', datatype: 'text', value: 'Garden' },
      {
        name: 'Host',
        datatype: 'taxon',
        value: '125625',
        taxon: {
          id: 125625,
          name: 'Miscanthus',
          rank: 'genus',
          common_name: 'Silvergrasses',
          iconic_taxon_name: 'Plantae',
        },
      },
    ]);
    expect(JSON.stringify(result.observation_fields)).not.toContain('matched_term');
    expect(result.observation_fields_total).toBe(2);
    expect(result.observation_fields_shown).toBe(2);
    expect(inaturalistObservationResource.output?.parse(result)).toEqual(result);
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
