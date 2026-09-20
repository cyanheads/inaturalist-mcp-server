/**
 * @fileoverview Server-specific configuration for inaturalist-mcp-server — the
 * outbound traffic posture against api.inaturalist.org.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { config, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * The published terms ask clients to identify themselves. A descriptive client
 * name plus a contact URL satisfies that without naming an individual.
 */
function defaultUserAgent(): string {
  return `inaturalist-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/inaturalist-mcp-server)`;
}

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .default(() => defaultUserAgent())
    .describe(
      'User-Agent sent on every request to api.inaturalist.org. Keep a contact URL in any override — the published terms ask for identifiable clients.',
    ),
  minRequestIntervalMs: z.coerce
    .number()
    .int()
    .min(0)
    .default(1100)
    .describe(
      'Minimum spacing between outbound request starts, in milliseconds. The default of 1100 holds the sustained rate near 54 requests/minute, under the 60/minute the upstream asks for and well under its 100/minute ceiling.',
    ),
  maxConcurrentRequests: z.coerce
    .number()
    .int()
    .min(1)
    .default(4)
    .describe(
      'Maximum outbound requests in flight. Separate from the start interval: spacing bounds the sustained rate, this bounds the burst so one slow call does not stall the lane.',
    ),
  dailyRequestBudget: z.coerce
    .number()
    .int()
    .min(1)
    .default(9000)
    .describe(
      'Outbound requests allowed per UTC day, counted in-process. The default of 9000 sits under the 10,000/day the upstream asks for. The counter resets on restart and is not shared between processes behind one egress IP.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'INATURALIST_USER_AGENT',
    minRequestIntervalMs: 'INATURALIST_MIN_REQUEST_INTERVAL_MS',
    maxConcurrentRequests: 'INATURALIST_MAX_CONCURRENT_REQUESTS',
    dailyRequestBudget: 'INATURALIST_DAILY_REQUEST_BUDGET',
  });
  return _config;
}
