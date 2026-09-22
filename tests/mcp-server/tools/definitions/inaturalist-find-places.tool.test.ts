/**
 * @fileoverview Tests for inaturalist_find_places — the name-prefix arm, the
 * bounding-box arm, the invalid_geography contract across every combination
 * the design names, truncation disclosure, and format()'s split standard vs
 * community sections.
 * @module tests/mcp-server/tools/definitions/inaturalist-find-places.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistFindPlaces } from '@/mcp-server/tools/definitions/inaturalist-find-places.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { failingUpstream } from '../../../helpers/failing-upstream.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { projectedPlace } from '../../../helpers/fixtures.js';

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

describe('name-prefix arm', () => {
  it('resolves a place name via autocompletePlaces', async () => {
    fake.autocompletePlaces.mockResolvedValue({ total: 1, places: [projectedPlace()] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: 'Seattle' });

    const result = await inaturalistFindPlaces.handler(input, ctx);

    expect(fake.autocompletePlaces).toHaveBeenCalledWith('Seattle', ctx);
    expect(result).toEqual({ places: [projectedPlace()] });
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('reports a notice on zero matches', async () => {
    fake.autocompletePlaces.mockResolvedValue({ total: 0, places: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: 'zzzznotaplace' });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('No place name starts with that text');
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    // getEnrichment reads an unvalidated accumulator, so only the result builder
    // — which parses output.extend(enrichment) — catches a required enrichment
    // field the handler never wrote.
    fake.autocompletePlaces.mockResolvedValue({ total: 0, places: [] });

    const result = await runToolContract(inaturalistFindPlaces, { q: 'zzzznotaplace' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      places: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 0,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No place name starts with that text');
  });

  it('reports the fixed upstream page as the cap when it did not truncate', async () => {
    fake.autocompletePlaces.mockResolvedValue({
      total: 2,
      places: [projectedPlace({ id: 1 }), projectedPlace({ id: 2 })],
    });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: 'Seattle' });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: false, shown: 2, cap: 2 });
  });

  it('discloses truncation when the fixed page of 10 is smaller than the total matched', async () => {
    fake.autocompletePlaces.mockResolvedValue({
      total: 45,
      places: Array.from({ length: 10 }, (_, i) => projectedPlace({ id: i })),
    });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: 'Seattle' });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toContain('fixed page of 10');
  });
});

describe('bounding-box arm', () => {
  const bbox = { nelat: 47.7, nelng: -122.2, swlat: 47.5, swlng: -122.4 };

  it('resolves places covering a map area via nearbyPlaces', async () => {
    fake.nearbyPlaces.mockResolvedValue({
      total: 2,
      standard: [projectedPlace()],
      community: [projectedPlace({ id: 2 })],
    });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse(bbox);

    const result = await inaturalistFindPlaces.handler(input, ctx);

    expect(fake.nearbyPlaces).toHaveBeenCalledWith(bbox, 10, ctx);
    expect(result).toEqual({
      standard: [projectedPlace()],
      community: [projectedPlace({ id: 2 })],
    });
  });

  it('reports a notice when nothing covers the box', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 0, standard: [], community: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse(bbox);

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('No place covers that box');
  });

  it('carries the zero-result disclosure through the effective-output parse, on both surfaces', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 0, standard: [], community: [] });

    const result = await runToolContract(inaturalistFindPlaces, { ...bbox, per_page: 10 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      standard: [],
      community: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 20,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No place covers that box');
  });

  function places(count: number, idOffset = 0) {
    return Array.from({ length: count }, (_, i) => projectedPlace({ id: idOffset + i }));
  }

  it('discloses truncation once one list fills per_page, against a cap of per_page × 2', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 10, standard: places(10), community: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ ...bbox, per_page: 10 });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 10, cap: 20 });
    expect(getEnrichment(ctx).notice).toContain('Raise per_page');
  });

  it('flags truncation when both lists independently hit per_page, with shown equal to cap', async () => {
    fake.nearbyPlaces.mockResolvedValue({
      total: 10,
      standard: places(5),
      community: places(5, 100),
    });

    const result = await runToolContract(inaturalistFindPlaces, { ...bbox, per_page: 5 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalCount: 10,
      truncated: true,
      shown: 10,
      cap: 10,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('standard and community lists each reached per_page 5');
  });

  it('flags truncation on the one list that reached per_page, never exceeding cap', async () => {
    fake.nearbyPlaces.mockResolvedValue({
      total: 9,
      standard: places(4),
      community: places(5, 100),
    });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ ...bbox, per_page: 5 });

    await inaturalistFindPlaces.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 9, cap: 10, totalCount: 9 });
    expect(enrichment.notice).toContain('community list reached per_page 5');
  });

  it('does not flag truncation when both lists sit below per_page, however large shown is', async () => {
    fake.nearbyPlaces.mockResolvedValue({
      total: 7,
      standard: places(4),
      community: places(3, 100),
    });

    const result = await runToolContract(inaturalistFindPlaces, { ...bbox, per_page: 5 });

    expect(result.structuredContent).toMatchObject({ truncated: false, shown: 7, cap: 10 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('points at shrinking the box rather than raising per_page once per_page is at its maximum', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 30, standard: places(30), community: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ ...bbox, per_page: 30 });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 30, cap: 60 });
    expect(getEnrichment(ctx).notice).not.toContain('Raise per_page');
    expect(getEnrichment(ctx).notice).toContain('Shrink the box');
  });

  it('treats a blank q from a form client as unset and serves the bounding-box arm', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 1, standard: places(1), community: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: '', ...bbox });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(input.q).toBeUndefined();
    expect(fake.nearbyPlaces).toHaveBeenCalledWith(bbox, 10, ctx);
    expect(fake.autocompletePlaces).not.toHaveBeenCalled();
  });

  it('accepts an antimeridian-crossing box, where nelng is west of swlng', async () => {
    fake.nearbyPlaces.mockResolvedValue({ total: 1, standard: places(1), community: [] });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const box = { nelat: 66, nelng: -170, swlat: 52, swlng: 170 };
    const input = inaturalistFindPlaces.input.parse(box);

    await inaturalistFindPlaces.handler(input, ctx);

    expect(fake.nearbyPlaces).toHaveBeenCalledWith(box, 10, ctx);
  });

  it('rejects a box whose nelat is south of swlat with no request and no retry', {
    timeout: 30_000,
  }, async () => {
    const { http, service } = failingUpstream();
    vi.mocked(getINaturalistService).mockReturnValue(service);
    http.install();
    try {
      const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
      const input = inaturalistFindPlaces.input.parse({
        nelat: 37,
        nelng: -120,
        swlat: 38,
        swlng: -121,
      });

      await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'invalid_geography',
          recovery: { hint: expect.stringContaining('nelat at or north of swlat') },
        },
      });
      expect(http.calls).toHaveLength(0);
    } finally {
      http.restore();
    }
  });
});

describe('invalid_geography', () => {
  it('rejects a place-name query combined with any bounding-box corner', async () => {
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: 'Seattle', nelat: 47.7 });

    await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('rejects a partial bounding box (some but not all four corners)', async () => {
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ nelat: 47.7, nelng: -122.2 });

    await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('still rejects a non-blank q combined with a bounding-box corner', async () => {
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({
      q: 'Seattle',
      nelat: 47.7,
      nelng: -122.2,
      swlat: 47.5,
      swlng: -122.4,
    });

    await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('still bounds a non-blank q to 1–100 characters', () => {
    expect(inaturalistFindPlaces.input.safeParse({ q: 'S' }).success).toBe(true);
    expect(inaturalistFindPlaces.input.safeParse({ q: 'x'.repeat(100) }).success).toBe(true);
    expect(inaturalistFindPlaces.input.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });

  it('treats a blank q with no box as neither arm', async () => {
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ q: '' });

    await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
  });

  it('rejects neither q nor any corner being given', async () => {
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({});

    await expect(inaturalistFindPlaces.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_geography' },
    });
    expect(fake.autocompletePlaces).not.toHaveBeenCalled();
    expect(fake.nearbyPlaces).not.toHaveBeenCalled();
  });
});

describe('format()', () => {
  it('renders the name-prefix arm as a flat list with no Standard/Community split', () => {
    const [block] = inaturalistFindPlaces.format?.({ places: [projectedPlace()] }) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('## Seattle, WA, US');
    expect(text).not.toContain('### Standard places');
  });

  it('renders the bounding-box arm as separate Standard and Community sections', () => {
    const [block] =
      inaturalistFindPlaces.format?.({
        standard: [projectedPlace()],
        community: [projectedPlace({ id: 2, display_name: 'A community place' })],
      }) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('### Standard places');
    expect(text).toContain('### Community places');
    expect(text.indexOf('### Standard places')).toBeLessThan(text.indexOf('### Community places'));
  });

  it('renders the bounding box, centre, and containment chain for a place', () => {
    const [block] = inaturalistFindPlaces.format?.({ places: [projectedPlace()] }) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('SW 47.5, -122.4 → NE 47.7, -122.2');
    expect(text).toContain('**Centre:** 47.6062, -122.3321');
    expect(text).toContain('97394 › 1');
  });

  it('reports "not published" fallbacks for a sparse place', () => {
    const sparse = projectedPlace({
      bbox: null,
      location: null,
      ancestor_place_ids: [],
      slug: null,
    });
    const [block] = inaturalistFindPlaces.format?.({ places: [sparse] }) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**Bounding box:** not published');
    expect(text).toContain('**Centre:** not published');
    expect(text).toContain('no containment chain recorded');
  });

  /**
   * The community arm of a nearby lookup is member-created place records, so
   * their names are third-party strings rendered straight into a heading.
   */
  it('does not let a member-created place name forge a heading', () => {
    const FORGERY = '## Forged heading';
    const hostile = projectedPlace({
      display_name: `Marsh\n${FORGERY}`,
      name: `Marsh\r${FORGERY}`,
      slug: `marsh\n${FORGERY}`,
    });
    const [block] = inaturalistFindPlaces.format?.({ standard: [], community: [hostile] }) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text.split(/\r\n|[\r\n]/).filter((line) => line.startsWith(FORGERY))).toEqual([]);
  });
});
