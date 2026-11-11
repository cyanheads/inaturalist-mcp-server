/**
 * @fileoverview Tests for inaturalist_get_taxon — the not_found and
 * unknown_section contracts, the sections_applied enrichment, the
 * outline-on-overflow arm on a fabricated oversized document (the six named
 * sections plus the virtual summary group, and the re-call notice), the
 * sections re-call path (requested keys plus alwaysKeep), the kind:'full'
 * path on a normal-sized document, and format() for both arms.
 * @module tests/mcp-server/tools/definitions/inaturalist-get-taxon.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistGetTaxon } from '@/mcp-server/tools/definitions/inaturalist-get-taxon.tool.js';
import {
  getINaturalistService,
  INaturalistService,
} from '@/services/inaturalist/inaturalist-service.js';
import type { ConservationStatus } from '@/services/inaturalist/types.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { projectedTaxonDocument, rawTaxonDocument } from '../../../helpers/fixtures.js';
import { markdownNodes, markdownText } from '../../../helpers/rendering-commonmark.js';

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

/** 300 synthetic listings — large enough alone to push the document past the
 * 24,000-byte default outline budget, while every other section stays small. */
function oversizedConservationStatuses(count: number): ConservationStatus[] {
  return Array.from({ length: count }, (_, i) => ({
    status: `Status text ${i} — a longer authority-specific description of concern level`,
    authority: `Authority Body Number ${i}`,
    iucn: 30,
    iucn_code: 'VU' as const,
    place: `Place Region ${i}`,
    url: `https://example.test/conservation/status/${i}`,
  }));
}

/**
 * Every client loads these strings each session, so they state what the field
 * does and point at the next tool, never how upstream misbehaves or how large
 * its payload is.
 */
describe('advertised descriptions', () => {
  it('keeps the outline contract and the resolve pointer without narrating payload size', () => {
    const description = inaturalistGetTaxon.description;
    expect(description).not.toContain('95 KB');
    expect(description).not.toContain('projected before anything else happens');
    expect(description).toContain('inaturalist_resolve_name');
    expect(description).toContain('outline of its sections with their byte sizes');
    expect(description).toContain(
      'summary, taxonomy, children, conservation, photos, and encyclopedia',
    );
  });

  it('states the taxon_id constraint and pointer without the upstream 422 wiring', () => {
    const field = inaturalistGetTaxon.input.shape.taxon_id;
    expect(field.description).not.toContain('422');
    expect(field.description).not.toContain('upstream');
    expect(field.description).toContain('inaturalist_resolve_name');
    expect(field.safeParse(1.5).success).toBe(false);
    expect(field.safeParse(0).success).toBe(false);
    expect(field.safeParse(48662).success).toBe(true);
  });
});

describe('not_found', () => {
  it('throws not_found when upstream returns an empty results array', async () => {
    fake.getTaxon.mockResolvedValue(null);
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 999_999_999 });

    await expect(inaturalistGetTaxon.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });
});

/** The hint `INaturalistService.consumeBudget()` throws once the daily budget is spent. */
const BUDGET_HINT =
  'The upstream daily request allowance is spent; retry after the next UTC midnight, or raise INATURALIST_DAILY_REQUEST_BUDGET only if this deployment does not share an egress IP.';

describe('rate_budget_exhausted', () => {
  it('declares the service-thrown daily budget refusal inline', () => {
    expect(inaturalistGetTaxon.errors).toContainEqual({
      reason: 'rate_budget_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'This server has spent its daily iNaturalist request budget for the current UTC day.',
      recovery: BUDGET_HINT,
      retryable: false,
      thrownBy: 'service',
    });
  });

  it('keeps -32003, retryable false, and the service hint on the wire once the budget is spent', async () => {
    const http = createFetchMock([
      {
        match: /api\.inaturalist\.org\/v1\/taxa\/48662/,
        respond: () => Response.json({ total_results: 1, results: [rawTaxonDocument()] }),
      },
      {
        match: /api\.inaturalist\.org\/v1\/taxa\/48663/,
        respond: () => Response.json({ total_results: 1, results: [rawTaxonDocument()] }),
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
      expect((await runToolContract(inaturalistGetTaxon, { taxon_id: 48662 })).isError).toBeFalsy();
      const spent = await runToolContract(inaturalistGetTaxon, { taxon_id: 48663 });

      expect(spent.isError).toBe(true);
      expect(spent.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'rate_budget_exhausted',
            retryable: false,
            recovery: { hint: BUDGET_HINT },
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
 * The handler's return type is a union (the outline arm resolves synchronously),
 * so awaiting it in a try/catch is what reaches the thrown message.
 */
async function rejectionMessage(
  input: Parameters<typeof inaturalistGetTaxon.handler>[0],
  ctx: Parameters<typeof inaturalistGetTaxon.handler>[1],
): Promise<string> {
  try {
    await inaturalistGetTaxon.handler(input, ctx);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the handler to reject.');
}

describe('unknown_section', () => {
  it('throws unknown_section for a name the projected document does not carry, without calling the service', async () => {
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({
      taxon_id: 48662,
      sections: ['nonexistent'],
    });

    await expect(inaturalistGetTaxon.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_section' },
    });
    expect(fake.getTaxon).not.toHaveBeenCalled();
  });

  /**
   * `sections` is an unbounded array of unbounded strings, and the rejection
   * message named every unknown entry — mirroring the caller's whole input back
   * into `content[]` and `structuredContent.error` for the agent to read.
   */
  it('bounds the rejection message instead of echoing the whole rejected array', async () => {
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({
      taxon_id: 48662,
      sections: Array.from({ length: 500 }, (_, i) => `bogus-${i}-${'x'.repeat(200)}`),
    });

    const message = await rejectionMessage(input, ctx);

    expect(message.length).toBeLessThan(600);
    // It still has to say what the caller may ask for.
    expect(message).toContain('summary');
    expect(message).toContain('encyclopedia');
  });

  it('still names the unknown section when there is only one', async () => {
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({
      taxon_id: 48662,
      sections: ['nonexistent'],
    });

    const message = await rejectionMessage(input, ctx);

    expect(message).toContain('nonexistent');
  });
});

describe('kind: full on a normal-sized document', () => {
  it('returns the whole projected document with kind: full', async () => {
    fake.getTaxon.mockResolvedValue(projectedTaxonDocument());
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 48662 });

    const result = await inaturalistGetTaxon.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result).toMatchObject({ id: 48662, name: 'Danaus plexippus' });
    expect(getEnrichment(ctx).sections_applied).toEqual([]);
  });
});

describe('the outline arm on a fabricated oversized document', () => {
  it('overflows to kind: outline with the six named sections and a re-call notice', async () => {
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        conservation: { statuses: oversizedConservationStatuses(300), global_status: null },
      }),
    );
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 48662 });

    const result = await inaturalistGetTaxon.handler(input, ctx);

    expect(result.kind).toBe('outline');
    expect(result.id).toBeUndefined();
    expect(result.sections?.map((s) => s.name).sort()).toEqual(
      ['children', 'conservation', 'encyclopedia', 'photos', 'summary', 'taxonomy'].sort(),
    );
    // Sections are sorted largest-first, and the fabricated conservation
    // array dwarfs every other section.
    expect(result.sections?.[0]?.name).toBe('conservation');
    expect(typeof result.notice).toBe('string');
    expect(result.notice).toBeTruthy();
  });

  it('sets sections_applied to empty on the outline arm — nothing was named yet', async () => {
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        conservation: { statuses: oversizedConservationStatuses(300), global_status: null },
      }),
    );
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 48662 });

    await inaturalistGetTaxon.handler(input, ctx);

    expect(getEnrichment(ctx).sections_applied).toEqual([]);
  });
});

describe('the sections re-call path', () => {
  it('returns only the requested section plus the always-kept identity keys', async () => {
    const doc = projectedTaxonDocument();
    fake.getTaxon.mockResolvedValue(doc);
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 48662, sections: ['photos'] });

    const result = await inaturalistGetTaxon.handler(input, ctx);

    expect(result).toEqual({
      kind: 'full',
      id: doc.id,
      name: doc.name,
      rank: doc.rank,
      photos: doc.photos,
    });
  });

  it('sets sections_applied to exactly what was requested', async () => {
    fake.getTaxon.mockResolvedValue(projectedTaxonDocument());
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({
      taxon_id: 48662,
      sections: ['photos', 'children'],
    });

    await inaturalistGetTaxon.handler(input, ctx);

    expect(getEnrichment(ctx).sections_applied).toEqual(['photos', 'children']);
  });

  it('expands the virtual "summary" section to the twelve root scalars', async () => {
    const doc = projectedTaxonDocument();
    fake.getTaxon.mockResolvedValue(doc);
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });
    const input = inaturalistGetTaxon.input.parse({ taxon_id: 48662, sections: ['summary'] });

    const result = await inaturalistGetTaxon.handler(input, ctx);

    expect(result).toEqual({
      kind: 'full',
      id: doc.id,
      name: doc.name,
      rank: doc.rank,
      rank_level: doc.rank_level,
      common_name: doc.common_name,
      iconic_taxon_name: doc.iconic_taxon_name,
      is_active: doc.is_active,
      current_synonymous_taxon_ids: doc.current_synonymous_taxon_ids,
      extinct: doc.extinct,
      observations_count: doc.observations_count,
      listed_taxa_count: doc.listed_taxa_count,
      vision: doc.vision,
    });
    expect(result).not.toHaveProperty('taxonomy');
    expect(result).not.toHaveProperty('photos');
  });

  /** 21373 (Bufo bufo) is inactive since its split into 134693 and 326296. */
  it.each([
    [undefined, true],
    [['summary'], true],
    [['children'], false],
  ] as const)(
    'with sections %j, carries an inactive taxon’s successors on both surfaces: %s',
    async (sections, carried) => {
      fake.getTaxon.mockResolvedValue(
        projectedTaxonDocument({
          id: 21373,
          name: 'Bufo bufo',
          is_active: false,
          current_synonymous_taxon_ids: [134693, 326296],
        }),
      );
      const result = await runToolContract(inaturalistGetTaxon, {
        taxon_id: 21373,
        ...(sections ? { sections: [...sections] } : {}),
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content ?? [])
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
      if (carried) {
        expect(result.structuredContent).toMatchObject({
          is_active: false,
          current_synonymous_taxon_ids: [134693, 326296],
        });
        expect(text).toContain(
          'is_active false · current_synonymous_taxon_ids 134693, 326296 (pass one as taxon_id for the current taxon)',
        );
      } else {
        expect(result.structuredContent).not.toHaveProperty('current_synonymous_taxon_ids');
        expect(text).not.toContain('current_synonymous_taxon_ids');
      }
    },
  );

  it('re-fetches the document rather than reusing a prior outline call', async () => {
    fake.getTaxon.mockResolvedValue(projectedTaxonDocument());
    const ctx = createMockContext({ errors: inaturalistGetTaxon.errors });

    await inaturalistGetTaxon.handler(inaturalistGetTaxon.input.parse({ taxon_id: 48662 }), ctx);
    await inaturalistGetTaxon.handler(
      inaturalistGetTaxon.input.parse({ taxon_id: 48662, sections: ['photos'] }),
      ctx,
    );

    expect(fake.getTaxon).toHaveBeenCalledTimes(2);
  });
});

describe('format()', () => {
  it('relays literal encyclopedia text and its URL on both surfaces', async () => {
    const summary = '  <b>literal</b> &amp; *text*\r\n\nend\n';
    const url = 'https://example.test/a_(b)?q=&amp;';
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        encyclopedia: { wikipedia_summary: summary, wikipedia_url: url },
      }),
    );
    const result = await runToolContract(inaturalistGetTaxon, {
      taxon_id: 48662,
      sections: ['encyclopedia'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      encyclopedia: { wikipedia_summary: summary, wikipedia_url: url },
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(markdownText(text)).toContain(summary);
    expect(
      markdownNodes(text)
        .filter((node) => node.type === 'link')
        .map((node) => node.destination),
    ).toContain(url);
    expect(markdownNodes(text).filter((node) => node.type === 'html_inline')).toEqual([]);
  });

  it('carries each listing’s iucn_code on both surfaces, and an absent headline status as none published', async () => {
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        id: 7109,
        conservation: {
          statuses: [
            {
              status: 'S3N,S4B',
              authority: 'NatureServe',
              iucn: 30,
              iucn_code: 'VU',
              place: 'Washington, US',
              url: null,
            },
            {
              status: 'LC',
              authority: 'IUCN Red List',
              iucn: 10,
              iucn_code: 'LC',
              place: null,
              url: null,
            },
          ],
          global_status: null,
        },
      }),
    );
    const result = await runToolContract(inaturalistGetTaxon, {
      taxon_id: 7109,
      sections: ['conservation'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      conservation: {
        statuses: [
          { iucn: 30, iucn_code: 'VU' },
          { iucn: 10, iucn_code: 'LC' },
        ],
        global_status: null,
      },
    });
    const text = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      'status S3N,S4B · authority NatureServe · iucn 30 (VU) · place Washington, US',
    );
    expect(text).toContain('iucn 10 (LC) · place global');
    expect(text).toContain('**Global status:** none published');
  });

  it('renders the kind line and the full taxon-document block on the full arm', () => {
    const doc = projectedTaxonDocument();
    const result = { ...doc, kind: 'full' as const };
    const blocks = inaturalistGetTaxon.format?.(result) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');

    expect(text).toContain('**kind:** full');
    expect(text).toContain('## Monarch (Danaus plexippus)');
  });

  it('renders the kind line and the outline block on the outline arm, never the full document', () => {
    const result = {
      kind: 'outline' as const,
      sections: [
        { name: 'conservation', bytes: 40_000 },
        { name: 'summary', bytes: 300 },
      ],
      notice:
        'Re-call this tool with sections:["summary"] (300 bytes, against a 24000-byte budget).',
    };
    const blocks = inaturalistGetTaxon.format?.(result) ?? [];
    const text = blocks.map((b) => ('text' in b ? b.text : '')).join('\n');

    expect(text).toContain('**kind:** outline');
    expect(text).toContain('2 sections available');
    expect(text).toContain('`conservation` — 40000 bytes');
    expect(text).not.toContain('## ');
  });

  it('renders only the identity keys in content[] for a selection that leaves out summary', async () => {
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        id: 47126,
        name: 'Plantae',
        rank: 'kingdom',
        common_name: 'Plants',
      }),
    );

    const result = await runToolContract(inaturalistGetTaxon, {
      taxon_id: 47126,
      sections: ['children'],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('common_name');
    const lines = (result.content ?? [])
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n')
      .split('\n');
    expect(lines.filter((line) => line.startsWith('## '))).toEqual(['## Plantae']);
    expect(lines.filter((line) => line.startsWith('id '))).toEqual([
      'id 47126 · name Plantae · rank kingdom',
    ]);
  });
});
