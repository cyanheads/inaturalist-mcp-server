/**
 * @fileoverview Tests for inaturalist_list_reference — the static vocabulary
 * arm, the live controlled_terms arm (with and without observed usage), the
 * taxon_id_not_applicable contract, and format() parity on both surfaces.
 * @module tests/mcp-server/tools/definitions/inaturalist-list-reference.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inaturalistListReference } from '@/mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import {
  asService,
  createFakeService,
  resetFakeService,
} from '../../../helpers/fake-inaturalist-service.js';
import { controlledTerm, observedUsage } from '../../../helpers/fixtures.js';

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

describe('static topics', () => {
  it('serves quality_grades statically, without touching the service', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'quality_grades' });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result.source).toBe('static');
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every((entry) => entry.code !== undefined)).toBe(true);
    expect(fake.getControlledTerms).not.toHaveBeenCalled();
  });

  it('serves the 14-entry iconic_taxa table', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'iconic_taxa' });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(inaturalistListReference.output));
    expect(result.entries).toHaveLength(14);
  });

  it('renders a header line and one bullet per static entry, with notes indented beneath', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'licenses' });
    const result = await inaturalistListReference.handler(input, ctx);
    const [block] = inaturalistListReference.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('**licenses** — source: static');
    expect(text).toContain('code `cc0`');
    const nullEntryLine = text.split('\n').find((line) => line.includes('All rights reserved'));
    expect(nullEntryLine).toContain('code `null`');
  });
});

describe('controlled_terms (live) topic', () => {
  it('fetches the vocabulary from the service when taxon_id is omitted', async () => {
    fake.getControlledTerms.mockResolvedValue([controlledTerm()]);
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'controlled_terms' });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result.source).toBe('upstream');
    expect(result.entries).toEqual([
      {
        id: 1,
        label: 'Life Stage',
        multivalued: false,
        values: [
          { id: 2, label: 'Adult', blocking: false },
          { id: 6, label: 'Larva', blocking: false },
        ],
      },
    ]);
    expect(result.observed_usage).toBeUndefined();
  });

  it('adds observed usage, most-used first, when taxon_id is given', async () => {
    fake.getControlledTerms.mockResolvedValue([controlledTerm()]);
    fake.getObservedUsage.mockResolvedValue([
      observedUsage({ count: 336_576 }),
      observedUsage({ attribute: 'Life Stage', value: 'Larva', count: 127_161 }),
    ]);
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({
      topic: 'controlled_terms',
      taxon_id: 48662,
    });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(fake.getObservedUsage).toHaveBeenCalledWith(48662, ctx);
    expect(result.observed_usage).toHaveLength(2);
    expect(getEnrichment(ctx).notice).toBeUndefined();

    const [block] = inaturalistListReference.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';
    expect(text).toContain('### Observed usage');
    expect(text).toContain('336576 observations');
  });

  it('reports a notice when the requested taxon has no observed usage yet', async () => {
    fake.getControlledTerms.mockResolvedValue([controlledTerm()]);
    fake.getObservedUsage.mockResolvedValue([]);
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'controlled_terms', taxon_id: 1 });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result.observed_usage).toEqual([]);
    expect(getEnrichment(ctx).notice).toBe(
      'No annotations have been recorded for this taxon yet; the full vocabulary above still applies.',
    );
  });

  it('renders multivalued flag and nested values for a live controlled_terms entry', async () => {
    fake.getControlledTerms.mockResolvedValue([controlledTerm({ multivalued: true })]);
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'controlled_terms' });
    const result = await inaturalistListReference.handler(input, ctx);
    const [block] = inaturalistListReference.format?.(result) ?? [];
    const text = block && 'text' in block ? block.text : '';

    expect(text).toContain('multivalued: true');
    expect(text).toContain('Larva (id 6, blocking: false)');
  });
});

describe('errors', () => {
  it('throws taxon_id_not_applicable when taxon_id is given with a non-controlled_terms topic', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'ranks', taxon_id: 48662 });

    await expect(inaturalistListReference.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'taxon_id_not_applicable' },
    });
    expect(fake.getControlledTerms).not.toHaveBeenCalled();
  });

  it('propagates the service-thrown unknown_taxon_id error unchanged', async () => {
    fake.getControlledTerms.mockResolvedValue([controlledTerm()]);
    fake.getObservedUsage.mockRejectedValue(
      new McpError(
        JsonRpcErrorCode.ValidationError,
        'iNaturalist does not recognize that taxon_id.',
        { reason: 'unknown_taxon_id', retryable: false },
      ),
    );
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({
      topic: 'controlled_terms',
      taxon_id: 999_999_999,
    });

    await expect(inaturalistListReference.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'unknown_taxon_id' },
    });
  });
});
