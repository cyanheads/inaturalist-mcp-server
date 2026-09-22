/**
 * @fileoverview Tests for inaturalist_resolve_name — taxon vs cross-kind
 * routing, the rank_not_applicable contract, the per-condition miss guidance,
 * and format() on both a hit and a miss.
 * @module tests/mcp-server/tools/definitions/inaturalist-resolve-name.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistResolveName } from '@/mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { resolvedCandidate } from '../../../helpers/fixtures.js';

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

describe('routing', () => {
  it('routes type: taxon to autocompleteTaxa and reports the enrichment total', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 42, candidates: [resolvedCandidate()] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'monarch' });

    const result = await inaturalistResolveName.handler(input, ctx);

    expect(fake.autocompleteTaxa).toHaveBeenCalledWith(
      { q: 'monarch', rank: undefined, limit: 10 },
      ctx,
    );
    expect(fake.searchRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ found: true, candidates: [resolvedCandidate()] });
    expect(getEnrichment(ctx).totalCount).toBe(42);
  });

  it('passes rank through only on type: taxon', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 1, candidates: [resolvedCandidate()] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'Danaus', type: 'taxon', rank: 'genus' });

    await inaturalistResolveName.handler(input, ctx);

    expect(fake.autocompleteTaxa).toHaveBeenCalledWith(
      { q: 'Danaus', rank: 'genus', limit: 10 },
      ctx,
    );
  });

  it.each([
    ['place', 'places'],
    ['project', 'projects'],
    ['user', 'users'],
  ] as const)('routes type: %s to searchRecords with sources: %s', async (type, sources) => {
    fake.searchRecords.mockResolvedValue({
      total: 1,
      candidates: [resolvedCandidate({ kind: type })],
    });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'Seattle', type });

    await inaturalistResolveName.handler(input, ctx);

    expect(fake.searchRecords).toHaveBeenCalledWith({ q: 'Seattle', sources, limit: 10 }, ctx);
  });

  it('routes type: any to searchRecords with sources undefined', async () => {
    fake.searchRecords.mockResolvedValue({ total: 1, candidates: [resolvedCandidate()] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'Seattle', type: 'any' });

    await inaturalistResolveName.handler(input, ctx);

    expect(fake.searchRecords).toHaveBeenCalledWith(
      { q: 'Seattle', sources: undefined, limit: 10 },
      ctx,
    );
  });
});

describe('limit', () => {
  function taxa(count: number) {
    return Array.from({ length: count }, (_, i) => resolvedCandidate({ id: i + 1 }));
  }

  it('slices taxon candidates to limit when upstream returns more, keeping the upstream total', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 198, candidates: taxa(4) });

    const result = await runToolContract(inaturalistResolveName, { q: 'monarch', limit: 1 });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      found: boolean;
      candidates: Array<{ id: number }>;
      totalCount: number;
    };
    expect(structured.found).toBe(true);
    expect(structured.candidates.map((candidate) => candidate.id)).toEqual([1]);
    expect(structured.totalCount).toBe(198);
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('**found:** true — 1 candidates');
    expect(text).not.toContain('id 2');
  });

  it('keeps upstream order when slicing past the first few', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 12, candidates: taxa(12) });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'monarch', limit: 10 });

    const result = inaturalistResolveName.output.parse(
      await inaturalistResolveName.handler(input, ctx),
    );

    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('leaves a list already within limit untouched', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 2, candidates: taxa(2) });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'robin', limit: 2 });

    const result = inaturalistResolveName.output.parse(
      await inaturalistResolveName.handler(input, ctx),
    );

    expect(result.found).toBe(true);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([1, 2]);
  });
});

describe('user candidates', () => {
  it('carries the login alongside the display name through the output schema, on both surfaces', async () => {
    fake.searchRecords.mockResolvedValue({
      total: 1,
      candidates: [
        {
          kind: 'user',
          id: 1,
          name: 'Ken-ichi Ueda',
          login: 'kueda',
          matched_term: 'kueda',
          score: 9.75,
          observations_count: 56317,
        },
      ],
    });

    const result = await runToolContract(inaturalistResolveName, { q: 'kueda', type: 'user' });

    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { candidates: Array<Record<string, unknown>> }).candidates[0],
    ).toMatchObject({ kind: 'user', id: 1, name: 'Ken-ichi Ueda', login: 'kueda' });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('login kueda');
  });

  it('describes name without claiming it holds a login', () => {
    const candidate = inaturalistResolveName.output.shape.candidates.element;
    expect(candidate.shape.name.description).not.toContain('or login');
    expect(candidate.shape.login.description).toContain('inaturalist_get_leaderboard');
  });
});

describe('miss guidance', () => {
  it('names the taxon-prefix miss reason when no rank was given', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 0, candidates: [] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'xyzzy' });

    const result = await inaturalistResolveName.handler(input, ctx);

    expect(result).toEqual({
      found: false,
      candidates: [],
      guidance:
        'No taxon name starts with that text — the taxon search matches a name prefix, not words inside a name. Try the scientific name, a shorter prefix, or drop the rank filter.',
    });
  });

  it('names the rank-scoped miss reason when a rank was given', async () => {
    fake.autocompleteTaxa.mockResolvedValue({ total: 0, candidates: [] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'xyzzy', rank: 'genus' });

    const result = await inaturalistResolveName.handler(input, ctx);

    expect(result.guidance).toBe(
      'No taxon of that rank starts with that text. Re-run without rank, or list valid ranks with inaturalist_list_reference topic ranks.',
    );
  });

  it('names the cross-kind miss reason for a non-taxon type', async () => {
    fake.searchRecords.mockResolvedValue({ total: 0, candidates: [] });
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({ q: 'xyzzy', type: 'place' });

    const result = await inaturalistResolveName.handler(input, ctx);

    expect(result.guidance).toBe(
      'No place, project, or observer matched that text. Try fewer words, or set type to any to search every record kind at once.',
    );
  });
});

describe('type any miss guidance', () => {
  it('names every kind any searches and does not suggest setting type to any', async () => {
    fake.searchRecords.mockResolvedValue({ total: 0, candidates: [] });

    const result = await runToolContract(inaturalistResolveName, { q: 'zzqqxx', type: 'any' });

    const guidance = (result.structuredContent as { guidance?: string }).guidance;
    expect(guidance).toBe(
      'Nothing matched that text across taxa, places, projects, or observers. Try fewer words or a different spelling; for an organism, type taxon matches a name prefix.',
    );
    expect(guidance).not.toContain('set type to any');
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
    expect(text).toContain('across taxa, places, projects, or observers');
  });
});

describe('errors', () => {
  it('throws rank_not_applicable when rank is given with a non-taxon type', async () => {
    const ctx = createMockContext({ errors: inaturalistResolveName.errors });
    const input = inaturalistResolveName.input.parse({
      q: 'Seattle',
      type: 'place',
      rank: 'genus',
    });

    await expect(inaturalistResolveName.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'rank_not_applicable' },
    });
    expect(fake.searchRecords).not.toHaveBeenCalled();
  });
});

describe('format()', () => {
  it('renders a taxon candidate heading with common name and photo, no guidance line on a hit', () => {
    const result = {
      found: true,
      candidates: [
        resolvedCandidate({ kind: 'taxon', common_name: 'Monarch', name: 'Danaus plexippus' }),
      ],
    };
    const [block] = inaturalistResolveName.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('found:** true');
    expect(text).toContain('## Monarch (Danaus plexippus)');
    expect(text).toContain('**Photo:**');
  });

  it('renders a place candidate heading from display_name', () => {
    // A place candidate carries none of the taxon-only optional fields — build
    // it directly rather than overriding the taxon-shaped fixture's fields to
    // undefined (disallowed under exactOptionalPropertyTypes).
    const result = {
      found: true,
      candidates: [
        {
          kind: 'place' as const,
          id: 1,
          name: 'Seattle',
          display_name: 'Seattle, WA, US',
        },
      ],
    };
    const [block] = inaturalistResolveName.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('## Seattle, WA, US');
  });

  it('renders the miss guidance as its own trailing paragraph', () => {
    const result = { found: false, candidates: [], guidance: 'No match at all.' };
    const [block] = inaturalistResolveName.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('No match');
    expect(text.trim().endsWith('No match at all.')).toBe(true);
  });

  /**
   * The cross-kind search reaches member-created projects and places, so a
   * candidate's name, display name, and matched term are all third-party text
   * rendered into a heading and an inline metadata line.
   */
  it('does not let a member-created record name forge a heading', () => {
    const FORGERY = '## Forged heading';
    const result = {
      found: true,
      candidates: [
        {
          kind: 'project' as const,
          id: 7,
          name: `Bioblitz\n${FORGERY}`,
          display_name: `Bioblitz\r${FORGERY}`,
          slug: `bioblitz\n${FORGERY}`,
          matched_term: `Bioblitz\n${FORGERY}`,
        },
      ],
    };
    const [block] = inaturalistResolveName.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text.split(/\r\n|[\r\n]/).filter((line) => line.startsWith(FORGERY))).toEqual([]);
  });
});
