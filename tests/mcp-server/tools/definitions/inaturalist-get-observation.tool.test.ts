/**
 * @fileoverview Tests for inaturalist_get_observation — batch id resolution,
 * the not_found contract when nothing resolves, the per-id unresolved report
 * and its enrichment notice, the default include, format(), the batch-shared
 * identification/comment cap with its per-record counts and cut notice, and
 * the observer's description and observation fields, on both surfaces.
 * @module tests/mcp-server/tools/definitions/inaturalist-get-observation.tool.test
 */

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
    const notice =
      "Arrays cut to the first 40 entries each, in upstream order: observation 1 — identifications 40 of 41, comments 40 of 41. Open the record's url for the full record.";
    expect(structured(result).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain('### Identification thread — first 40 of 41 shown, in upstream order');
    expect(text).toContain('### Comments — first 40 of 41 shown, in upstream order');
    expect(text).toContain(notice);
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
      "Arrays cut to the first 20 entries each, in upstream order, to share the response across 2 records: observation 1 — identifications 20 of 21. Re-request a single id for up to 40 entries per array, or open a record's url for the full record.",
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
    expect(notice).toContain('first 4 entries each');
    expect(notice).toContain('across 10 records');
    for (const id of ids) {
      expect(notice).toContain(`observation ${id} — identifications 4 of 5, comments 4 of 5`);
    }
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
      "1 of 2 ids returned no observation; they may have been deleted or never existed. Arrays cut to the first 40 entries each, in upstream order: observation 1 — identifications 40 of 45. Open the record's url for the full record.";
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
      "Arrays cut to the first 40 entries each, in upstream order: observation 1 — identifications 40 of 41. Open the record's url for the full record.",
    );
  });

  it('keeps the notice cap equal to what each record kept when a batch repeats an id', async () => {
    const first = threaded(1, 25);
    const result = await call([first, first, threaded(2, 25)], { observation_id: [1, 2, 1] });

    const records = structured(result).observations;
    expect(records.map((entry) => entry.id)).toEqual([1, 2]);
    for (const entry of records) expect(entry.identifications_shown).toBe(20);
    expect(structured(result).notice).toContain(
      'first 20 entries each, in upstream order, to share the response across 2 records',
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
        { name: 'Habitat_Description', value: 'Garden' },
        { name: 'Empty', value: '' },
      ],
    });
    const result = await call([record], { observation_id: [402402822] });

    expect(structured(result).observations[0]).toMatchObject({
      description: 'caterpillar on narrow-leaf milkweed along fisherman’s access rd',
      observation_fields: [{ name: 'Habitat_Description', value: 'Garden' }],
    });
    const text = textOf(result);
    expect(text).toContain(
      '**Observer’s description:**\n> caterpillar on narrow-leaf milkweed along fisherman’s access rd',
    );
    expect(text).toContain(
      '### Observation fields — 1 of 1 shown\n- **Habitat_Description:** Garden',
    );
    expect(text).not.toContain('**Empty:**');
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

  it('cuts observation fields one past the cap to the first 40, in upstream order, and names the cut', async () => {
    const result = await call([withFields(1, 41)], { observation_id: [1] });

    const record = structured(result).observations[0] as WireRecord & {
      observation_fields?: { name: string }[];
    };
    expect(record.observation_fields?.map((field) => field.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `Field ${i}`),
    );
    expect(record).toMatchObject({ observation_fields_total: 41, observation_fields_shown: 40 });
    const notice =
      "Arrays cut to the first 40 entries each, in upstream order: observation 1 — observation_fields 40 of 41. Open the record's url for the full record.";
    expect(structured(result).notice).toBe(notice);
    const text = textOf(result);
    expect(text).toContain('### Observation fields — first 40 of 41 shown, in upstream order');
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
        `observation ${id} — identifications 4 of 5, comments 4 of 5, observation_fields 4 of 5`,
      );
    }
  });

  it('reports zero-field counts without a heading on a record that has none', async () => {
    const result = await call([withFields(1, 0, 3)], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({
      observation_fields: [],
      observation_fields_total: 0,
      observation_fields_shown: 0,
    });
    expect(textOf(result)).not.toContain('### Observation fields');
  });

  it('leaves the description whole however long it is', async () => {
    const description = 'milkweed '.repeat(2_000).trim();
    const result = await call([rawObservation({ id: 1, description })], { observation_id: [1] });

    expect(structured(result).observations[0]).toMatchObject({ description });
  });
});

/**
 * Upstream `/observations/{ids}` answers a batch sorted by id as a string. The
 * fetch mock replays that order, so these prove the reply follows the request.
 */
describe('batch order follows the request', () => {
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
