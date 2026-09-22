/**
 * @fileoverview A real INaturalistService wired to a fetch mock that answers
 * every request with the HTTP 500 upstream returns for an area it cannot
 * evaluate. Tool tests hand this service to the handler in place of the fake,
 * so an input check is proven to fire before the service's request and retry
 * path runs: every attempt, retried ones included, lands in `http.calls`.
 * @module tests/helpers/failing-upstream
 */

import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';
import { INaturalistService } from '@/services/inaturalist/inaturalist-service.js';

/**
 * Builds the service and its fetch mock. Call `http.install()` before the
 * handler runs and `http.restore()` in a `finally`.
 */
export function failingUpstream() {
  const http = createFetchMock([
    {
      match: /api\.inaturalist\.org/,
      respond: () =>
        new Response(
          JSON.stringify({
            error:
              'Elasticsearch error, if this persists please contact the iNaturalist development team.',
            status: 500,
          }),
          { status: 500 },
        ),
    },
  ]);
  const service = new INaturalistService({
    userAgent: 'inaturalist-mcp-server/test (+https://example.test)',
    minRequestIntervalMs: 0,
    maxConcurrentRequests: 4,
    dailyRequestBudget: 1000,
  });
  return { http, service };
}
