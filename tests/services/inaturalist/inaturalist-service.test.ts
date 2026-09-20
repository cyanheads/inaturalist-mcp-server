/**
 * @fileoverview Tests for INaturalistService's own mechanics — the parameter
 * allowlist, the base64url cache key, the response cache and its TTL, the
 * start-interval pacer, the in-flight concurrency cap, the daily request
 * budget, outbound headers, and upstream error mapping. The network boundary
 * is faked with `createFetchMock`; nothing here reaches the real API.
 * @module tests/services/inaturalist/inaturalist-service.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inaturalistListReference } from '@/mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import type { Endpoint, QueryParams } from '@/services/inaturalist/inaturalist-service.js';
import { INaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { rawControlledTerm, rawObservation } from '../../helpers/fixtures.js';

/** Matches the private `buildUrl`/`cacheKey` methods for direct invocation in tests. */
type ServiceInternals = {
  buildUrl(spec: { endpoint: Endpoint; path?: string; params?: QueryParams }): string;
  cacheKey(spec: { endpoint: Endpoint; path?: string; params?: QueryParams }): string;
};

function internals(service: INaturalistService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

function newService(
  overrides: {
    userAgent?: string;
    minRequestIntervalMs?: number;
    maxConcurrentRequests?: number;
    dailyRequestBudget?: number;
  } = {},
): INaturalistService {
  return new INaturalistService({
    userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
    minRequestIntervalMs: 0,
    maxConcurrentRequests: 4,
    dailyRequestBudget: 1000,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parameter allowlist', () => {
  it('rejects a parameter name not on the endpoint allowlist', () => {
    const service = newService();
    // controlled_terms publishes no query parameters at all; any key is unlisted.
    expect(() =>
      internals(service).buildUrl({ endpoint: 'controlled_terms', params: { taxon_id: 1 } }),
    ).toThrow(McpError);
  });

  it('builds an allowed parameter into the URL, sorted for a stable cache key', () => {
    const service = newService();
    const url = internals(service).buildUrl({
      endpoint: 'taxa/autocomplete',
      params: { q: 'monarch', per_page: 10 },
    });
    expect(url).toBe('https://api.inaturalist.org/v1/taxa/autocomplete?per_page=10&q=monarch');
  });

  it('drops an undefined parameter and an empty array rather than sending them', () => {
    const service = newService();
    const url = internals(service).buildUrl({
      endpoint: 'observations',
      params: { taxon_id: undefined, quality_grade: [], per_page: 20 },
    });
    expect(url).toBe('https://api.inaturalist.org/v1/observations?per_page=20');
  });
});

describe('cache key', () => {
  it('produces a base64url key scoped to the endpoint', () => {
    const service = newService();
    const key = internals(service).cacheKey({ endpoint: 'controlled_terms' });
    expect(key).toMatch(/^inat\/controlled_terms\/[A-Za-z0-9_-]+$/);
  });

  it('produces distinct keys for distinct request specs', () => {
    const service = newService();
    const a = internals(service).cacheKey({ endpoint: 'taxa/autocomplete', params: { q: 'a' } });
    const b = internals(service).cacheKey({ endpoint: 'taxa/autocomplete', params: { q: 'b' } });
    expect(a).not.toBe(b);
  });
});

describe('response cache', () => {
  it('serves a repeat call from the TTL cache without a second fetch', async () => {
    const http = createFetchMock([
      {
        match: /\/controlled_terms/,
        respond: () => Response.json({ results: [rawControlledTerm()] }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await service.getControlledTerms(ctx);
      await service.getControlledTerms(ctx);

      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });

  it('expires a cached response once its TTL elapses, issuing a fresh fetch', async () => {
    vi.useFakeTimers();
    const http = createFetchMock([
      {
        match: /\/controlled_terms/,
        respond: () => Response.json({ results: [rawControlledTerm()] }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await service.getControlledTerms(ctx);
      // controlled_terms is cached 24h (86,400s).
      await vi.advanceTimersByTimeAsync(86_400_000 + 1_000);
      await service.getControlledTerms(ctx);

      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });

  it('does not cache an endpoint absent from the TTL table', async () => {
    const http = createFetchMock([
      { match: /\/taxa\/autocomplete/, respond: () => Response.json({ results: [] }) },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await service.autocompleteTaxa({ q: 'monarch', limit: 5 }, ctx);
      await service.autocompleteTaxa({ q: 'monarch', limit: 5 }, ctx);

      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });
});

describe('start-interval pacer', () => {
  it('spaces the start of successive outbound requests by minRequestIntervalMs', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const http = createFetchMock([
      {
        match: /\/taxa\/autocomplete/,
        respond: () => {
          starts.push(Date.now());
          return Response.json({ results: [] });
        },
      },
    ]);
    http.install();
    try {
      const service = newService({ minRequestIntervalMs: 1000 });
      const ctx = createMockContext();

      const first = service.autocompleteTaxa({ q: 'a', limit: 5 }, ctx);
      const second = service.autocompleteTaxa({ q: 'b', limit: 5 }, ctx);

      await vi.advanceTimersByTimeAsync(1500);
      await Promise.all([first, second]);

      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1000);
    } finally {
      http.restore();
    }
  });
});

describe('in-flight concurrency cap', () => {
  it('holds a second request until a slot frees once the cap is reached', async () => {
    const pendingResolvers: Array<() => void> = [];
    const http = createFetchMock([
      {
        match: /\/taxa\/autocomplete/,
        respond: () =>
          new Promise<Response>((resolve) => {
            pendingResolvers.push(() => resolve(Response.json({ results: [] })));
          }),
      },
    ]);
    http.install();
    try {
      const service = newService({ maxConcurrentRequests: 1 });
      const ctx = createMockContext();

      const first = service.autocompleteTaxa({ q: 'a', limit: 5 }, ctx);
      const second = service.autocompleteTaxa({ q: 'b', limit: 5 }, ctx);

      await vi.waitFor(() => expect(pendingResolvers).toHaveLength(1));
      expect(pendingResolvers).toHaveLength(1);

      pendingResolvers[0]?.();
      await first;

      await vi.waitFor(() => expect(pendingResolvers).toHaveLength(2));
      pendingResolvers[1]?.();
      await second;
    } finally {
      http.restore();
    }
  });
});

describe('daily request budget', () => {
  it('fails loudly with rate_budget_exhausted once the daily budget is spent', async () => {
    const http = createFetchMock([
      { match: /\/taxa\/autocomplete/, respond: () => Response.json({ results: [] }) },
    ]);
    http.install();
    try {
      const service = newService({ dailyRequestBudget: 1 });
      const ctx = createMockContext();

      await service.autocompleteTaxa({ q: 'a', limit: 5 }, ctx);
      await expect(service.autocompleteTaxa({ q: 'b', limit: 5 }, ctx)).rejects.toMatchObject({
        data: { reason: 'rate_budget_exhausted', retryable: false },
      });

      expect(http.calls).toHaveLength(1);
    } finally {
      http.restore();
    }
  });
});

describe('outbound request headers', () => {
  it('sends the configured User-Agent and never sends an Authorization header', async () => {
    const http = createFetchMock([
      { match: /\/controlled_terms/, respond: () => Response.json({ results: [] }) },
    ]);
    http.install();
    try {
      const service = newService({
        userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
      });
      const ctx = createMockContext();

      await service.getControlledTerms(ctx);

      const request = http.calls[0]?.request;
      expect(request?.headers.get('User-Agent')).toBe(
        'inaturalist-mcp-server/test (+https://example.test)',
      );
      expect(request?.headers.get('Authorization')).toBeNull();
    } finally {
      http.restore();
    }
  });
});

describe('upstream error mapping', () => {
  it('maps a 422 "Unknown taxon_id" body to a typed unknown_taxon_id error', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\?/,
        respond: () =>
          new Response(JSON.stringify({ error: 'Unknown taxon_id 999999999', status: 422 }), {
            status: 422,
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      await expect(
        service.searchObservations(
          { taxon_id: 999_999_999, per_page: 20, page: 1 },
          new Set(),
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'unknown_taxon_id' } });
    } finally {
      http.restore();
    }
  });

  it('keeps the upstream path out of the caller-facing unknown_taxon_id data', async () => {
    // error.data reaches structuredContent.error.data on the wire. The recovery
    // hint already names the fix, so the internal REST path adds nothing a
    // caller can act on.
    const http = createFetchMock([
      {
        match: /\/identifications\/similar_species/,
        respond: () =>
          new Response(JSON.stringify({ error: 'Unknown taxon_id 999999999', status: 422 }), {
            status: 422,
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const error = await service
        .getSimilarSpecies({ taxon_id: 999_999_999 }, ctx)
        .then(() => undefined)
        .catch((err: unknown) => err);

      expect(error).toMatchObject({ data: { reason: 'unknown_taxon_id' } });
      expect((error as McpError).data).not.toHaveProperty('endpoint');
    } finally {
      http.restore();
    }
  });

  it("resolves the unknown_taxon_id recovery hint from the calling tool's own error contract", async () => {
    // getObservedUsage (behind inaturalist_list_reference's taxon_id param)
    // hits the same taxon_id-filtered endpoint shape as searchObservations, so
    // an unknown id 422s the same way — the recovery hint only appears when
    // the calling tool declares the reason in its own errors[] contract.
    const http = createFetchMock([
      {
        match: /\/observations\/popular_field_values/,
        respond: () =>
          new Response(JSON.stringify({ error: 'Unknown taxon_id 999999999', status: 422 }), {
            status: 422,
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext({ errors: inaturalistListReference.errors });

      await expect(service.getObservedUsage(999_999_999, ctx)).rejects.toMatchObject({
        data: {
          reason: 'unknown_taxon_id',
          recovery: { hint: expect.stringContaining('inaturalist_resolve_name') },
        },
      });
    } finally {
      http.restore();
    }
  });

  it('leaves an unrelated upstream error unchanged (a 422 whose body does not name an unknown taxon_id)', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\?/,
        respond: () =>
          new Response(JSON.stringify({ error: 'Some other validation problem', status: 422 }), {
            status: 422,
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      // 422 is expected/non-retried regardless of body, so this settles in one
      // attempt without needing to fake the retry backoff clock.
      await expect(
        service.searchObservations({ per_page: 20, page: 1 }, new Set(), ctx),
      ).rejects.not.toMatchObject({ data: { reason: 'unknown_taxon_id' } });
    } finally {
      http.restore();
    }
  });
});

describe('getObservations id resolution', () => {
  it('reports a requested id upstream did not return as unresolved, per id', async () => {
    const http = createFetchMock([
      {
        match: /\/observations\/1,2,999999999999/,
        respond: () =>
          Response.json({
            total_results: 2,
            results: [
              { id: 1, taxon: null },
              { id: 2, taxon: null },
            ],
          }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { observations, unresolved } = await service.getObservations(
        [1, 2, 999_999_999_999],
        new Set(),
        ctx,
      );

      expect(observations.map((o) => o.id)).toEqual([1, 2]);
      expect(unresolved).toEqual([999_999_999_999]);
    } finally {
      http.restore();
    }
  });

  it('fetches the observation and the controlled-term vocabulary concurrently when annotations are included', async () => {
    // Both requests are independent, so they run through Promise.all rather
    // than one after the other — this exercises that the vocabulary from the
    // second request still lands in the decoded annotation.
    const http = createFetchMock([
      {
        match: /\/observations\/1$/,
        respond: () => Response.json({ total_results: 1, results: [rawObservation({ id: 1 })] }),
      },
      {
        match: /\/controlled_terms/,
        respond: () => Response.json({ results: [rawControlledTerm()] }),
      },
    ]);
    http.install();
    try {
      const service = newService();
      const ctx = createMockContext();

      const { observations } = await service.getObservations([1], new Set(['annotations']), ctx);

      expect(observations[0]?.annotations).toEqual([
        expect.objectContaining({ attribute: 'Life Stage', value: 'Larva' }),
      ]);
      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });
});
