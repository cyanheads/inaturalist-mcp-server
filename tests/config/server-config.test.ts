/**
 * @fileoverview Tests for the server config module — documented defaults, env
 * var overrides, out-of-range validation, and the module-level singleton
 * cache.
 * @module tests/config/server-config.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'INATURALIST_USER_AGENT',
  'INATURALIST_MIN_REQUEST_INTERVAL_MS',
  'INATURALIST_MAX_CONCURRENT_REQUESTS',
  'INATURALIST_DAILY_REQUEST_BUDGET',
] as const;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof savedEnv;
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('getServerConfig', () => {
  it('applies the documented defaults when no env vars are set', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();

    expect(config.minRequestIntervalMs).toBe(1100);
    expect(config.maxConcurrentRequests).toBe(4);
    expect(config.dailyRequestBudget).toBe(9000);
    expect(config.userAgent).toContain('inaturalist-mcp-server/');
    expect(config.userAgent).toContain('(+https://github.com/cyanheads/inaturalist-mcp-server)');
  });

  it('applies env var overrides for every field', async () => {
    process.env.INATURALIST_MIN_REQUEST_INTERVAL_MS = '500';
    process.env.INATURALIST_MAX_CONCURRENT_REQUESTS = '2';
    process.env.INATURALIST_DAILY_REQUEST_BUDGET = '100';
    process.env.INATURALIST_USER_AGENT = 'custom-agent/1.0 (+https://example.test)';

    const { getServerConfig } = await import('@/config/server-config.js');
    const config = getServerConfig();

    expect(config).toMatchObject({
      minRequestIntervalMs: 500,
      maxConcurrentRequests: 2,
      dailyRequestBudget: 100,
      userAgent: 'custom-agent/1.0 (+https://example.test)',
    });
  });

  it('throws a ConfigurationError naming the env var for an out-of-range value', async () => {
    process.env.INATURALIST_MAX_CONCURRENT_REQUESTS = '0';
    const { getServerConfig } = await import('@/config/server-config.js');

    expect(() => getServerConfig()).toThrow(McpError);
    expect(() => getServerConfig()).toThrow(/INATURALIST_MAX_CONCURRENT_REQUESTS/);
  });

  it('rejects a negative minRequestIntervalMs', async () => {
    process.env.INATURALIST_MIN_REQUEST_INTERVAL_MS = '-1';
    const { getServerConfig } = await import('@/config/server-config.js');

    expect(() => getServerConfig()).toThrow(/INATURALIST_MIN_REQUEST_INTERVAL_MS/);
  });

  it('caches the parsed config on first read, ignoring later env changes', async () => {
    const { getServerConfig } = await import('@/config/server-config.js');
    const first = getServerConfig();

    process.env.INATURALIST_MAX_CONCURRENT_REQUESTS = '99';
    const second = getServerConfig();

    expect(second).toBe(first);
    expect(second.maxConcurrentRequests).toBe(4);
  });
});
