/**
 * @fileoverview Tests for inaturalist_get_observation — batch id resolution,
 * the not_found contract when nothing resolves, the per-id unresolved report
 * and its enrichment notice, the default include, format(), the batch-shared
 * identification/comment cap with its per-record counts and cut notice, and
 * the observer's description and observation fields, on both surfaces.
 * @module tests/mcp-server/tools/definitions/inaturalist-get-observation.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
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
  rawComment,
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

describe('batch resolution', () => {
  it('accepts eleven copies of one id without deferred work and records the oversubmission', async () => {
    fake.getObservations.mockResolvedValue({
      observations: [projectedObservation({ id: 1 })],
      unresolved: [],
    });
    const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
    const log = vi.spyOn(ctx.log, 'info');
    const result = await inaturalistGetObservation.handler(
      inaturalistGetObservation.input.parse({ observation_id: Array(11).fill(1) }),
      ctx,
    );
    expect(result.deferred).toEqual([]);
    expect(fake.getObservations).toHaveBeenCalledWith([1], new Set(['identifications']), ctx, {
      arrayOffset: 0,
      arrayLimit: 40,
    });
    expect(log.mock.calls.filter(([message]) => message === 'Read limit clamped')).toHaveLength(1);
  });
  it('retains deferred work when every attempted id is missing', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    fake.getObservations.mockResolvedValue({ observations: [], unresolved: ids.slice(0, 10) });
    const result = await runToolContract(inaturalistGetObservation, { observation_id: ids });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [],
      unresolved: ids.slice(0, 10).map((observation_id) => ({ observation_id })),
      deferred: [{ observation_id: 11 }, { observation_id: 12 }],
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Deferred ids:** 11, 12');
    expect(text).toContain('10 of 10 ids returned no observation');
    expect(text).toContain('same include (identifications)');
  });
  it('rejects 101 submitted ids and empty batches before requesting', async () => {
    for (const observation_id of [[], Array(101).fill(1)]) {
      const result = await runToolContract(inaturalistGetObservation, { observation_id });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_arguments' } },
      });
    }
    expect(fake.getObservations).not.toHaveBeenCalled();
  });
  it('defers distinct ids after ten while accepting repeated submitted ids', async () => {
    fake.getObservations.mockResolvedValue({
      observations: [projectedObservation({ id: 1 })],
      unresolved: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const result = await runToolContract(inaturalistGetObservation, {
      observation_id: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11],
      include: ['comments'],
    });
    expect(result.isError).toBeFalsy();
    expect(fake.getObservations).toHaveBeenCalledWith(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      new Set(['comments']),
      expect.anything(),
      { arrayOffset: 0, arrayLimit: 40 },
    );
    expect(result.structuredContent).toMatchObject({
      deferred: [{ observation_id: 11 }, { observation_id: 12 }],
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Deferred ids:** 11, 12');
    expect(text).toContain('same include');
  });
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
      { arrayOffset: 0, arrayLimit: 40 },
    );
    expect(result).toEqual({
      observations: [projectedObservation()],
      unresolved: [],
      deferred: [],
      array_offset: 0,
      next_array_offset: null,
    });
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
      { arrayOffset: 0, arrayLimit: 40 },
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
  it('returns not_found recovery on both surfaces when no deferred work remains', async () => {
    fake.getObservations.mockResolvedValue({ observations: [], unresolved: [1] });
    const result = await runToolContract(inaturalistGetObservation, { observation_id: [1] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'not_found',
          recovery: { hint: expect.stringContaining('inaturalist_search_observations') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('inaturalist_search_observations');
  });
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
    const result = {
      observations: [projectedObservation()],
      unresolved: [],
      deferred: [],
      array_offset: 0,
      next_array_offset: null,
    };
    const [block] = inaturalistGetObservation.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('## Monarch (Danaus plexippus)');
    expect(text).not.toContain('**Unresolved ids:**');
  });

  it('renders the unresolved ids as a trailing list when present', () => {
    const result = {
      observations: [projectedObservation()],
      unresolved: [{ observation_id: 2 }, { observation_id: 3 }],
      deferred: [],
      array_offset: 0,
      next_array_offset: null,
    };
    const [block] = inaturalistGetObservation.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**Unresolved ids:** 2, 3');
  });
});

/**
 * The thread cap runs on the real service and projection, behind a strict fetch
 * mock that answers `/observations/{ids}` with the raw records given — so these
 * exercise the slice, the counts, and the notice the tool actually ships.
 */
describe('the batch-shared thread cap, on both surfaces', () => {
  /** A raw record whose thread arrays hold `identifications` and `comments` entries. */
  function threaded(id: number, identifications: number, comments = 0): RawObservation {
    return rawObservation({
      id,
      uri: `https://www.inaturalist.org/observations/${id}`,
      identifications: Array.from({ length: identifications }, (_, i) =>
        rawIdentification({ id: id * 10_000 + i }),
      ),
      comments: Array.from({ length: comments }, (_, i) => rawComment({ id: id * 10_000 + i })),
    });
  }

  function upstreamServing(records: RawObservation[]) {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/[\d,]+$/,
        respond: () => Response.json({ total_results: records.length, results: records }),
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
    return http;
  }

  type Wire = Awaited<ReturnType<typeof runToolContract>>;
  type WireRecord = {
    id: number;
    identifications?: { id: number }[];
    identifications_total?: number;
    identifications_shown?: number;
    comments?: { id: number }[];
    comments_total?: number;
    comments_shown?: number;
    observation_fields_total?: number;
    observation_fields_shown?: number;
  };
  const structured = (result: Wire) =>
    result.structuredContent as { observations: WireRecord[]; notice?: string };
  const textOf = (result: Wire) =>
    (result.content ?? []).map((block) => ('text' in block ? block.text : '')).join('\n');

  async function call(
    records: RawObservation[],
    input: Parameters<typeof runToolContract<typeof inaturalistGetObservation>>[1],
  ) {
    const http = upstreamServing(records);
    http.install();
    try {
      return await runToolContract(inaturalistGetObservation, input);
    } finally {
      http.restore();
    }
  }

  it('composes missing, thread-cut and deferred notices using the resolved record budget', async () => {
    const result = await call([threaded(1, 41)], {
      observation_id: Array.from({ length: 12 }, (_, index) => index + 1),
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result).observations[0]).toMatchObject({
      identifications_total: 41,
      identifications_shown: 40,
    });
    const notice = structured(result).notice ?? '';
    expect(notice).toContain('9 of 10 ids returned no observation');
    expect(notice).toContain('entries 1–40 of each, by ascending id');
    expect(notice).toContain('2 distinct ids were deferred');
    expect(textOf(result)).toContain(notice);
    expect(textOf(result)).toContain('**Deferred ids:** 11, 12');
  });

  it('returns an upstream array out of id order sorted by ascending id on both surfaces', async () => {
    const record = rawObservation({
      id: 1,
      identifications: [30, 10, 20].map((id) => rawIdentification({ id })),
      comments: [300, 100, 200].map((id) => rawComment({ id })),
      ofvs: [
        { id: 3000, name: 'Third', datatype: 'text', value: 'c' },
        { id: 1000, name: 'First', datatype: 'text', value: 'a' },
        { id: 2000, name: 'Second', datatype: 'text', value: 'b' },
      ],
    });
    const result = await call([record], {
      observation_id: [1],
      include: ['identifications', 'comments'],
    });

    const [wire] = structured(result).observations as (WireRecord & {
      observation_fields?: { name: string }[];
    })[];
    expect(wire?.identifications?.map((entry) => entry.id)).toEqual([10, 20, 30]);
    expect(wire?.comments?.map((entry) => entry.id)).toEqual([100, 200, 300]);
    expect(wire?.observation_fields?.map((field) => field.name)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    const text = textOf(result);
    const order = (pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);
    expect(order(/ · id (\d+) · 2026-06-01T12/g)).toEqual(['10', '20', '30']);
    expect(order(/· id (\d+) · 2026-06-01T13/g)).toEqual(['100', '200', '300']);
    expect(order(/^- \*\*(First|Second|Third)\*\* \(text\): /gm)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('keeps a single record exactly at the cap whole, with no notice', async () => {
    const result = await call([threaded(1, 40, 40)], {
      observation_id: [1],
      include: ['identifications', 'comments'],
    });

    expect(result.isError).toBeFalsy();
    const [record] = structured(result).observations;
    expect(record?.identifications).toHaveLength(40);
    expect(record).toMatchObject({
      identifications_total: 40,
      identifications_shown: 40,
      comments_total: 40,
      comments_shown: 40,
    });
    expect(structured(result).notice).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ next_array_offset: null, truncated: false });
    expect(textOf(result)).toContain('### Identification thread — 40 of 40 shown');
    expect(textOf(result)).toContain('### Comments — 40 of 40 shown');
  });

  it('cuts a single record one past the cap to its first 40 entries, and says so on both surfaces', async () => {
    const result = await call([threaded(1, 41, 41)], {
      observation_id: [1],
      include: ['identifications', 'comments'],
    });

    const [record] = structured(result).observations;
    expect(record?.identifications?.map((entry) => entry.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => 10_000 + i),
    );
    expect(record).toMatchObject({
      identifications_total: 41,
      identifications_shown: 40,
      comments_total: 41,
      comments_shown: 40,
    });
    expect(result.structuredContent).toMatchObject({
      array_offset: 0,
      next_array_offset: 40,
      truncated: true,
    });
    const notice =
      'Arrays cut to entries 1–40 of each, by ascending id: observation 1 — identifications 40 of 41, comments 40 of 41. Pass array_offset 40 (next_array_offset) with the same include for the next entries, or raise array_limit (ceiling 1500) for more per call.';
    expect(structured(result).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain(
      '### Identification thread — 40 of 41 shown: entries 1–40 by ascending id',
    );
    expect(text).toContain('### Comments — 40 of 41 shown: entries 1–40 by ascending id');
    expect(text).toContain('**Array page:** array_offset 0 · next_array_offset 40');
    expect(text).toContain(notice);
    expect(text).not.toContain('upstream order');
  });

  it('splits the budget across a batch of two — 20 entries per array per record', async () => {
    const result = await call([threaded(1, 21), threaded(2, 20)], {
      observation_id: [1, 2],
    });

    const [first, second] = structured(result).observations;
    expect(first).toMatchObject({ identifications_total: 21, identifications_shown: 20 });
    expect(first?.identifications).toHaveLength(20);
    expect(second).toMatchObject({ identifications_total: 20, identifications_shown: 20 });
    expect(structured(result).notice).toBe(
      'Arrays cut to entries 1–20 of each, by ascending id, sharing array_limit 40 across 2 records: observation 1 — identifications 20 of 21. Pass array_offset 20 (next_array_offset) with the same observation_id and include for the next entries, or raise array_limit (ceiling 1500) for more per record.',
    );
  });

  it('keeps 4 entries per array on each record of a batch of ten, naming every cut id', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const result = await call(
      ids.map((id) => threaded(id, 5, 5)),
      { observation_id: ids, include: ['identifications', 'comments'] },
    );

    const records = structured(result).observations;
    expect(records).toHaveLength(10);
    for (const record of records) {
      expect(record.identifications).toHaveLength(4);
      expect(record.comments).toHaveLength(4);
      expect(record).toMatchObject({
        identifications_total: 5,
        identifications_shown: 4,
        comments_total: 5,
        comments_shown: 4,
      });
    }
    const notice = structured(result).notice ?? '';
    expect(notice).toContain('entries 1–4 of each, by ascending id');
    expect(notice).toContain('across 10 records');
    for (const id of ids) {
      expect(notice).toContain(`observation ${id} — identifications 4 of 5, comments 4 of 5`);
    }
    expect(result.structuredContent).toMatchObject({ next_array_offset: 4 });
  });

  it('reports zero counts for a record with no identifications, and stays silent', async () => {
    const result = await call([threaded(1, 0)], { observation_id: [1] });

    const [record] = structured(result).observations;
    expect(record).toMatchObject({
      identifications: [],
      identifications_total: 0,
      identifications_shown: 0,
    });
    expect(structured(result).notice).toBeUndefined();
    expect(textOf(result)).toContain('### Identification thread — 0 of 0 shown');
  });

  it('carries no thread counts when neither thread arm was included', async () => {
    const result = await call([threaded(1, 50, 50)], {
      observation_id: [1],
      include: ['photos'],
    });

    const [record] = structured(result).observations;
    expect(record).not.toHaveProperty('identifications');
    expect(record).not.toHaveProperty('identifications_total');
    expect(record).not.toHaveProperty('identifications_shown');
    expect(record).not.toHaveProperty('comments_total');
    expect(record).not.toHaveProperty('comments_shown');
    expect(structured(result).notice).toBeUndefined();
  });

  it('writes one notice carrying both the unresolved ids and the cut', async () => {
    // Two ids asked for, one resolved: the budget is shared by records returned,
    // so the one record keeps the full 40.
    const result = await call([threaded(1, 45)], { observation_id: [1, 2] });

    expect(structured(result).observations[0]).toMatchObject({
      identifications_total: 45,
      identifications_shown: 40,
    });
    const notice =
      '1 of 2 ids returned no observation; they may have been deleted or never existed. Arrays cut to entries 1–40 of each, by ascending id: observation 1 — identifications 40 of 45. Pass array_offset 40 (next_array_offset) with the same include for the next entries, or raise array_limit (ceiling 1500) for more per call.';
    expect(structured(result).notice).toBe(notice);
    expect(textOf(result)).toContain(notice);
  });

  it('shares the budget by distinct records when upstream repeats a record asked for twice', async () => {
    // Upstream answers `/observations/1,1` with the record twice; the reply
    // carries it once, so it keeps the single-record 40, not 40 ÷ 2.
    const record = threaded(1, 41);
    const result = await call([record, record], { observation_id: [1, 1] });

    const records = structured(result).observations;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ identifications_total: 41, identifications_shown: 40 });
    expect(structured(result).notice).toBe(
      'Arrays cut to entries 1–40 of each, by ascending id: observation 1 — identifications 40 of 41. Pass array_offset 40 (next_array_offset) with the same include for the next entries, or raise array_limit (ceiling 1500) for more per call.',
    );
  });

  it('keeps the notice cap equal to what each record kept when a batch repeats an id', async () => {
    const first = threaded(1, 25);
    const result = await call([first, first, threaded(2, 25)], { observation_id: [1, 2, 1] });

    const records = structured(result).observations;
    expect(records.map((entry) => entry.id)).toEqual([1, 2]);
    for (const entry of records) expect(entry.identifications_shown).toBe(20);
    expect(structured(result).notice).toContain(
      'entries 1–20 of each, by ascending id, sharing array_limit 40 across 2 records',
    );
  });

  it('states the shared cap on the include field', () => {
    const described = inaturalistGetObservation.input.shape.include.description ?? '';
    expect(described).toContain('40');
    expect(described).toContain('identifications_total');
  });

  it('keeps only the unresolved notice when nothing was cut', async () => {
    const result = await call([threaded(1, 2)], { observation_id: [1, 2] });

    expect(structured(result).notice).toBe(
      '1 of 2 ids returned no observation; they may have been deleted or never existed.',
    );
  });

  it("relays the observer's description and filled observation fields on both surfaces", async () => {
    const record = rawObservation({
      id: 402402822,
      description: 'caterpillar on narrow-leaf milkweed along fisherman’s access rd',
      ofvs: [
        { name: 'Habitat_Description', datatype: 'text', value: 'Garden' },
        { name: 'Empty', datatype: 'text', value: '' },
      ],
    });
    const result = await call([record], { observation_id: [402402822] });

    expect(structured(result).observations[0]).toMatchObject({
      description: 'caterpillar on narrow-leaf milkweed along fisherman’s access rd',
      observation_fields: [{ name: 'Habitat_Description', datatype: 'text', value: 'Garden' }],
    });
    const text = textOf(result);
    expect(text).toContain(
      '**Observer’s description:**\n> caterpillar on narrow-leaf milkweed along fisherman’s access rd',
    );
    expect(text).toContain(
      '### Observation fields — 1 of 1 shown\n- **Habitat_Description** (text): Garden',
    );
    expect(text).not.toContain('**Empty**');
  });

  it('relays outlinks on the by-id record on both surfaces, and none for an empty array', async () => {
    const result = await call(
      [
        rawObservation({
          id: 340896736,
          outlinks: [{ source: 'GBIF', url: 'http://www.gbif.org/occurrence/6518604665' }],
        }),
        rawObservation({ id: 412088410, outlinks: [] }),
      ],
      { observation_id: [340896736, 412088410] },
    );

    const [linked, empty] = (
      result.structuredContent as {
        observations: { outlinks?: unknown }[];
      }
    ).observations;
    expect(linked?.outlinks).toEqual([
      { source: 'GBIF', url: 'http://www.gbif.org/occurrence/6518604665' },
    ]);
    expect(empty?.outlinks).toEqual([]);
    const text = textOf(result);
    expect(text).toContain('**Outlinks:** [GBIF](<http://www.gbif.org/occurrence/6518604665>)\n');
    expect(text).toContain('**Outlinks:** none\n');
  });

  it('carries datatype and the five-field taxon of a taxon-type field on both surfaces', async () => {
    const record = rawObservation({
      id: 412088410,
      ofvs: [
        rawObservationField(),
        rawObservationField({
          id: 43288313,
          name: 'Species',
          value: 'Ondatra zibethicus',
          taxon: null,
        }),
      ],
    });
    const result = await call([record], { observation_id: [412088410] });

    const [wire] = (
      result.structuredContent as {
        observations: { observation_fields?: Record<string, unknown>[] }[];
      }
    ).observations;
    expect(wire?.observation_fields).toEqual([
      {
        name: 'Host',
        value: '125625',
        datatype: 'taxon',
        taxon: {
          id: 125625,
          name: 'Miscanthus',
          rank: 'genus',
          common_name: 'Silvergrasses',
          iconic_taxon_name: 'Plantae',
        },
      },
      { name: 'Species', value: 'Ondatra zibethicus', datatype: 'taxon' },
    ]);
    const text = textOf(result);
    expect(text).toContain(
      '- **Host** (taxon): 125625 — Silvergrasses (Miscanthus) · taxon_id 125625 · genus · Plantae',
    );
    expect(text).toContain('- **Species** (taxon): Ondatra zibethicus\n');
    // Raw-only keys of the upstream taxon reach neither surface.
    for (const rawOnly of ['987654', 'raw-only matched term', 'observations_count', 'rank_level']) {
      expect(JSON.stringify(wire)).not.toContain(rawOnly);
    }
    expect(text).not.toContain('987654');
    expect(text).not.toContain('raw-only matched term');
  });

  /** A raw record carrying `filled` non-blank observation fields, then `blank` empty ones. */
  function withFields(id: number, filled: number, blank = 0): RawObservation {
    return rawObservation({
      id,
      uri: `https://www.inaturalist.org/observations/${id}`,
      ofvs: [
        ...Array.from({ length: filled }, (_, i) => ({ name: `Field ${i}`, value: `v${i}` })),
        ...Array.from({ length: blank }, (_, i) => ({ name: `Blank ${i}`, value: ' ' })),
      ],
    });
  }

  it('keeps a single record with exactly 40 filled fields whole, counts shown, no notice', async () => {
    const result = await call([withFields(1, 40)], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({
      observation_fields_total: 40,
      observation_fields_shown: 40,
    });
    expect(structured(result).notice).toBeUndefined();
    expect(textOf(result)).toContain('### Observation fields — 40 of 40 shown');
  });

  it('cuts observation fields one past the cap to the first 40 by ascending id, and names the cut', async () => {
    const result = await call([withFields(1, 41)], { observation_id: [1] });

    const record = structured(result).observations[0] as WireRecord & {
      observation_fields?: { name: string }[];
    };
    expect(record.observation_fields?.map((field) => field.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `Field ${i}`),
    );
    expect(record).toMatchObject({ observation_fields_total: 41, observation_fields_shown: 40 });
    const notice =
      'Arrays cut to entries 1–40 of each, by ascending id: observation 1 — observation_fields 40 of 41. Pass array_offset 40 (next_array_offset) with the same include for the next entries, or raise array_limit (ceiling 1500) for more per call.';
    expect(structured(result).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain('### Observation fields — 40 of 41 shown: entries 1–40 by ascending id');
    expect(text).toContain(notice);
  });

  it('counts only filled fields toward the cap — blanks are dropped first', async () => {
    const result = await call([withFields(1, 40, 10)], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({
      observation_fields_total: 40,
      observation_fields_shown: 40,
    });
    expect(structured(result).notice).toBeUndefined();
  });

  it('names observation fields beside the thread arms when a batch of ten cuts all three', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const records = ids.map((id) => ({
      ...threaded(id, 5, 5),
      ofvs: Array.from({ length: 5 }, (_, i) => ({ name: `Field ${i}`, value: 'x' })),
    }));
    const result = await call(records, {
      observation_id: ids,
      include: ['identifications', 'comments'],
    });

    for (const record of structured(result).observations) {
      expect(record).toMatchObject({ observation_fields_total: 5, observation_fields_shown: 4 });
    }
    const notice = structured(result).notice ?? '';
    for (const id of ids) {
      expect(notice).toContain(
        `observation ${id} — observation_fields 4 of 5, identifications 4 of 5, comments 4 of 5`,
      );
    }
  });

  it('reports zero-field counts and an empty heading on a record that has none', async () => {
    const result = await call([withFields(1, 0, 3)], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({
      observation_fields: [],
      observation_fields_total: 0,
      observation_fields_shown: 0,
    });
    expect(textOf(result)).toContain('### Observation fields — 0 of 0 shown');
  });

  it('leaves the description whole however long it is', async () => {
    const description = 'milkweed '.repeat(2_000).trim();
    const result = await call([rawObservation({ id: 1, description })], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({ description });
  });

  /**
   * `array_offset` and `array_limit` on the real service and projection. Each
   * array is served in a scrambled upstream order — a stride permutation of its
   * ids — so every page proves the sort as well as the slice.
   */
  describe('array_offset and array_limit', () => {
    type PagedRecord = WireRecord & {
      observation_fields?: { name: string }[];
      observation_fields_total?: number;
    };
    type PagedWire = {
      observations: PagedRecord[];
      array_offset: number;
      next_array_offset: number | null;
      notice?: string;
    };
    const paged = (result: Wire) => result.structuredContent as PagedWire;

    /** `count` ids from `base`, in a stride order no two neighbours of which ascend by one. */
    const scrambled = (base: number, count: number) =>
      Array.from({ length: count }, (_, i) => base + ((i * 37) % count));

    function long(id: number, sizes: { ids: number; comments?: number; fields?: number }) {
      return rawObservation({
        id,
        uri: `https://www.inaturalist.org/observations/${id}`,
        identifications: scrambled(id * 100_000, sizes.ids).map((entry) =>
          rawIdentification({ id: entry }),
        ),
        comments: scrambled(id * 100_000, sizes.comments ?? 0).map((entry) =>
          rawComment({ id: entry }),
        ),
        ofvs: scrambled(id * 100_000, sizes.fields ?? 0).map((entry) => ({
          id: entry,
          name: `f${entry}`,
          value: 'x',
        })),
      });
    }

    /** Well past the longest walk below, so a walk that never ends fails instead of hanging. */
    const MAX_WALK_PAGES = 10;
    const both = ['identifications', 'comments'] as ('identifications' | 'comments')[];
    const ids = (entries: { id: number }[] | undefined) => (entries ?? []).map((entry) => entry.id);
    const range = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => from + i);

    it('pages entries 41–80 of every array at array_offset 40, with next_array_offset 80', async () => {
      const result = await call([long(1, { ids: 1139, comments: 1393, fields: 923 })], {
        observation_id: [1],
        include: both,
        array_offset: 40,
      });

      const wire = paged(result);
      const [record] = wire.observations;
      expect(ids(record?.identifications)).toEqual(range(100_040, 40));
      expect(ids(record?.comments)).toEqual(range(100_040, 40));
      expect(record?.observation_fields?.map((field) => field.name)).toEqual(
        range(100_040, 40).map((entry) => `f${entry}`),
      );
      expect(record).toMatchObject({
        identifications_total: 1139,
        identifications_shown: 40,
        comments_total: 1393,
        observation_fields_total: 923,
      });
      expect(wire).toMatchObject({ array_offset: 40, next_array_offset: 80 });
      expect(wire.notice).toBe(
        'Arrays cut to entries 41–80 of each, by ascending id: observation 1 — observation_fields 40 of 923, identifications 40 of 1139, comments 40 of 1393. Pass array_offset 80 (next_array_offset) with the same include for the next entries, or raise array_limit (ceiling 1500) for more per call.',
      );
      const text = textOf(result);
      expect(text).toContain(
        '### Identification thread — 40 of 1139 shown: entries 41–80 by ascending id',
      );
      expect(text).toContain('### Comments — 40 of 1393 shown: entries 41–80 by ascending id');
      expect(text).toContain(
        '### Observation fields — 40 of 923 shown: entries 41–80 by ascending id',
      );
      expect(text).toContain('**Array page:** array_offset 40 · next_array_offset 80');
    });

    it('returns the newest 40 identifications at array_offset identifications_total − 40', async () => {
      const result = await call([long(1, { ids: 1139, comments: 5 })], {
        observation_id: [1],
        include: ['identifications'],
        array_offset: 1099,
      });

      const wire = paged(result);
      expect(ids(wire.observations[0]?.identifications)).toEqual(range(101_099, 40));
      expect(wire.next_array_offset).toBeNull();
      expect(wire.notice).toBeUndefined();
      expect(textOf(result)).toContain(
        '### Identification thread — 40 of 1139 shown: entries 1100–1139 by ascending id',
      );
      expect(textOf(result)).toContain(
        '**Array page:** array_offset 1099 · next_array_offset null — no capped array continues past this page',
      );
      const described = inaturalistGetObservation.input.shape.array_offset.description ?? '';
      expect(described).toContain('identifications_total minus array_limit');
    });

    it('returns every array whole at array_limit 1500, with next_array_offset null', async () => {
      const result = await call([long(1, { ids: 1139, comments: 1393, fields: 923 })], {
        observation_id: [1],
        include: both,
        array_limit: 1500,
      });

      const wire = paged(result);
      const [record] = wire.observations;
      expect(ids(record?.identifications)).toEqual(range(100_000, 1139));
      expect(ids(record?.comments)).toEqual(range(100_000, 1393));
      expect(record?.observation_fields).toHaveLength(923);
      expect(wire.next_array_offset).toBeNull();
      expect(wire.notice).toBeUndefined();
      expect(textOf(result)).toContain('### Comments — 1393 of 1393 shown');
    });

    it('clamps array_limit 1501 to 1500, logging it and joining the notice to every other one', async () => {
      const http = upstreamServing([long(1, { ids: 1501 })]);
      http.install();
      try {
        const ctx = createMockContext({ errors: inaturalistGetObservation.errors });
        const log = vi.spyOn(ctx.log, 'info');
        const result = await inaturalistGetObservation.handler(
          inaturalistGetObservation.input.parse({ observation_id: [1, 2], array_limit: 1501 }),
          ctx,
        );

        expect(result.observations[0]?.identifications).toHaveLength(1500);
        expect(result.next_array_offset).toBe(1500);
        expect(log).toHaveBeenCalledWith('Read limit clamped', {
          tool: 'inaturalist_get_observation',
          field: 'array_limit',
          requested: 1501,
          applied: 1500,
        });
        expect(getEnrichment(ctx).notice).toBe(
          'array_limit 1501 was clamped to 1500. 1 of 2 ids returned no observation; they may have been deleted or never existed. Arrays cut to entries 1–1500 of each, by ascending id: observation 1 — identifications 1500 of 1501. Pass array_offset 1500 (next_array_offset) with the same include for the next entries.',
        );
      } finally {
        http.restore();
      }
    });

    it('joins the clamp, unresolved, cut and deferred notices in order on both surfaces', async () => {
      const result = await call([long(1, { ids: 1501 })], {
        observation_id: range(1, 12),
        array_limit: 1501,
      });

      expect(result.isError).toBeFalsy();
      const notice =
        'array_limit 1501 was clamped to 1500. 9 of 10 ids returned no observation; they may have been deleted or never existed. Arrays cut to entries 1–1500 of each, by ascending id: observation 1 — identifications 1500 of 1501. Pass array_offset 1500 (next_array_offset) with the same include for the next entries. 2 distinct ids were deferred. Call inaturalist_get_observation with the deferred ids and the same include (identifications).';
      expect(paged(result).notice).toBe(notice);
      expect(textOf(result)).toContain(notice);
    });

    it.each([
      [{}, 4],
      [{ array_limit: 100 }, 10],
      [{ array_limit: 20 }, 4],
    ])('keeps a ten-record share per array at %j: %i', async (limits, share) => {
      const batch = range(1, 10);
      const result = await call(
        batch.map((id) => long(id, { ids: 12, comments: 12, fields: 12 })),
        { observation_id: batch, include: both, ...limits },
      );

      const wire = paged(result);
      for (const record of wire.observations) {
        expect(ids(record.identifications)).toEqual(range(record.id * 100_000, share));
        expect(ids(record.comments)).toEqual(range(record.id * 100_000, share));
        expect(record.observation_fields).toHaveLength(share);
      }
      expect(wire.next_array_offset).toBe(share);
      // Whole-line match: a substring check would accept "next_array_offset 40" for 4.
      expect(textOf(result).split('\n')).toContain(
        `**Array page:** array_offset 0 · next_array_offset ${share}`,
      );
    });

    it('keeps 2 entries per array on one record at array_limit 2', async () => {
      const result = await call([long(1, { ids: 5 })], { observation_id: [1], array_limit: 2 });

      expect(ids(paged(result).observations[0]?.identifications)).toEqual([100_000, 100_001]);
      expect(paged(result).next_array_offset).toBe(2);
      expect(textOf(result).split('\n')).toContain(
        '**Array page:** array_offset 0 · next_array_offset 2',
      );
    });

    it('returns empty arrays with unchanged totals and no continuation past every array', async () => {
      const result = await call([long(1, { ids: 30, comments: 12, fields: 3 })], {
        observation_id: [1],
        include: both,
        array_offset: 30,
      });

      expect(result.isError).toBeFalsy();
      const wire = paged(result);
      expect(wire.observations[0]).toMatchObject({
        identifications: [],
        identifications_total: 30,
        identifications_shown: 0,
        comments: [],
        comments_total: 12,
        comments_shown: 0,
        observation_fields: [],
        observation_fields_total: 3,
        observation_fields_shown: 0,
      });
      expect(wire.next_array_offset).toBeNull();
      expect(wire.notice).toBeUndefined();
      expect(textOf(result)).toContain(
        '### Identification thread — 0 of 30 shown, array_offset 30 is past the last entry',
      );
    });

    it('rejects a negative array_offset and a zero array_limit before requesting', async () => {
      for (const input of [
        { observation_id: [1], array_offset: -1 },
        { observation_id: [1], array_limit: 0 },
      ]) {
        const result = await runToolContract(inaturalistGetObservation, input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'invalid_arguments' } },
        });
      }
      expect(fake.getObservations).not.toHaveBeenCalled();
    });

    /**
     * Walks next_array_offset to its end across records of different sizes and
     * stitches the pages back together: every array must come out exactly as one
     * array_limit 1500 read returns it, with totals identical on every page.
     */
    it('walks every array of every record to its end with no entry repeated or skipped', async () => {
      const records = [
        long(1, { ids: 9, comments: 5, fields: 7 }),
        long(2, { ids: 3, comments: 13 }),
        long(3, { ids: 0, comments: 1, fields: 2 }),
      ];
      const input = { observation_id: [1, 2, 3], include: both, array_limit: 6 };
      const whole = paged(await call(records, { ...input, array_limit: 1500 })).observations;

      const stitched = new Map<number, PagedRecord>();
      const offsets: number[] = [];
      let offset: number | null = 0;
      /**
       * Bounded: every await here settles on microtasks, so an unbounded walk
       * that never ends starves vitest's timeout timer and hangs the run.
       */
      for (let pages = 0; offset !== null && pages < MAX_WALK_PAGES; pages += 1) {
        offsets.push(offset);
        const wire = paged(await call(records, { ...input, array_offset: offset }));
        for (const record of wire.observations) {
          const seen = stitched.get(record.id);
          const target = whole.find((entry) => entry.id === record.id);
          expect(record.identifications_total).toBe(target?.identifications_total);
          expect(record.comments_total).toBe(target?.comments_total);
          expect(record.observation_fields_total).toBe(target?.observation_fields_total);
          stitched.set(record.id, {
            ...record,
            identifications: [...(seen?.identifications ?? []), ...(record.identifications ?? [])],
            comments: [...(seen?.comments ?? []), ...(record.comments ?? [])],
            observation_fields: [
              ...(seen?.observation_fields ?? []),
              ...(record.observation_fields ?? []),
            ],
          });
        }
        offset = wire.next_array_offset;
      }

      expect(offset).toBeNull();
      expect(offsets).toEqual([0, 4, 8, 12]);
      for (const target of whole) {
        const got = stitched.get(target.id);
        expect(got?.identifications).toEqual(target.identifications);
        expect(got?.comments).toEqual(target.comments);
        expect(got?.observation_fields).toEqual(target.observation_fields);
      }
    });

    /**
     * Hidden entries stay in the arrays at their sorted place, and the hidden
     * counts are taken over the whole upstream array before the page cut, so
     * every page of the walk reports the same counts on both surfaces.
     */
    it('reports the same hidden counts on every page of a walk, with hidden entries in place', async () => {
      const hiddenIdentifications = new Set([100_001, 100_004, 100_009]);
      const record = long(1, { ids: 11, comments: 6 });
      record.identifications = (record.identifications ?? []).map((entry) => ({
        ...entry,
        hidden: hiddenIdentifications.has(entry.id ?? 0),
      }));
      record.comments = (record.comments ?? []).map((entry) => ({
        ...entry,
        hidden: entry.id === 100_005,
        body: entry.id === 100_005 ? 'Hidden but relayed.' : 'Shown.',
      }));
      const input = { observation_id: [1], include: both, array_limit: 4 };

      const stitched: { id: number; hidden?: boolean }[] = [];
      const offsets: number[] = [];
      let offset: number | null = 0;
      for (let pages = 0; offset !== null && pages < MAX_WALK_PAGES; pages += 1) {
        offsets.push(offset);
        const result = await call([record], { ...input, array_offset: offset });
        const [wire] = (
          result.structuredContent as {
            observations: (WireRecord & {
              identifications_hidden?: number;
              comments_hidden?: number;
              identifications?: { id: number; hidden?: boolean }[];
              comments?: { id: number; hidden?: boolean; body: string | null }[];
            })[];
          }
        ).observations;
        expect(wire).toMatchObject({
          identifications_total: 11,
          identifications_hidden: 3,
          comments_total: 6,
          comments_hidden: 1,
        });
        const text = textOf(result);
        expect(text).toContain(
          '**identifications_hidden:** 3 — hidden entries across the whole thread, the same on every page',
        );
        expect(text).toContain(
          '**comments_hidden:** 1 — hidden entries across all comments, the same on every page',
        );
        for (const entry of wire?.identifications ?? []) {
          expect(text).toMatch(
            new RegExp(`current: true · hidden: ${entry.hidden} · id ${entry.id} ·`),
          );
        }
        const hiddenComment = wire?.comments?.find((entry) => entry.id === 100_005);
        if (hiddenComment) {
          expect(hiddenComment).toMatchObject({ hidden: true, body: 'Hidden but relayed.' });
          expect(text).toContain('· id 100005 · 2026-06-01T13:00:00-07:00 · hidden: true');
          expect(text).toContain('> Hidden but relayed.');
        }
        stitched.push(...(wire?.identifications ?? []));
        offset = paged(result).next_array_offset;
      }

      expect(offset).toBeNull();
      expect(offsets).toEqual([0, 4, 8]);
      expect(stitched.map((entry) => entry.id)).toEqual(range(100_000, 11));
      expect(stitched.filter((entry) => entry.hidden).map((entry) => entry.id)).toEqual([
        100_001, 100_004, 100_009,
      ]);
    });

    it('keeps offsets valid when an entry is added upstream between two page reads', async () => {
      const record = long(1, { ids: 6 });
      const first = paged(await call([record], { observation_id: [1], array_limit: 4 }))
        .observations[0];
      // Upstream inserts the new identification at the front of its own order.
      record.identifications = [
        rawIdentification({ id: 200_000 }),
        ...(record.identifications ?? []),
      ];
      const second = paged(
        await call([record], { observation_id: [1], array_limit: 4, array_offset: 4 }),
      ).observations[0];

      expect(ids(first?.identifications)).toEqual(range(100_000, 4));
      expect(ids(second?.identifications)).toEqual([100_004, 100_005, 200_000]);
      expect(second?.identifications_total).toBe(7);
    });

    it('sends deferred ids back from array_offset 0 when the page is past the start', async () => {
      const result = await call([long(1, { ids: 50 })], {
        observation_id: range(1, 11),
        array_offset: 40,
      });

      expect(paged(result).notice).toContain(
        '1 distinct ids were deferred. Call inaturalist_get_observation with the deferred ids and the same include (identifications), from array_offset 0.',
      );
    });
  });
});

describe('rate_budget_exhausted', () => {
  it('is declared for tools/list and reaches the caller with its recovery on both surfaces', async () => {
    expect(
      inaturalistGetObservation.errors?.find((entry) => entry.reason === 'rate_budget_exhausted'),
    ).toMatchObject({ code: JsonRpcErrorCode.RateLimited, retryable: false });

    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/[\d,]+$/,
        respond: () => Response.json({ total_results: 1, results: [rawObservation({ id: 1 })] }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1,
      }),
    );
    http.install();
    try {
      expect(
        (await runToolContract(inaturalistGetObservation, { observation_id: [1] })).isError,
      ).toBeFalsy();
      const spent = await runToolContract(inaturalistGetObservation, { observation_id: [1] });
      expect(spent.isError).toBe(true);
      expect(spent.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'rate_budget_exhausted',
            retryable: false,
            recovery: { hint: expect.stringContaining('next UTC midnight') },
          },
        },
      });
      expect(JSON.stringify(spent.content)).toContain('rate_budget_exhausted');
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

/**
 * Upstream `/observations/{ids}` answers a batch sorted by id as a string. The
 * fetch mock replays that order, so these prove the reply follows the request.
 */
describe('batch order follows the request', () => {
  it('requests only ten distinct ids once and preserves the deferred tail on both surfaces', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/[\d,]+$/,
        respond: () =>
          Response.json({
            total_results: 10,
            results: ids
              .slice(0, 10)
              .reverse()
              .map((id) => rawObservation({ id })),
          }),
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
      const result = await runToolContract(inaturalistGetObservation, {
        observation_id: [1, ...ids, 12],
        include: ['comments'],
      });
      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.request.url).toMatch(/\/observations\/1,2,3,4,5,6,7,8,9,10$/);
      expect(result.structuredContent).toMatchObject({
        observations: ids.slice(0, 10).map((id) => ({ id })),
        unresolved: [],
        deferred: [{ observation_id: 11 }, { observation_id: 12 }],
      });
      expect(JSON.stringify(result.content)).toContain('**Deferred ids:** 11, 12');
      expect(JSON.stringify(result.content)).toContain('same include (comments)');
    } finally {
      http.restore();
    }
  });
  const requested = [5890862, 106687320, 322939816, 66463326, 3704154];
  const upstreamOrder = [...requested].sort((a, b) => String(a).localeCompare(String(b)));

  async function call(served: number[], ask: number[]) {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/[\d,]+$/,
        respond: () =>
          Response.json({
            total_results: served.length,
            results: served.map((id) => rawObservation({ id })),
          }),
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
      return await runToolContract(inaturalistGetObservation, { observation_id: ask });
    } finally {
      http.restore();
    }
  }

  const idsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { observations: { id: number }[] }).observations.map(
      (observation) => observation.id,
    );

  it('returns records in the requested order when upstream sorts them as strings', async () => {
    expect(upstreamOrder).not.toEqual(requested);
    const result = await call(upstreamOrder, requested);

    expect(idsOf(result)).toEqual(requested);
    const headings = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('**id** '))
      .map((line) => Number(line.split(' ')[1]));
    expect(headings).toEqual(requested);
  });

  it('omits an unresolved id in place and still reports it as unresolved', async () => {
    const result = await call(
      upstreamOrder.filter((id) => id !== 322939816),
      requested,
    );

    expect(idsOf(result)).toEqual([5890862, 106687320, 66463326, 3704154]);
    expect(result.structuredContent).toMatchObject({
      unresolved: [{ observation_id: 322939816 }],
      notice: '1 of 5 ids returned no observation; they may have been deleted or never existed.',
    });
  });

  it('returns a record requested twice once', async () => {
    // Upstream answers a repeated id once per repetition.
    const result = await call([1, 1], [1, 1]);

    expect(idsOf(result)).toEqual([1]);
  });

  it('asks upstream for a repeated id once and reports a repeated miss once', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\/[\d,]+$/,
        respond: () => Response.json({ total_results: 1, results: [rawObservation({ id: 1 })] }),
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
      const result = await runToolContract(inaturalistGetObservation, {
        observation_id: [999, 999, 1],
      });

      expect(http.calls[0]?.request.url).toMatch(/\/observations\/999,1$/);
      expect(result.structuredContent).toMatchObject({
        unresolved: [{ observation_id: 999 }],
        notice: '1 of 2 ids returned no observation; they may have been deleted or never existed.',
      });
    } finally {
      http.restore();
    }
  });

  it('states the order on the observations field', () => {
    expect(inaturalistGetObservation.output.shape.observations.description).toContain(
      'requested order',
    );
  });
});
