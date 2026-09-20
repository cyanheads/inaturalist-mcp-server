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
      cap: 10,
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('No place covers that box');
  });

  it('discloses truncation once the page fills per_page', async () => {
    fake.nearbyPlaces.mockResolvedValue({
      total: 100,
      standard: Array.from({ length: 10 }, (_, i) => projectedPlace({ id: i })),
      community: [],
    });
    const ctx = createMockContext({ errors: inaturalistFindPlaces.errors });
    const input = inaturalistFindPlaces.input.parse({ ...bbox, per_page: 10 });

    await inaturalistFindPlaces.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toContain('Raise per_page');
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
});
