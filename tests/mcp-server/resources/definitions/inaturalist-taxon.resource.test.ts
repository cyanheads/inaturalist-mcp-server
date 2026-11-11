/**
 * @fileoverview Tests for the inaturalist://taxa/{taxon_id} resource — the
 * happy path (the full projected taxon document, never the outline arm), the
 * declared not_found miss with its recovery hint, and the taxon_id path-param schema
 * rejecting a value that is not a positive integer.
 * @module tests/mcp-server/resources/definitions/inaturalist-taxon.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistTaxonResource } from '@/mcp-server/resources/definitions/inaturalist-taxon.resource.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { projectedTaxonDocument } from '../../../helpers/fixtures.js';

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
  it('retains literal HTML, entities, and separators in its JSON representation', async () => {
    const summary = '  <b>literal</b> &amp;\r\n\nend\n';
    const doc = projectedTaxonDocument({
      encyclopedia: { wikipedia_summary: summary, wikipedia_url: 'https://example.test/?q=&amp;' },
    });
    fake.getTaxon.mockResolvedValue(doc);
    const result = await inaturalistTaxonResource.handler(
      { taxon_id: '48662' },
      createMockContext({ errors: inaturalistTaxonResource.errors }),
    );
    expect(inaturalistTaxonResource.mimeType).toBe('application/json');
    expect(inaturalistTaxonResource.format).toBeUndefined();
    expect(
      JSON.parse(JSON.stringify(inaturalistTaxonResource.output?.parse(result))),
    ).toMatchObject({
      encyclopedia: { wikipedia_summary: summary, wikipedia_url: 'https://example.test/?q=&amp;' },
    });
  });

  it('carries iucn_code on every listing and on the global status through its output schema', async () => {
    const listing = {
      status: 'S3N,S4B',
      authority: 'NatureServe',
      iucn: 30,
      iucn_code: 'VU' as const,
      place: 'Washington, US',
      url: null,
    };
    const doc = projectedTaxonDocument({
      conservation: {
        statuses: [listing, { ...listing, iucn: 35, iucn_code: null }],
        global_status: { ...listing, place: null },
      },
    });
    fake.getTaxon.mockResolvedValue(doc);
    const result = await inaturalistTaxonResource.handler(
      { taxon_id: '7109' },
      createMockContext({ errors: inaturalistTaxonResource.errors }),
    );
    const parsed = inaturalistTaxonResource.output?.parse(result);
    expect(parsed).toMatchObject({
      conservation: {
        statuses: [
          { iucn: 30, iucn_code: 'VU' },
          { iucn: 35, iucn_code: null },
        ],
        global_status: { iucn: 30, iucn_code: 'VU' },
      },
    });
  });

  it('carries an inactive taxon’s successor ids through its output schema', async () => {
    fake.getTaxon.mockResolvedValue(
      projectedTaxonDocument({
        id: 21373,
        is_active: false,
        current_synonymous_taxon_ids: [134693, 326296],
      }),
    );
    const result = await inaturalistTaxonResource.handler(
      { taxon_id: '21373' },
      createMockContext({ errors: inaturalistTaxonResource.errors }),
    );
    expect(inaturalistTaxonResource.output?.parse(result)).toMatchObject({
      is_active: false,
      current_synonymous_taxon_ids: [134693, 326296],
    });
  });

  it('returns the whole projected document, with no section-selection arm', async () => {
    const doc = projectedTaxonDocument();
    fake.getTaxon.mockResolvedValue(doc);
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: inaturalistTaxonResource.errors,
    });
    const params = inaturalistTaxonResource.params!.parse({ taxon_id: '48662' });

    const result = await inaturalistTaxonResource.handler(params, ctx);

    expect(result).toEqual(doc);
    expect(fake.getTaxon).toHaveBeenCalledWith(48662, ctx);
  });
});

describe('miss', () => {
  /**
   * The read answers through the framework's resource factory, which fills
   * `data.recovery.hint` from the declared entry for the thrown reason; a
   * client branches on `data.reason` as it does on the tools.
   */
  it('throws the declared not_found reason, keeping the taxon id', async () => {
    fake.getTaxon.mockResolvedValue(null);
    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: inaturalistTaxonResource.errors,
    });
    const params = inaturalistTaxonResource.params!.parse({ taxon_id: '999999999' });

    let error: unknown;
    try {
      await inaturalistTaxonResource.handler(params, ctx);
    } catch (e) {
      error = e;
    }

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', taxon_id: 999_999_999 },
    });
  });

  it('declares not_found with the recovery the read carries onto the wire', () => {
    expect(inaturalistTaxonResource.errors).toEqual([
      {
        reason: 'not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'iNaturalist answered with an empty results array for that taxon id.',
        recovery:
          'Resolve the organism name with inaturalist_resolve_name and read the resource at the taxon id it returns.',
      },
    ]);
  });
});

describe('params schema', () => {
  it('accepts a positive-integer taxon_id string', () => {
    expect(() => inaturalistTaxonResource.params!.parse({ taxon_id: '48662' })).not.toThrow();
  });

  it('rejects a taxon_id of "0", which is not a positive integer', () => {
    expect(() => inaturalistTaxonResource.params!.parse({ taxon_id: '0' })).toThrow();
  });

  it('rejects a non-numeric taxon_id', () => {
    expect(() => inaturalistTaxonResource.params!.parse({ taxon_id: 'abc' })).toThrow();
  });
});
