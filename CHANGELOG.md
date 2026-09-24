# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-09-23

next_cursor now only continues an id-descending page, a page past the end names the last page instead of reading as zero matches, get_species_counts rows carry an absolute position, and search/species-counts/histogram gain observer, project, licence, and annotation filters.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-09-23

Long identification and comment threads, and filled observation fields, are now capped per by-id record with disclosed counts; inaturalist_get_similar_species returns a typed error for a taxon coarser than genus, and batch order and identifications_count's meaning are corrected.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-09-22

Invalid geography, date order, and rank order are now rejected before the request instead of reaching upstream as a retried 500 or a silent zero-result narrowing, and find_places, resolve_name, and every zero-hit notice get matching corrections.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-09-20

The public hosted instance at https://inaturalist.caseyjhand.com/mcp is now published as a streamable-http remote in server.json and documented in the README.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-09-19

Ten keyless, read-only tools and two resources over the iNaturalist v1 API, with every oversized response projected in-process, the filters upstream silently ignores rejected before the request, and outbound traffic self-paced under a daily budget.
