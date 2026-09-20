/**
 * @fileoverview Tests for the inaturalist://taxa/{taxon_id} resource — the
 * happy path (the full projected taxon document, never the outline arm), the
 * notFound() miss with its recovery hint, and the taxon_id path-param schema
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
  it('returns the whole projected document, with no section-selection arm', async () => {
    const doc = projectedTaxonDocument();
    fake.getTaxon.mockResolvedValue(doc);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = inaturalistTaxonResource.params!.parse({ taxon_id: '48662' });

    const result = await inaturalistTaxonResource.handler(params, ctx);

    expect(result).toEqual(doc);
    expect(fake.getTaxon).toHaveBeenCalledWith(48662, ctx);
  });
});

describe('miss', () => {
  it('throws notFound with a recovery hint pointing at inaturalist_resolve_name', async () => {
    fake.getTaxon.mockResolvedValue(null);
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = inaturalistTaxonResource.params!.parse({ taxon_id: '999999999' });

    let error: unknown;
    try {
      await inaturalistTaxonResource.handler(params, ctx);
    } catch (e) {
      error = e;
    }

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        taxon_id: 999_999_999,
        recovery: { hint: expect.stringContaining('inaturalist_resolve_name') },
      },
    });
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
