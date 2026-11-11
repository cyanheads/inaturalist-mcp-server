/**
 * @fileoverview Tests for inaturalist_search_observations — area/annotation/
 * search_on validation, the pagination contracts (window, conflicting cursor
 * and page, cursor-forced ordering), the has_more/next_cursor edge cases on
 * both the page and cursor paths — next_cursor only under id desc, and an
 * id-descending walk through the real service — the past-the-end notice, every
 * zero-hit notice fragment, the observer/project and licence-code filters, the
 * unknown_taxon_id and unknown_user passthroughs, and format().
 * @module tests/mcp-server/tools/definitions/inaturalist-search-observations.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
import type { QualityGrade } from '@/services/inaturalist/vocabularies.js';
import { failingUpstream } from '../../../helpers/failing-upstream.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import {
  projectedAnnotation,
  projectedObservation,
  projectedPhoto,
  projectedSound,
  rawIdentification,
  rawObservation,
} from '../../../helpers/fixtures.js';

vi.mock('@/services/inaturalist/inaturalist-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/inaturalist/inaturalist-service.js')>();
  return { ...actual, getINaturalistService: vi.fn() };
});

const fake = createFakeService();
// Widen only the harness input type to exercise malformed/form-client payloads at the schema boundary.
const searchContract: Parameters<typeof runToolContract>[0] = inaturalistSearchObservations;

beforeEach(() => {
  resetFakeService(fake);
  vi.mocked(getINaturalistService).mockReturnValue(asService(fake));
});

function observations(count: number, idOffset = 0) {
  return Array.from({ length: count }, (_, i) => projectedObservation({ id: idOffset + i + 1 }));
}

/** A cohort that silences both default-cohort hints, so a supplied filter's fragment stands alone. */
const SILENT_COHORT: { quality_grade: QualityGrade[]; captive: boolean } = {
  quality_grade: ['research', 'needs_id', 'casual'],
  captive: true,
};
const RESEARCH_HINT =
  'Only research-grade records were searched. Add "needs_id" to quality_grade to include sightings whose identification is not yet community-confirmed.';
const WILD_HINT =
  'Only wild records were searched. To search captive/cultivated-only records, use captive: true with "casual" in quality_grade in a separate call.';
const CAPTIVE_COHORT =
  'Captive and cultivated records are graded casual, so captive: true without "casual" in quality_grade matches only records whose grade disagrees with their captive flag. Add "casual" to quality_grade for captive or cultivated records.';
const SUCCESSOR_POINTER =
  'Check taxon_id with inaturalist_get_taxon: an inactive taxon lists its successors.';
const TAXON_FRAGMENTS = `No sightings of that taxon match the other filters. Confirm taxon_id with inaturalist_resolve_name, or drop it. ${SUCCESSOR_POINTER}`;
const PLACE_FRAGMENT =
  'No sightings in that place match the other filters. Confirm place_id with inaturalist_find_places, or drop it.';

describe('input validation', () => {
  it('forwards accurate/open, monthly, uploaded/updated and disputed filters through the real service', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org/,
        respond: () =>
          Response.json({
            total_results: 1,
            results: [
              rawObservation({ created_at: '2026-10-30T01:02:03.123456+02:00', updated_at: null }),
            ],
          }),
      },
    ]);
    vi.mocked(getINaturalistService).mockReturnValue(
      new INaturalistService({
        userAgent: 'inaturalist-mcp-server/test',
        minRequestIntervalMs: 0,
        maxConcurrentRequests: 4,
        dailyRequestBudget: 1000,
      }),
    );
    http.install();
    try {
      const result = await runToolContract(inaturalistSearchObservations, {
        acc_below: 0.5,
        obscuration: ['none'],
        month: [1, 12],
        d1: '2000-01-01',
        d2: '2000-12-31',
        created_d1: '2026-01-01',
        created_d2: '2026-12-31',
        updated_since: '2026-10-30T00:00:00+02:00',
        identifications: 'most_disagree',
      });
      expect(result.isError).toBeFalsy();
      expect(Object.fromEntries(new URL(http.calls[0]!.request.url).searchParams)).toMatchObject({
        acc_below: '0.5',
        obscuration: 'none',
        month: '1,12',
        d1: '2000-01-01',
        d2: '2000-12-31',
        created_d1: '2026-01-01',
        created_d2: '2026-12-31',
        updated_since: '2026-10-30T00:00:00+02:00',
        identifications: 'most_disagree',
      });
      expect(result.structuredContent).toMatchObject({
        observations: [{ created_at: '2026-10-30T01:02:03.123456+02:00', updated_at: null }],
      });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
      expect(text).toContain('2026-10-30T01:02:03.123456+02:00');
      expect(text).toContain('updated_at');
      expect(text).toContain('null');
      const detail = await runToolContract(inaturalistGetObservation, {
        observation_id: [401617560],
        include: [],
      });
      expect(detail.isError).toBeFalsy();
      expect(detail.structuredContent).toMatchObject({
        observations: [{ created_at: '2026-10-30T01:02:03.123456+02:00', updated_at: null }],
      });
      expect(JSON.stringify(detail.content)).toContain('2026-10-30T01:02:03.123456+02:00');
    } finally {
      http.restore();
    }
  });

  it('keeps framework numeric-string repair and blank optional monitoring filters', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(searchContract, {
      acc_below: '0.5',
      created_d1: '',
      created_d2: '',
      updated_since: '',
      identifications: '',
    });
    expect(result.isError).toBeFalsy();
    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({ acc_below: 0.5 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).not.toContain('drop updated_since');
  });

  it.each([
    { acc_below: 0 },
    { acc_below: -1 },
    { acc_below: 2147483648 },
    { acc_below: 'many' },
    { obscuration: ['open'] },
    { month: [13] },
    { month: [0] },
    { month: [1.5] },
    { created_d1: '2026-02-30' },
    { created_d2: '2026-13-01' },
    { updated_since: '2026-02-30' },
    { updated_since: '2026-02-30T12:00:00Z' },
    { updated_since: '2026-10-30T12:00:00' },
    { updated_since: '2026-10-30T12:00:00+25:00' },
    { identifications: ['most_agree'] },
    { identifications: 'unknown' },
  ])('rejects malformed new search filters before any request: %j', async (args) => {
    const http = createFetchMock([
      { match: () => true, respond: () => Response.json({ results: [] }) },
    ]);
    http.install();
    try {
      const result = await runToolContract(searchContract, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('invalid_arguments');
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });

  it('rejects inverted upload bounds independently with date recovery on both surfaces', async () => {
    const { http, service } = failingUpstream();
    vi.mocked(getINaturalistService).mockReturnValue(service);
    http.install();
    try {
      const result = await runToolContract(inaturalistSearchObservations, {
        created_d1: '2026-12-31',
        created_d2: '2026-01-01',
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'inverted_date_range',
            recovery: { hint: expect.stringContaining('created_d1') },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('created_d1');
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });

  it('composes empty arrays and zero-hit advice only for supplied new filters', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      month: [],
      obscuration: [],
      acc_below: 0.5,
      updated_since: '2026-10-30',
      identifications: 'some_agree',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
    expect(text).toContain('month, obscuration were empty and ignored');
    expect(text).toContain('drop acc_below');
    expect(text).toContain('drop updated_since');
    expect(text).toContain('drop identifications');
    expect(text).not.toContain('drop created_d1');
  });

  it('retrieves a deferred oversized record whole by id with the same expansions', async () => {
    const locality = '🌿'.repeat(20_000);
    const record = projectedObservation({
      id: 3,
      place_guess: locality,
      photos: [projectedPhoto(), projectedPhoto({ attribution: 'second photo' })],
      sounds: [projectedSound(), projectedSound({ attribution: 'second sound' })],
    });
    fake.searchObservations.mockResolvedValue({ total: 1, observations: [record] });
    const search = await runToolContract(inaturalistSearchObservations, {
      include: ['photos', 'sounds'],
    });
    expect(search.structuredContent).toMatchObject({
      observations: [],
      deferred: [{ observation_id: 3 }],
      has_more: false,
    });
    fake.getObservations.mockResolvedValue({ observations: [record], unresolved: [] });
    const detail = await runToolContract(inaturalistGetObservation, {
      observation_id: [3],
      include: ['photos', 'sounds'],
    });
    expect(detail.isError).toBeFalsy();
    expect(detail.structuredContent).toMatchObject({
      observations: [record],
      unresolved: [],
      deferred: [],
    });
    const text = detail.content.map((block) => ('text' in block ? block.text : '')).join('');
    expect(text).toContain(locality);
    expect(text).toContain('second photo');
    expect(text).toContain('second sound');
    expect(fake.getObservations.mock.calls[0]?.slice(0, 2)).toEqual([
      [3],
      new Set(['photos', 'sounds']),
    ]);
    expect(fake.searchObservations).toHaveBeenCalledTimes(1);
    expect(fake.getObservations).toHaveBeenCalledTimes(1);
  });
  // The fixture record's one GBIF outlink costs 148 serialized bytes across both surfaces.
  it.each([
    [21_745, 1],
    [21_746, 0],
  ])('keeps complete records at the measured reserve boundary (%s)', async (length, shown) => {
    fake.searchObservations.mockResolvedValue({
      total: 1,
      observations: [projectedObservation({ place_guess: 'x'.repeat(length) })],
    });
    const result = await runToolContract(inaturalistSearchObservations, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      shown,
      has_more: false,
      deferred: shown === 1 ? [] : [{ observation_id: 401617560 }],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
    if (shown === 1) expect(text).toContain('x'.repeat(21_745));
    else expect(text).toContain('inaturalist_get_observation');
  });

  it('composes clamp, ignored-filter, pagination and deferred guidance once', async () => {
    // This record shape, timestamps and one GBIF outlink included, measures a 21-record boundary.
    const records = observations(25).map((record) => ({
      ...record,
      observer: 'ab',
      photo: projectedPhoto({ attribution: 'credit' }),
    }));
    fake.searchObservations.mockResolvedValue({ total: 100, observations: records });
    const result = await runToolContract(inaturalistSearchObservations, {
      per_page: 26,
      order_by: 'id',
      license: [],
      include: Array(10_000).fill('photos'),
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cap: 25,
      shown: 21,
      has_more: true,
      next_cursor: '25',
      deferred: [22, 23, 24, 25].map((observation_id) => ({ observation_id })),
    });
    const notice = z.object({ notice: z.string() }).parse(result.structuredContent).notice;
    for (const fragment of [
      'per_page 26 was clamped to 25.',
      'license was empty and ignored',
      'Pass cursor "25"',
      'Some fetched records were deferred',
    ]) {
      expect(notice).toContain(fragment);
      expect(notice.indexOf(fragment)).toBe(notice.lastIndexOf(fragment));
      expect(result.content.map((block) => ('text' in block ? block.text : '')).join('')).toContain(
        fragment,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
  });
  it('defers an oversized first record and every later record on a final page', async () => {
    const records = [
      projectedObservation({ id: 3, place_guess: '🌿'.repeat(20_000) }),
      projectedObservation({ id: 2 }),
    ];
    fake.searchObservations.mockResolvedValue({ total: 2, observations: records });
    const result = await runToolContract(inaturalistSearchObservations, { per_page: 25 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [],
      deferred: [{ observation_id: 3 }, { observation_id: 2 }],
      has_more: false,
      truncated: true,
      shown: 0,
      cap: 25,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
    const text = JSON.stringify(result.content);
    expect(text).toContain('observation_id');
    expect(text).toContain('inaturalist_get_observation');
    expect(text).toContain('even when has_more is false');
    expect(fake.searchObservations).toHaveBeenCalledTimes(1);
  });

  it('preserves nested expansion entries whole in every retained record', async () => {
    const records = observations(25).map((record) => ({
      ...record,
      photos: Array.from({ length: 3 }, (_, i) =>
        projectedPhoto({ attribution: `photo ${i} 🌿"\\`.repeat(30) }),
      ),
      sounds: Array.from({ length: 3 }, (_, i) =>
        projectedSound({ attribution: `sound ${i} 🌿"\\`.repeat(30) }),
      ),
      annotations: Array.from({ length: 3 }, (_, i) =>
        projectedAnnotation({ by: `observer-${i}`, value: `value-${i}` }),
      ),
    }));
    fake.searchObservations.mockResolvedValue({ total: 25, observations: records });
    const result = await runToolContract(inaturalistSearchObservations, {
      per_page: 25,
      include: ['photos', 'sounds', 'annotations'],
    });
    expect(result.isError).toBeFalsy();
    const output = inaturalistSearchObservations.output.parse(result.structuredContent);
    expect(output.observations.length).toBeGreaterThan(0);
    expect(output.observations.length).toBeLessThan(25);
    expect(output.observations).toEqual(records.slice(0, output.observations.length));
    expect(output.deferred).toEqual(
      records.slice(output.observations.length).map(({ id }) => ({ observation_id: id })),
    );
    const text = JSON.stringify(result.content);
    expect(text).toContain('Photo 3');
    expect(text).toContain('sound 2');
    expect(text).toContain('value-2');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
  });

  it('continues from the full fetched page across deferred cursor hops and ends on the full final page', async () => {
    const seen: number[] = [];
    for (const [hop, ids] of [
      [0, [6, 5]],
      [1, [4, 3]],
      [2, [2, 1]],
    ] as const) {
      const records = ids.map((id) =>
        projectedObservation({ id, place_guess: '🌿'.repeat(20_000) }),
      );
      fake.searchObservations.mockResolvedValueOnce({ total: 6 - hop * 2, observations: records });
      const result = await runToolContract(inaturalistSearchObservations, {
        per_page: 2,
        ...(hop === 0 ? { order_by: 'id' } : { cursor: String(7 - hop * 2) }),
      });
      expect(result.isError).toBeFalsy();
      const output = inaturalistSearchObservations.output.parse(result.structuredContent);
      seen.push(
        ...output.observations.map(({ id }) => id),
        ...output.deferred.map(({ observation_id }) => observation_id),
      );
      expect(output.observations).toEqual([]);
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
      // Every record is deferred, so continuation can only come from the full upstream page.
      if (hop < 2) {
        expect(output.next_cursor).toBe(String(ids[1]));
        expect(output.has_more).toBe(true);
        expect(text).toContain(`Pass cursor "${ids[1]}"`);
      } else {
        expect(output.next_cursor).toBeUndefined();
        expect(output.has_more).toBe(false);
        expect(text).not.toContain('Pass cursor');
        expect(text).toContain('Deferred records remain available even when has_more is false.');
      }
    }
    expect(seen).toEqual([6, 5, 4, 3, 2, 1]);
    expect(fake.searchObservations.mock.calls.map(([params]) => params.id_below)).toEqual([
      undefined,
      '5',
      '3',
    ]);
  });

  it('bounds enrichment and trailer reserve across all composed notice branches', async () => {
    const common = {
      per_page: Number.MAX_SAFE_INTEGER,
      license: [],
      photo_license: [],
      csi: [],
      term_value_id: [],
      iconic_taxa: [],
    };
    const cases = [
      {
        args: {
          ...common,
          taxon_id: 1,
          d1: '0000-01-01',
          d2: '9999-12-31',
          term_id: [1],
          lat: 1,
          lng: 1,
          radius: 500,
          user_id: 1,
          project_id: 1,
          sounds: true,
        },
        total: 0,
        records: [],
      },
      {
        args: { ...common, page: 400, order_by: 'observed_on' as const, term_id: [] },
        total: Number.MAX_VALUE,
        records: observations(25),
      },
      {
        args: { ...common, cursor: '999999999', term_id: [] },
        total: Number.MAX_VALUE,
        records: observations(25),
      },
      { args: { ...common, page: 400, term_id: [] }, total: 93, records: [] },
    ];
    for (const { args, total, records } of cases) {
      fake.searchObservations.mockResolvedValueOnce({ total, observations: records });
      const result = await runToolContract(inaturalistSearchObservations, args);
      expect(result.isError).toBeFalsy();
      const output = inaturalistSearchObservations.output.parse(result.structuredContent);
      const domainBytes = Buffer.byteLength(
        JSON.stringify({
          content: inaturalistSearchObservations.format?.(output),
          structuredContent: output,
        }),
      );
      expect(Buffer.byteLength(JSON.stringify(result)) - domainBytes).toBeLessThan(4_096);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
      expect(JSON.stringify(result.content)).toContain('was clamped to 25');
    }
  });
  it('keeps whole-record search replies within the byte budget and discloses deferred ids', async () => {
    const records = observations(25).map((record) => ({
      ...record,
      place_guess: '🌿"\\\n'.repeat(300),
    }));
    fake.searchObservations.mockResolvedValue({ total: 100, observations: records });
    const result = await runToolContract(inaturalistSearchObservations, {
      per_page: 25,
      order_by: 'id',
    });
    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
    const output = inaturalistSearchObservations.output.parse(result.structuredContent);
    expect(output.observations.length).toBeGreaterThan(0);
    expect(output.observations.length).toBeLessThan(25);
    expect(output.observations).toEqual(records.slice(0, output.observations.length));
    expect(output).toMatchObject({
      deferred: records.slice(output.observations.length).map(({ id }) => ({ observation_id: id })),
      next_cursor: '25',
      has_more: true,
    });
    expect(JSON.stringify(result.content)).toContain('inaturalist_get_observation');
    expect(fake.searchObservations).toHaveBeenCalledTimes(1);
  });

  it('normalizes repeated quality grades before request and enrichment', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      quality_grade: Array.from({ length: 10_000 }, (_, i) => (i % 2 ? 'research' : 'casual')),
    });
    expect(result.structuredContent).toMatchObject({
      applied_filters: { quality_grade: ['casual', 'research'] },
    });
    expect(fake.searchObservations.mock.calls[0]?.[0].quality_grade).toEqual([
      'casual',
      'research',
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
  });

  it('clamps search before its page-window check and composes the notice', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      per_page: 26,
      page: 400,
      license: [],
    });
    expect(result.isError).toBeFalsy();
    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({ per_page: 25, page: 400 });
    expect(result.structuredContent).toMatchObject({
      cap: 25,
      deferred: [],
      notice: expect.stringContaining('per_page 26 was clamped to 25'),
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('license was empty and ignored');
    expect(text).toContain('Page 400 came back empty');
  });
  it('preserves a complete ordinary record on both contract surfaces', async () => {
    const record = projectedObservation();
    fake.searchObservations.mockResolvedValue({ total: 1, observations: [record] });
    const result = await runToolContract(inaturalistSearchObservations, {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [record],
      has_more: false,
      shown: 1,
      cap: 10,
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('');
    expect(text).toContain('## Monarch (Danaus plexippus)');
    expect(text).toContain('401617560');
    expect(fake.searchObservations).toHaveBeenCalledTimes(1);
  });
  it('bounds per_page and its default to the response budget', () => {
    expect(inaturalistSearchObservations.input.parse({}).per_page).toBe(10);
    expect(inaturalistSearchObservations.input.safeParse({ per_page: 25 }).success).toBe(true);
    expect(inaturalistSearchObservations.input.safeParse({ per_page: 26 }).success).toBe(true);
  });

  it('rejects an area given in two forms at once', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('rejects term_value_id supplied without term_id', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ term_value_id: [6] });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unpaired_annotation_value' },
    });
  });

  it('rejects search_on supplied without q', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ search_on: 'names' });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'search_on_without_query' },
    });
  });

  it('rejects page and cursor supplied together', async () => {
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 1, cursor: '12345' });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_pagination' },
    });
  });

  it('treats a blank cursor from a form client as unset, so page does not conflict with it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 2, cursor: '' });

    expect(input.cursor).toBeUndefined();
    await expect(inaturalistSearchObservations.handler(input, ctx)).resolves.toBeDefined();

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.page).toBe(2);
    expect(params.id_below).toBeUndefined();
  });

  it('treats a blank q from a form client as unset, so search_on is not required', async () => {
    const input = inaturalistSearchObservations.input.parse({ q: '', d1: '' });

    expect(input.q).toBeUndefined();
    expect(input.d1).toBeUndefined();
  });

  it('rejects page × per_page past the 10,000-result window, routing to an id-descending cursor walk', async () => {
    const result = await runToolContract(inaturalistSearchObservations, {
      page: 501,
      per_page: 20,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'result_window_exceeded',
          recovery: {
            hint: expect.stringContaining(
              're-run with order_by "id" and order "desc", then pass each page\'s next_cursor as cursor',
            ),
          },
        },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('allows page × per_page exactly at the 10,000-result window', async () => {
    fake.searchObservations.mockResolvedValue({ total: 10_000, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 500, per_page: 20 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).resolves.toBeDefined();
  });
});

describe('ordered pairs', () => {
  it('rejects an hrank finer than lrank before any request, without a zero-hit notice', async () => {
    const args = { place_id: 1, hrank: 'family' as const, lrank: 'order' as const };
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });

    await expect(
      inaturalistSearchObservations.handler(inaturalistSearchObservations.input.parse(args), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'inverted_rank_range' },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();

    const result = await runToolContract(inaturalistSearchObservations, args);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'inverted_rank_range',
          recovery: { hint: expect.stringContaining('coarser rank') },
        },
      },
    });
  });

  it('rejects d1 after d2 before any request, without a zero-hit notice', async () => {
    const args = { place_id: 1, taxon_id: 48662, d1: '2026-01-01', d2: '2025-01-01' };
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });

    await expect(
      inaturalistSearchObservations.handler(inaturalistSearchObservations.input.parse(args), ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'inverted_date_range' },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
    expect(getEnrichment(ctx).notice).toBeUndefined();

    const result = await runToolContract(inaturalistSearchObservations, args);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'inverted_date_range',
          recovery: { hint: expect.stringContaining('on or before d2') },
        },
      },
    });
  });

  it('sends equal rank and date pairs through unchanged', async () => {
    fake.searchObservations.mockResolvedValue({ total: 1, observations: observations(1) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      place_id: 1,
      hrank: 'family',
      lrank: 'family',
      d1: '2025-06-15',
      d2: '2025-06-15',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({
      hrank: 'family',
      lrank: 'family',
      d1: '2025-06-15',
      d2: '2025-06-15',
    });
  });

  it('sends a correctly ordered range through', async () => {
    fake.searchObservations.mockResolvedValue({ total: 1, observations: observations(1) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      hrank: 'order',
      lrank: 'family',
      d1: '2025-01-01',
      d2: '2026-01-01',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(fake.searchObservations.mock.calls[0]?.[0]).toMatchObject({
      hrank: 'order',
      lrank: 'family',
      d1: '2025-01-01',
      d2: '2026-01-01',
    });
  });

  it('rejects a calendar-invalid date at the schema, like a malformed one', () => {
    expect(inaturalistSearchObservations.input.safeParse({ d1: '2026-02-30' }).success).toBe(false);
    expect(inaturalistSearchObservations.input.safeParse({ d2: '2025-13-01' }).success).toBe(false);
  });
});

describe('areas upstream answers with HTTP 500', () => {
  /**
   * The real service runs here against an upstream that answers 500, so a
   * missing check shows up as fetch attempts (four, with the retries) and a
   * service error in place of invalid_geography.
   */
  it('rejects radius 0 as invalid_geography with no request and no retry', {
    timeout: 30_000,
  }, async () => {
    const { http, service } = failingUpstream();
    vi.mocked(getINaturalistService).mockReturnValue(service);
    http.install();
    try {
      const result = await runToolContract(inaturalistSearchObservations, {
        lat: 37,
        lng: -120,
        radius: 0,
        per_page: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'invalid_geography',
            recovery: { hint: expect.stringContaining('radius above 0') },
          },
        },
      });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });
});

describe('non-positive radius on the wire', () => {
  it('fails a negative radius as invalid_geography with the area hint, not a schema error', async () => {
    const result = await runToolContract(inaturalistSearchObservations, {
      lat: 37,
      lng: -120,
      radius: -1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_geography' },
      },
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(
      'radius must be greater than 0 kilometres; -1 was supplied. Upstream fails on a radius of 0 or less',
    );
    expect(text).toContain('a radius above 0');
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });
});

describe('cursor format validation', () => {
  it('accepts a positive-integer cursor', () => {
    const result = inaturalistSearchObservations.input.safeParse({ cursor: '401666942' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBe('401666942');
  });

  it('treats a blank cursor as unset rather than rejecting it', () => {
    const result = inaturalistSearchObservations.input.safeParse({ cursor: '' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeUndefined();
  });

  it('rejects zero and a leading-zero cursor — observation ids start at 1', () => {
    expect(inaturalistSearchObservations.input.safeParse({ cursor: '0' }).success).toBe(false);
    expect(inaturalistSearchObservations.input.safeParse({ cursor: '007' }).success).toBe(false);
  });

  it('rejects a non-numeric cursor at the schema, before the handler or the service ever sees it', async () => {
    expect(inaturalistSearchObservations.input.safeParse({ cursor: 'notanumber' }).success).toBe(
      false,
    );

    const result = await runToolContract(inaturalistSearchObservations, {
      cursor: 'notanumber',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });
});

describe('cursor forces id ordering', () => {
  it('sends order_by id / order desc under a cursor regardless of the requested ordering', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      cursor: '401666942',
      order_by: 'votes',
      order: 'asc',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.order_by).toBe('id');
    expect(params.order).toBe('desc');
    expect(params.id_below).toBe('401666942');
    expect(params.page).toBeUndefined();

    expect(getEnrichment(ctx).applied_filters).toMatchObject({
      order_by: 'id',
      order: 'desc',
      ordering_forced_by_cursor: true,
    });
  });

  it('sends the requested ordering and page on the page path', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ order_by: 'votes', order: 'asc' });

    await inaturalistSearchObservations.handler(input, ctx);

    const [params] = fake.searchObservations.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      unknown,
    ];
    expect(params.order_by).toBe('votes');
    expect(params.order).toBe('asc');
    expect(params.page).toBe(1);
    expect(params.id_below).toBeUndefined();
    expect(getEnrichment(ctx).applied_filters).toMatchObject({ ordering_forced_by_cursor: false });
  });
});

describe('has_more / next_cursor', () => {
  it('issues no next_cursor under the default ordering, pointing at the next page instead', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 1, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeUndefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBe('More records match. Raise page to 2 to continue.');
  });

  it('issues next_cursor on the page path when the applied ordering is id desc', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 1,
      per_page: 20,
      order_by: 'id',
      order: 'desc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(String(20));
    expect(getEnrichment(ctx).notice).toContain('Pass cursor "20" to continue');
  });

  it('issues no next_cursor under id asc — only id_below is sent, so a cursor would walk backwards', async () => {
    fake.searchObservations.mockResolvedValue({ total: 100, observations: observations(20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 3,
      per_page: 20,
      order_by: 'id',
      order: 'asc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBe('More records match. Raise page to 4 to continue.');
  });

  it('points a non-id ordering at order_by id / order desc when the next page would pass the 10,000 window', async () => {
    const records = observations(25).map((record) => ({
      ...record,
      observer: 'ab',
      photo: projectedPhoto({ attribution: 'credit' }),
    }));
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: records });

    const result = await runToolContract(inaturalistSearchObservations, {
      page: 400,
      per_page: 25,
      order_by: 'votes',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({
      has_more: true,
      truncated: true,
      shown: 21,
      cap: 25,
      deferred: [22, 23, 24, 25].map((observation_id) => ({ observation_id })),
    });
    expect(structured).not.toHaveProperty('next_cursor');
    const expected =
      'This page ends at the 10,000-result window upstream serves, and no cursor continues order_by "votes", order "desc". To continue past it, re-run with order_by "id" and order "desc" and follow next_cursor, or narrow the filters.';
    expect(structured.notice).toBe(
      `${expected} Some fetched records were deferred to keep this response within its byte budget. Retrieve every deferred observation_id with inaturalist_get_observation using the same include values. Deferred records remain available even when has_more is false.`,
    );
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
    expect(text).toContain('**next_cursor:** none');
  });

  it('names the direction at the window edge under id asc, so the re-run to id desc reads as a change', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: observations(25) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 400,
      per_page: 25,
      order_by: 'id',
      order: 'asc',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.next_cursor).toBeUndefined();
    expect(getEnrichment(ctx).notice).toBe(
      'This page ends at the 10,000-result window upstream serves, and no cursor continues order_by "id", order "asc". To continue past it, re-run with order_by "id" and order "desc" and follow next_cursor, or narrow the filters. Some fetched records were deferred to keep this response within its byte budget. Retrieve every deferred observation_id with inaturalist_get_observation using the same include values. Deferred records remain available even when has_more is false.',
    );
  });

  it('keeps the cursor guidance at the window edge under id desc, since the cursor is the way past it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 50_000, observations: observations(25) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 400,
      per_page: 25,
      order_by: 'id',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.next_cursor).toBe(String(25));
    expect(getEnrichment(ctx).notice).toContain('Pass cursor "25" to continue');
  });

  it('stops on the page path when a full page exactly reaches the reported total', async () => {
    fake.searchObservations.mockResolvedValue({ total: 40, observations: observations(20, 20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ page: 2, per_page: 20 });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it('omits next_cursor on an exactly full final page under id desc too', async () => {
    fake.searchObservations.mockResolvedValue({ total: 40, observations: observations(20, 20) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      page: 2,
      per_page: 20,
      order_by: 'id',
    });

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  /** Asserts the continuation an id-descending page reports, on both assembled surfaces. */
  async function expectContinuation(
    args: Record<string, unknown>,
    upstream: { total: number; ids: number[] },
    hasMore: boolean,
  ) {
    fake.searchObservations.mockResolvedValue({
      total: upstream.total,
      observations: upstream.ids.map((id) => projectedObservation({ id })),
    });
    const result = await runToolContract(searchContract, { ...args, per_page: 2 });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    const cursor = String(upstream.ids.at(-1));
    expect(structured).toMatchObject({ has_more: hasMore, truncated: hasMore });
    if (hasMore) {
      expect(structured.next_cursor).toBe(cursor);
      expect(structured.notice).toContain(`More records match. Pass cursor "${cursor}"`);
      expect(text).toContain(`**has_more:** true · **next_cursor:** ${cursor}`);
      expect(text).toContain(`More records match. Pass cursor "${cursor}"`);
    } else {
      expect(structured).not.toHaveProperty('next_cursor');
      expect(structured).not.toHaveProperty('notice');
      expect(text).toContain('**has_more:** false · **next_cursor:** none');
      expect(text).not.toContain('More records match');
    }
  }

  it.each([
    { name: 'a full page short of the total', page: 1, total: 5, ids: [5, 4], hasMore: true },
    { name: 'a full page reaching the total', page: 2, total: 4, ids: [2, 1], hasMore: false },
    { name: 'a short final page', page: 3, total: 5, ids: [1], hasMore: false },
  ])(
    'reads page-path continuation from the offset and total: $name',
    async ({ page, total, ids, hasMore }) => {
      await expectContinuation({ page, order_by: 'id' }, { total, ids }, hasMore);
    },
  );

  // Under a cursor upstream counts only the records below it, so total and per_page decide the end.
  it.each([
    { name: 'a full page whose total equals per_page', total: 2, ids: [2, 1], hasMore: false },
    { name: 'a full page short of the total', total: 3, ids: [3, 2], hasMore: true },
    { name: 'a short final page', total: 1, ids: [1], hasMore: false },
  ])(
    'reads cursor continuation from the below-cursor total: $name',
    async ({ total, ids, hasMore }) => {
      await expectContinuation({ cursor: '99' }, { total, ids }, hasMore);
    },
  );

  it('reports has_more: false with no next_cursor on an empty result', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({});

    const result = await inaturalistSearchObservations.handler(input, ctx);

    expect(result).toEqual({ total_results: 0, observations: [], deferred: [], has_more: false });
  });
});

describe('zero-hit notice composition', () => {
  it('names both default filters when neither was overridden', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({});

    await inaturalistSearchObservations.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Only research-grade records were searched.');
    expect(notice).toContain('Only wild records were searched.');
  });

  it('returns exactly the two default-cohort hints when nothing beyond the defaults was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {});
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `${RESEARCH_HINT} ${WILD_HINT}`,
    );
  });

  it('names q, then the place, before the default-cohort hints, on both surfaces', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1282,
      q: 'zzqqxxnotaword',
      per_page: 1,
    });
    const expected = `Relax supplied filters one at a time: drop q. ${PLACE_FRAGMENT} ${RESEARCH_HINT} ${WILD_HINT}`;
    expect((result.structuredContent as { notice?: string }).notice).toBe(expected);
    expect(JSON.stringify(result.content)).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it('names licences, the taxon and the place, with the wild-only hint last', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1282,
      taxon_id: 67356,
      license: ['cc0'],
      photo_license: ['cc0'],
      quality_grade: ['research', 'needs_id'],
      per_page: 1,
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `Relax supplied filters one at a time: drop license, drop photo_license. ${TAXON_FRAGMENTS} ${PLACE_FRAGMENT} ${WILD_HINT}`,
    );
  });

  it('names taxon_id before both default-cohort hints when it is the only supplied filter', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, { taxon_id: 135056 });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `${TAXON_FRAGMENTS} ${RESEARCH_HINT} ${WILD_HINT}`,
    );
  });

  it('points a zero-hit taxon search at the successor check in one upstream request, and only then', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () => Response.json({ total_results: 0, results: [] }),
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
      const withTaxon = await runToolContract(inaturalistSearchObservations, { taxon_id: 135056 });
      expect(http.calls).toHaveLength(1);
      const notice = (withTaxon.structuredContent as { notice: string }).notice;
      expect(notice).toContain(SUCCESSOR_POINTER);
      expect(notice).toContain('Only research-grade records were searched.');
      expect(JSON.stringify(withTaxon.content)).toContain(SUCCESSOR_POINTER);

      const withoutTaxon = await runToolContract(inaturalistSearchObservations, { place_id: 1 });
      expect(http.calls).toHaveLength(2);
      expect((withoutTaxon.structuredContent as { notice: string }).notice).not.toContain(
        'inaturalist_get_taxon',
      );
    } finally {
      http.restore();
    }
  });

  it('names a bounding box', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        ...SILENT_COHORT,
        nelat: 48,
        nelng: -122,
        swlat: 47,
        swlng: -123,
      }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      'No sightings inside that bounding box. Widen the box, or search a named area with a place_id from inaturalist_find_places.',
    );
  });

  it('orders every supplied fragment and names each filter once', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        q: 'moth',
        search_on: 'tags',
        licensed: true,
        photo_licensed: false,
        iconic_taxa: ['Insecta'],
        taxon_id: 47157,
        user_id: 1,
        project_id: 5,
        term_id: [1],
        sounds: true,
        d1: '2026-01-01',
        lat: 47.6,
        lng: -122.3,
        radius: 10,
      }),
      ctx,
    );
    const notice = getEnrichment(ctx).notice as string;
    const order = [
      'Relax supplied filters one at a time:',
      'No sightings of that taxon',
      'No sightings by that observer',
      'No sightings in that project',
      'No sightings carry that annotation',
      'sounds: true selected',
      'No sightings fall in',
      'No sightings within 10 km',
      'Only research-grade records',
      'Only wild records',
    ].map((fragment) => notice.indexOf(fragment));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const item of [
      'drop search_on or drop q with it',
      'drop licensed',
      'drop photo_licensed',
      'drop iconic_taxa',
    ]) {
      expect(notice.split(item)).toHaveLength(2);
    }
    // search_on without q is refused, so no remedy drops q on its own.
    expect(notice).not.toMatch(/drop q(?! with it)/);
    expect(notice).not.toContain('No sightings matched');
  });

  it('never names an empty array it already reported as ignored', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      ...SILENT_COHORT,
      license: [],
      photo_license: [],
      iconic_taxa: [],
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'iconic_taxa, license, photo_license were empty and ignored; omit empty filters to search without those restrictions. No sightings matched. Relax one filter at a time.',
    );
  });

  it('names the date range when the defaults were widened', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      ...SILENT_COHORT,
      d1: '2026-01-01',
      d2: '2026-01-31',
    });

    await inaturalistSearchObservations.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No sightings fall in 2026-01-01…2026-01-31.');
    expect(notice).not.toContain('Only research-grade records were searched.');
    // No taxon_id and no area were given, so neither is named.
    expect(notice).not.toContain('taxon');
    expect(notice).not.toContain('here');
  });

  it('names taxon_id in its own fragment rather than the fallback, and never the absent date range', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ ...SILENT_COHORT, taxon_id: 47126 });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(TAXON_FRAGMENTS);
  });

  it('names the annotation filter when a term_id was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      ...SILENT_COHORT,
      term_id: [1],
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'No sightings carry that annotation. Check the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.',
    );
  });

  it('points the annotation check at the taxon only when taxon_id was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      ...SILENT_COHORT,
      taxon_id: 47126,
      term_id: [1],
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      `${TAXON_FRAGMENTS} No sightings carry that annotation. Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.`,
    );
  });

  it('names the radius when an area radius was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({
      ...SILENT_COHORT,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('No sightings within 10 km of that point.');
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });

    const result = await runToolContract(inaturalistSearchObservations, {
      ...SILENT_COHORT,
      per_page: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [],
      has_more: false,
      truncated: false,
      shown: 0,
      cap: 5,
      notice: 'No sightings matched. Relax one filter at a time.',
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No sightings matched. Relax one filter at a time.');
  });

  it('reports truncated: false on a partial page that never reached per_page', async () => {
    fake.searchObservations.mockResolvedValue({ total: 3, observations: observations(3) });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ per_page: 20 });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 3, cap: 20 });
  });

  it('falls back to the generic notice when no specific condition applies', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse(SILENT_COHORT);

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe('No sightings matched. Relax one filter at a time.');
  });
});

describe('captive cohort disclosure', () => {
  it('discloses the cohort on an empty captive search, with no needs_id remedy beside it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1282,
      captive: true,
      per_page: 2,
    });
    const expected = `${CAPTIVE_COHORT} ${PLACE_FRAGMENT}`;
    expect(result.structuredContent).toMatchObject({ total_results: 0, notice: expected });
    expect(JSON.stringify(result.content)).toContain(JSON.stringify(expected).slice(1, -1));
  });

  it('returns the grade-inconsistent records it finds, with the notice, on both surfaces', async () => {
    fake.searchObservations.mockResolvedValue({
      total: 1,
      observations: [projectedObservation({ id: 404315372, captive: true })],
    });
    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 14,
      captive: true,
      quality_grade: ['research', 'needs_id'],
      per_page: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      observations: [{ id: 404315372 }],
      notice: CAPTIVE_COHORT,
    });
    expect(JSON.stringify(result.content)).toContain(JSON.stringify(CAPTIVE_COHORT).slice(1, -1));
  });

  it('joins the clamp, ignored-array and zero-hit notices rather than replacing them', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      captive: true,
      quality_grade: ['needs_id'],
      license: [],
      taxon_id: 47126,
      per_page: 26,
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `per_page 26 was clamped to 25. license was empty and ignored; omit empty filters to search without those restrictions. ${CAPTIVE_COHORT} ${TAXON_FRAGMENTS}`,
    );
  });

  it.each([
    { captive: true, quality_grade: ['casual'] },
    { captive: true, quality_grade: ['research', 'casual'] },
    { captive: false, quality_grade: ['research'] },
    { captive: false, quality_grade: ['research', 'needs_id', 'casual'] },
  ] satisfies { captive: boolean; quality_grade: QualityGrade[] }[])(
    'carries no cohort notice for %j',
    async (cohort) => {
      fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
      const result = await runToolContract(inaturalistSearchObservations, cohort);
      expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
        'graded casual',
      );
    },
  );

  it('names "casual" beside captive: true in the wild-only fragment', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      quality_grade: ['research', 'needs_id'],
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(WILD_HINT);
  });
});

describe('unknown_taxon_id passthrough from the service', () => {
  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.searchObservations.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        {
          reason: 'unknown_taxon_id',
          retryable: false,
        },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistSearchObservations.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});

describe('format()', () => {
  it('renders the summary header line and each observation', () => {
    const result = {
      total_results: 4_660_480,
      observations: [projectedObservation()],
      deferred: [],
      next_cursor: '401617560',
      has_more: true,
    };
    const [block] = inaturalistSearchObservations.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**total_results:** 4660480 (upstream estimate)');
    expect(text).toContain('**returned:** 1');
    expect(text).toContain('**has_more:** true');
    expect(text).toContain('**next_cursor:** 401617560');
    expect(text).toContain('## Monarch (Danaus plexippus)');
  });

  it('renders next_cursor as "none" when absent', () => {
    const result = { total_results: 0, observations: [], deferred: [], has_more: false };
    const [block] = inaturalistSearchObservations.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**next_cursor:** none');
  });
});

/**
 * The exact URL a call builds, through the real service and allowlist behind a
 * strict fetch mock — so a new filter left unset is proven never to reach the
 * query string.
 */
async function capturedSearchUrl(args: Record<string, unknown>): Promise<string> {
  const http = createFetchMock([
    {
      match: /api\.inaturalist\.org\/v1\/observations\?/,
      respond: () => Response.json({ total_results: 0, results: [] }),
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
    const result = await runToolContract(inaturalistSearchObservations, args);
    expect(result.isError).toBeFalsy();
    return http.calls[0]?.request.url ?? '';
  } finally {
    http.restore();
  }
}

describe('an id-descending walk through the real service', () => {
  /**
   * Upstream stand-in over ids 1–30: `id_below` filters and re-counts, `page`
   * offsets, and ordering is id descending — the one ordering a cursor
   * continues. The walk starts on the page path and continues by cursor, so
   * both halves of the handoff are exercised past the first hop. `ids` is read
   * on every request, so a caller can delete records between hops.
   */
  function idDescendingUpstream(ids = Array.from({ length: 30 }, (_, i) => 30 - i)) {
    return createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: (request) => {
          const url = new URL(request.url);
          const perPage = Number(url.searchParams.get('per_page'));
          const below = url.searchParams.get('id_below');
          const matching = below === null ? ids : ids.filter((id) => id < Number(below));
          const offset = below === null ? (Number(url.searchParams.get('page')) - 1) * perPage : 0;
          return Response.json({
            total_results: matching.length,
            results: matching
              .slice(offset, offset + perPage)
              .map((id) => rawObservation({ id, identifications: [] })),
          });
        },
      },
    ]);
  }

  it('reaches every record once, in order, from page 1 through two cursor hops, ending on the full final page', async () => {
    const http = idDescendingUpstream();
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
      const seen: number[] = [];
      let args: Record<string, unknown> = { order_by: 'id', order: 'desc', per_page: 10 };
      for (let hop = 0; hop < 3; hop += 1) {
        const result = await runToolContract(inaturalistSearchObservations, args);
        const structured = result.structuredContent as {
          observations: { id: number }[];
          next_cursor?: string;
          has_more: boolean;
        };
        seen.push(...structured.observations.map((o) => o.id));
        const final = hop === 2;
        expect(structured.has_more).toBe(!final);
        expect(structured.next_cursor).toBe(final ? undefined : String(seen.at(-1)));
        args = { cursor: structured.next_cursor, per_page: 10 };
      }

      expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
      expect(
        http.calls.map((call) => new URL(call.request.url).searchParams.get('id_below')),
      ).toEqual([null, '21', '11']);
    } finally {
      http.restore();
    }
  });

  it('says the walk is complete when the records below an issued cursor are gone by the next call', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 30 - i);
    const http = idDescendingUpstream(ids);
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
      const first = await runToolContract(inaturalistSearchObservations, {
        order_by: 'id',
        order: 'desc',
        per_page: 10,
      });
      const cursor = (first.structuredContent as { next_cursor?: string }).next_cursor;
      expect(cursor).toBe('21');
      ids.splice(10);

      const end = await runToolContract(inaturalistSearchObservations, { cursor, per_page: 10 });
      const expected =
        'No records below cursor 21 match these filters, so the id-descending walk is complete.';
      expect(end.structuredContent).toMatchObject({
        observations: [],
        has_more: false,
        notice: expected,
      });
      expect(end.structuredContent).not.toHaveProperty('next_cursor');
      expect(JSON.stringify(end.content)).toContain(expected);
      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });

  it('keeps the other notices beside the walk-complete notice', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1282,
      cursor: '1',
      per_page: 26,
      captive: true,
    });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      `per_page 26 was clamped to 25. ${CAPTIVE_COHORT} No records below cursor 1 match these filters, so the id-descending walk is complete.`,
    );
  });
});

describe('a page past the end of the results', () => {
  it('says the page is past the end and names the last page, rather than blaming the filters', async () => {
    fake.searchObservations.mockResolvedValue({ total: 93, observations: [] });

    const result = await runToolContract(inaturalistSearchObservations, {
      place_id: 1,
      taxon_id: 48662,
      d1: '2020-07-01',
      d2: '2020-07-01',
      per_page: 25,
      page: 40,
    });

    expect(result.isError).toBeFalsy();
    const expected =
      'Page 40 is past the end: 93 records match, so the last page holding results at per_page 25 is 4. Request page 4 or lower — the filters are not what emptied this page.';
    expect(result.structuredContent).toMatchObject({
      total_results: 93,
      observations: [],
      has_more: false,
      truncated: false,
      shown: 0,
      notice: expected,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain(expected);
    expect(text).not.toContain('No sightings fall in');
  });

  it('names page 1 as the last page when every match fits on it', async () => {
    fake.searchObservations.mockResolvedValue({ total: 3, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    const input = inaturalistSearchObservations.input.parse({ per_page: 25, page: 2 });

    await inaturalistSearchObservations.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain(
      'Page 2 is past the end: 3 records match, so the last page holding results at per_page 25 is 1.',
    );
  });
});

describe('request URL without the observer, project, or licence filters', () => {
  it('builds the same query string as before those filters existed', async () => {
    expect(await capturedSearchUrl({ place_id: 1, taxon_id: 48662, licensed: true })).toBe(
      'https://api.inaturalist.org/v1/observations?captive=false&licensed=true&order=desc&order_by=observed_on&page=1&per_page=10&place_id=1&quality_grade=research&taxon_id=48662',
    );
  });
});

describe('observer and project filters', () => {
  it('sends user_id, user_login, and project_id upstream, one observer form at a time', async () => {
    expect(await capturedSearchUrl({ user_login: 'kueda', project_id: 227779 })).toBe(
      'https://api.inaturalist.org/v1/observations?captive=false&order=desc&order_by=observed_on&page=1&per_page=10&project_id=227779&quality_grade=research&user_login=kueda',
    );
    expect(await capturedSearchUrl({ user_id: 1 })).toContain('&user_id=1');
  });

  it('treats a blank user_login from a form client as unset, never sending it', async () => {
    const input = inaturalistSearchObservations.input.parse({ user_login: '' });
    expect(input.user_login).toBeUndefined();
    expect(await capturedSearchUrl({ user_login: '' })).not.toContain('user_login');
  });

  it('rejects user_id with user_login before any request, since a mismatched pair returns nothing', async () => {
    const result = await runToolContract(inaturalistSearchObservations, {
      user_id: 1,
      user_login: 'loarie',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'conflicting_observer',
          recovery: { hint: expect.stringContaining('user_id or user_login') },
        },
      },
    });
    expect(fake.searchObservations).not.toHaveBeenCalled();
  });

  it('names the observer and the project in the zero-hit notice only when each was supplied', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const withBoth = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        ...SILENT_COHORT,
        user_login: 'kueda',
        project_id: 227779,
      }),
      withBoth,
    );

    expect(getEnrichment(withBoth).notice).toBe(
      'No sightings by that observer match the other filters. Confirm user_login with inaturalist_resolve_name type user, or drop it. No sightings in that project match the other filters. Confirm project_id with inaturalist_resolve_name type project, or drop it.',
    );

    const withNeither = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse(SILENT_COHORT),
      withNeither,
    );
    expect(getEnrichment(withNeither).notice).not.toMatch(/observer|project/);
  });

  it('sends ident_user_id and unobserved_by_user_id upstream as an id or a login, never blank', async () => {
    expect(await capturedSearchUrl({ ident_user_id: 205278, project_id: 225392 })).toBe(
      'https://api.inaturalist.org/v1/observations?captive=false&ident_user_id=205278&order=desc&order_by=observed_on&page=1&per_page=10&project_id=225392&quality_grade=research',
    );
    expect(await capturedSearchUrl({ unobserved_by_user_id: 'natureguy' })).toContain(
      '&unobserved_by_user_id=natureguy',
    );
    const blank = await capturedSearchUrl({ ident_user_id: '', unobserved_by_user_id: '' });
    expect(blank).not.toMatch(/ident_user_id|unobserved_by_user_id/);
  });

  it('names the identifier and unobserved-by filters beside the observer when no records match', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        ...SILENT_COHORT,
        user_login: 'kueda',
        ident_user_id: 'ajwright',
        unobserved_by_user_id: 134993,
        project_id: 225392,
      }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toBe(
      'No sightings by that observer match the other filters. Confirm user_login with inaturalist_resolve_name type user, or drop it. No sightings identified by that user match the other filters. Confirm ident_user_id with inaturalist_resolve_name type user, or drop it. No sightings of taxa that user has not observed match the other filters. Confirm unobserved_by_user_id with inaturalist_resolve_name type user, or drop it. No sightings in that project match the other filters. Confirm project_id with inaturalist_resolve_name type project, or drop it.',
    );
  });

  it.each([
    ['ident_user_id', 'Unknown ident_user_id: [zz-no-such-login-xq9]'],
    ['unobserved_by_user_id', 'Unknown unobserved_by_user_id zz-no-such-login-xq9'],
  ] as const)(
    'fails an unknown %s as unknown_user naming that field, on both surfaces',
    async (field, body) => {
      const http = createFetchMock([
        {
          match: /api\.inaturalist\.org\/v1\/observations\?/,
          respond: () =>
            new Response(JSON.stringify({ error: body, status: 422 }), { status: 422 }),
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
        const result = await runToolContract(inaturalistSearchObservations, {
          [field]: 'zz-no-such-login-xq9',
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            message: expect.stringContaining(field),
            data: {
              reason: 'unknown_user',
              recovery: { hint: expect.stringContaining('inaturalist_resolve_name type user') },
            },
          },
        });
        expect(JSON.stringify(result.content)).toContain(field);
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
    },
  );

  it('declares unknown_user over all four user selectors', () => {
    const entry = inaturalistSearchObservations.errors?.find(
      (candidate) => candidate.reason === 'unknown_user',
    );
    for (const field of ['user_id', 'user_login', 'ident_user_id', 'unobserved_by_user_id']) {
      expect(entry?.when).toContain(field);
    }
    expect(entry?.recovery).not.toContain('observer');
  });

  it('names user_id rather than user_login when the observer was given by id', async () => {
    fake.searchObservations.mockResolvedValue({ total: 0, observations: [] });
    const ctx = createMockContext({ errors: inaturalistSearchObservations.errors });
    await inaturalistSearchObservations.handler(
      inaturalistSearchObservations.input.parse({
        ...SILENT_COHORT,
        user_id: 1,
      }),
      ctx,
    );

    expect(getEnrichment(ctx).notice).toContain('Confirm user_id with inaturalist_resolve_name');
  });

  it('surfaces an unknown observer as unknown_user with the resolve_name recovery, on both surfaces', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () =>
          new Response(
            JSON.stringify({ error: 'Unknown user_id zz-no-such-login-xq9', status: 422 }),
            { status: 422 },
          ),
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
      const result = await runToolContract(inaturalistSearchObservations, {
        user_login: 'zz-no-such-login-xq9',
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'unknown_user',
            recovery: { hint: expect.stringContaining('inaturalist_resolve_name') },
          },
        },
      });
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('');
      expect(text).toContain('inaturalist_resolve_name');
      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

describe('licence-code filters', () => {
  it('sends license and photo_license upstream as comma-joined OR lists', async () => {
    const url = await capturedSearchUrl({ license: ['cc-by', 'cc0'], photo_license: ['cc0'] });
    const params = new URL(url).searchParams;

    expect(params.get('license')).toBe('cc-by,cc0');
    expect(params.get('photo_license')).toBe('cc0');
  });

  it('lowercases a case variant before the enum, the way upstream reads it', () => {
    const input = inaturalistSearchObservations.input.parse({
      license: ['CC0', 'CC-BY'],
      photo_license: ['Cc-By-Nc'],
    });

    expect(input.license).toEqual(['cc0', 'cc-by']);
    expect(input.photo_license).toEqual(['cc-by-nc']);
  });

  it('rejects a value outside the seven codes at the schema — upstream narrows it to zero', () => {
    for (const value of ['null', 'bogus', 'cc_by', '']) {
      expect(inaturalistSearchObservations.input.safeParse({ license: [value] }).success).toBe(
        false,
      );
      expect(
        inaturalistSearchObservations.input.safeParse({ photo_license: [value] }).success,
      ).toBe(false);
    }
  });

  it('leaves the licensed and photo_licensed booleans working beside the codes', async () => {
    const params = new URL(
      await capturedSearchUrl({ licensed: true, photo_licensed: true, license: ['cc0'] }),
    ).searchParams;

    expect(params.get('licensed')).toBe('true');
    expect(params.get('photo_licensed')).toBe('true');
    expect(params.get('license')).toBe('cc0');
  });
});

/**
 * Search records never carry the by-id detail arm. This runs the real service
 * and projection behind a strict fetch mock with an upstream record that holds a
 * description, many filled observation fields, and a long thread, and checks
 * none of it reaches either surface of a search reply.
 */
describe('search records stay free of the by-id detail fields', () => {
  it('carries no description, observation fields, or thread counts, and renders none of them', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () =>
          Response.json({
            total_results: 1,
            results: [
              rawObservation({
                id: 5890862,
                description: 'Confirm?',
                ofvs: Array.from({ length: 60 }, (_, i) => ({ name: `Field ${i}`, value: 'x' })),
                identifications: Array.from({ length: 60 }, (_, i) =>
                  rawIdentification({ id: i + 1, hidden: i % 2 === 0 }),
                ),
              }),
            ],
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
      const result = await runToolContract(inaturalistSearchObservations, { place_id: 46 });

      expect(result.isError).toBeFalsy();
      const [record] = (result.structuredContent as { observations: Record<string, unknown>[] })
        .observations;
      for (const key of [
        'description',
        'observation_fields',
        'observation_fields_total',
        'observation_fields_shown',
        'identifications',
        'identifications_total',
        'identifications_shown',
        'identifications_hidden',
        'comments_total',
        'comments_hidden',
      ]) {
        expect(record).not.toHaveProperty(key);
      }
      expect(
        inaturalistSearchObservations.output.shape.observations.element.shape,
      ).not.toHaveProperty('identifications_hidden');
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(text).not.toContain('Observer’s description');
      expect(text).not.toContain('### Observation fields');
      expect(text).not.toContain('### Identification thread');
      expect(text).not.toContain('_hidden');
    } finally {
      http.restore();
    }
  });
});

describe('outlinks on search records', () => {
  it('relays each record’s outlinks in upstream order on both surfaces, through the real service', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/observations\?/,
        respond: () =>
          Response.json({
            total_results: 3,
            results: [
              rawObservation({
                id: 5890862,
                outlinks: [
                  { source: 'GBIF', url: 'http://www.gbif.org/occurrence/2006102216' },
                  { source: 'GloBI', url: 'http://www.globalbioticinteractions.org/?a=1&b=2' },
                ],
              }),
              rawObservation({ id: 412088410, outlinks: [] }),
              (({ outlinks: _omitted, ...rest }) => ({ ...rest, id: 7 }))(rawObservation()),
            ],
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
      const result = await runToolContract(inaturalistSearchObservations, { place_id: 46 });

      expect(result.isError).toBeFalsy();
      const [linked, empty, unkeyed] = (
        result.structuredContent as { observations: Record<string, unknown>[] }
      ).observations;
      expect(linked?.outlinks).toEqual([
        { source: 'GBIF', url: 'http://www.gbif.org/occurrence/2006102216' },
        { source: 'GloBI', url: 'http://www.globalbioticinteractions.org/?a=1&b=2' },
      ]);
      expect(empty?.outlinks).toEqual([]);
      expect(unkeyed).not.toHaveProperty('outlinks');
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      expect(text).toContain(
        '**Outlinks:** [GBIF](<http://www.gbif.org/occurrence/2006102216>) · [GloBI](<http://www.globalbioticinteractions.org/?a=1&b=2>)',
      );
      expect(text.split('**Outlinks:** none')).toHaveLength(2);
      expect(text.split('**Outlinks:**')).toHaveLength(3);
    } finally {
      http.restore();
    }
  });
});
