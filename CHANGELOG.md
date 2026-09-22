# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-09-22

Invalid geography, date order, and rank order are now rejected before the request instead of reaching upstream as a retried 500 or a silent zero-result narrowing, and find_places, resolve_name, and every zero-hit notice get matching corrections.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-09-20

The public hosted instance at https://inaturalist.caseyjhand.com/mcp is now published as a streamable-http remote in server.json and documented in the README.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-19

Ten keyless, read-only tools and two resources over the iNaturalist v1 API, with every oversized response projected in-process, the filters upstream silently ignores rejected before the request, and outbound traffic self-paced under a daily budget.
