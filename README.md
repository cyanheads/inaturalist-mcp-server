<div align="center">
  <h1>@cyanheads/inaturalist-mcp-server</h1>
  <p><b>Search wildlife sightings, read identification threads, rank species by area, chart phenology, and find look-alike taxa from iNaturalist via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/inaturalist-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/inaturalist-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/inaturalist-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/inaturalist-mcp-server/releases/latest/download/inaturalist-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=inaturalist-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW5hdHVyYWxpc3QtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22inaturalist-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Finaturalist-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://inaturalist.caseyjhand.com/mcp](https://inaturalist.caseyjhand.com/mcp)

</div>

---

## Overview

iNaturalist's index of 380M+ georeferenced citizen-science observations of plants, animals, and fungi. Search sightings by area, date, taxon, and annotation; read the community identification thread behind a record; chart when a taxon appears in a place; rank the species of an area; and check what a look-alike is most often confused with. Keyless and read-only, running as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

Composes with servers covering institutional specimen records, botanical nomenclature, and geocoding — this one contributes the observation, identification-thread, and phenology layer.

### Tools

| Tool | Description |
|:---|:---|
| `inaturalist_list_reference` | Decode the controlled vocabularies the other tools filter on — annotation attributes and values, quality grades, licences, ranks, iconic taxa, conservation-status codes |
| `inaturalist_resolve_name` | Resolve a common or scientific name to a taxon id, or a place, project, or observer name to its id, as ranked candidates |
| `inaturalist_find_places` | Resolve a place name to a place id, or list the places covering a map area, each with its bounding box and containment chain |
| `inaturalist_search_observations` | Search georeferenced sightings by area, date, taxon, quality grade, annotation, and conservation status |
| `inaturalist_get_observation` | Fetch up to 10 observations by id with their community identification thread and consensus taxon |
| `inaturalist_get_species_counts` | Rank the distinct species recorded in an area and period, most-observed first |
| `inaturalist_get_histogram` | Build a phenology histogram for a taxon in an area — which months, weeks, or years it is recorded in |
| `inaturalist_get_leaderboard` | Rank the most active observers or identifiers for an area, period, and taxon |
| `inaturalist_get_similar_species` | List the taxa a genus-or-finer taxon is most often misidentified as, ranked by how many times identifiers made the correction |
| `inaturalist_get_taxon` | Fetch a taxon profile — taxonomic path, conservation listings by authority, encyclopedia summary, photos, and children |

### Resources

| Resource | Description |
|:---|:---|
| `inaturalist://taxa/{taxon_id}` | Taxon profile by numeric taxon id, as injectable context |
| `inaturalist://observations/{observation_id}` | One observation with its identification thread expanded, as injectable context |

Both resources mirror data also reachable through `inaturalist_get_taxon` and `inaturalist_get_observation` — useful for clients that don't surface MCP resources.

## Capability reference

### `inaturalist_list_reference` <sub>tool</sub>

- `topic` selects one table: `controlled_terms`, `quality_grades`, `licenses`, `ranks`, `iconic_taxa`, `conservation_status_codes`; `source` reports whether it came from iNaturalist or the published spec
- `taxon_id` applies only to `controlled_terms` and adds `observed_usage` — which annotation pairs identifiers have actually recorded for that taxon, with counts
- Every other tool's recovery hint routes here: an unrecognised filter value is not rejected upstream, it silently returns nothing

---

### `inaturalist_resolve_name` <sub>tool</sub>

- `type`: `taxon` (name-prefix autocomplete) or `place` / `project` / `user` / `any` (scored cross-kind search); `rank` narrows taxa only; `limit` 1–30 (default 10), applied in-process on every type
- Taxon lookup matches a name **prefix**, not words inside a name — "monarch" hits where "monarch butterfly" misses
- A miss is a result: `found: false` with `guidance` naming why, rather than an error
- Each candidate carries `kind` and `id` — the identifier every other tool takes. A `user` candidate also carries `login`, the value leaderboard entries and an observation's `observer` relay; its `name` is the display name

---

### `inaturalist_find_places` <sub>tool</sub>

- Exactly one of `q` (place-name prefix) or all four of `nelat`, `nelng`, `swlat`, `swlng`; neither or both fails as `invalid_geography`, as does a box with `nelat` south of `swlat`. A blank `q` reads as unset, and `nelng` west of `swlng` is an antimeridian-crossing box, not an error
- `q` returns `places[]`; the bounding box returns `standard[]` and `community[]` as separate lists
- Each place carries `bbox`, `place_type`, `admin_level`, `ancestor_place_ids`, `location`, and `slug`; boundary polygons are stripped, since one upstream response carries 247 KB of them
- `per_page` (1–30, default 10) binds the bounding-box arm only, where it bounds `standard[]` and `community[]` separately, so `cap` is `per_page × 2`. The name-prefix endpoint publishes no page size, and its fixed page is disclosed through the truncation enrichment

---

### `inaturalist_search_observations` <sub>tool</sub>

- An area is given in exactly one form — `place_id`, the `lat`+`lng`+`radius` triple in kilometres (0 < radius ≤ 500), or the four-corner bounding box with `nelat` at or north of `swlat`; partial, mixed, a zero radius, or an inverted box fails as `invalid_geography`
- Filters: `taxon_id`, `d1`/`d2`, `quality_grade`, `captive`, `term_id`+`term_value_id`, `iconic_taxa`, `hrank`/`lrank`, `csi`, `threatened`/`native`/`introduced`/`endemic`, `licensed`/`photo_licensed`, and `q`+`search_on`
- Ordered pairs are checked before the request: `d1` after `d2` fails as `inverted_date_range` (on every tool that takes dates), and an `hrank` finer than `lrank` as `inverted_rank_range`. Equal pairs are valid
- Defaults to `quality_grade: ["research"]` and `captive: false`, echoed back as `applied_filters` on every call
- `per_page` 1–25 (default 10); `page` walks the first 10,000 results and `cursor` continues past it — passing both fails, and a cursor forces an id ordering, which is echoed
- `include` expands `photos`, `annotations`, `sounds`. `identifications` and `comments` are deliberately absent — one thread measures 28 KB, so the thread lives on `inaturalist_get_observation`

---

### `inaturalist_get_observation` <sub>tool</sub>

- 1–10 ids per call, resolved in a single upstream request
- `include` defaults to `["identifications"]`; `comments`, `photos`, `annotations`, and `sounds` are also available
- Partial success: ids that resolve return in `observations`, the rest in `unresolved`; the call fails as `not_found` only when nothing resolved
- Adds `community_taxon`, `identification_disagreements_count`, the observer's `description`, and filled `observation_fields` on top of the projected search record
- Records come back in the requested order, unresolved ids left out in place
- `identifications`, `comments`, and the filled `observation_fields` share a 40-entry budget across the batch: each record keeps its first `max(4, floor(40 / records returned))` entries per array in upstream order — 40 for one id, 4 for ten — and reports `identifications_total`/`identifications_shown`, `comments_total`/`comments_shown`, and `observation_fields_total`/`observation_fields_shown`. A cut is named in the `notice`; request one id alone for the 40-entry view, or open the record's `url` for the full record. `description` is never cut
- `identifications_count` is upstream's tally of identifications agreeing or disagreeing with the community taxon (`agreements + disagreements`), not the thread size — that is `identifications_total`

---

### `inaturalist_get_species_counts` <sub>tool</sub>

- Distinct species for an area and period, ranked by `observation_count` — the "what lives here" answer without paging through individual sightings
- Same area forms and filters as the observation search; `taxon_id` narrows to a clade, such as the birds of a park
- `per_page` 1–50 (default 25), `page` for offset — upstream would serve 500 in one page, and the cap is sized by response bytes instead
- `truncationCeiling` carries the last count shown; the ranking is descending, so nothing left off the page exceeds it

---

### `inaturalist_get_histogram` <sub>tool</sub>

- `interval`: `month_of_year` (default) and `week_of_year` fold every year into one seasonal curve; `year`, `month`, `week`, `day`, and `hour` bucket absolute dates, to which upstream applies its own default start date
- `date_field`: `observed` (default) or `created`
- `taxon_id` is optional — omit it to chart every taxon in the area
- Returns every bucket upstream produced in order, zeros included, plus their `total` — computed across every bucket upstream returned, even past the cap. `day`/`hour` over a wide date range can generate thousands of buckets, so the response is capped at 800, kept from the start of the range, with `truncated`/`shown`/`cap` disclosing the cut

---

### `inaturalist_get_leaderboard` <sub>tool</sub>

- `kind`: `observers` (ranked by observations recorded, carrying `species_count`) or `identifiers` (identifications made); `count_metric` names what `count` measures
- `per_page` 1–250 (default 25), `page` for offset. Both endpoints rank only the top 500, so `page × per_page` past 500 fails as `leaderboard_window_exceeded` rather than returning a false zero-hit
- Takes the same area forms, `taxon_id`, `d1`/`d2`, and `quality_grade` as the observation search

---

### `inaturalist_get_similar_species` <sub>tool</sub>

- The taxa a `taxon_id` is most often corrected from, ranked by `misidentification_count` — the field-identification check before committing to a look-alike
- `taxon_id` must be a genus or finer; upstream keeps no confusion set for a family, order, or anything coarser, and the call fails as `taxon_rank_too_coarse`
- An optional area, date range, `quality_grade`, and `captive` scope the confusion set to one region; omit them for the global set
- `limit` 1–50 (default 20), applied in-process — the endpoint publishes no page size and returns its whole set

---

### `inaturalist_get_taxon` <sub>tool</sub>

- One `taxon_id`. Returns `kind: "full"` with the projected profile, or `kind: "outline"` listing each section and its byte size when the projection still overflows the budget
- Sections are `summary`, `taxonomy`, `children`, `conservation`, `photos`, `encyclopedia`; name them in `sections` to fetch a slice, and an unknown name fails as `unknown_section`
- The upstream record is 95 KB for a common species — per-country checklist membership is dropped, `listed_taxa_count` kept as a scalar, and ancestors, children, and conservation entries trimmed to their identifying fields
- A named section comes back whole at whatever size, so sum the outline's byte sizes before asking for several

---

### `inaturalist://taxa/{taxon_id}` <sub>resource</sub>

- The projected taxon document as `application/json`, always whole — a resource read has no way to name sections, so use `inaturalist_get_taxon` when the outline path matters
- `taxon_id` comes from `inaturalist_resolve_name`; cached for six hours, matching the service's taxon TTL

---

### `inaturalist://observations/{observation_id}` <sub>resource</sub>

- One observation with its identification thread expanded, as `application/json` — the first 40 identifications and the first 40 filled observation fields in upstream order, each with its `_total` beside its `_shown`
- `observation_id` comes from `inaturalist_search_observations`; cached for fifteen minutes, since a thread accrues identifications

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

iNaturalist-specific:

- Keyless, read-only cover of the iNaturalist v1 API — observations, taxa, places, controlled terms, the similar-species graph, and the observer and identifier leaderboards
- Every response is projected in-process. Upstream accepts and ignores its own `fields=` parameter, so a two-record observation search arrives at 95 KB, a full upstream page of 200 at 4.3 MB, and a common taxon record at 95 KB before anything is trimmed
- Per-endpoint parameter allowlist — an unknown parameter name returns HTTP 200 and the entire global index, so nothing outside the allowlist is ever sent
- In-process rejection of every input upstream would silently widen, narrow to zero, or fail on: a lone `lat`, an unparseable or impossible `d1` such as `2026-02-30`, `d1` after `d2`, a `term_value_id` without its `term_id`, a zero radius, a box with `nelat` south of `swlat`, a page past the result window
- Self-paced outbound traffic with a per-UTC-day request budget, since the API returns no rate-limit headers to react to

Agent-friendly output:

- Applied defaults echoed on every call — `quality_grade`, `captive`, and the ordering a cursor forced — so an agent can see the filters that shaped its answer
- Zero-hit notices name the filter most likely responsible and the tool that decodes it, instead of an empty list
- Truncation disclosed unconditionally: `truncated`, `shown`, and `cap` on every path, plus a `truncationCeiling` where a descending ranking supports one
- Upstream free text — encyclopedia summaries, identification and comment bodies, place guesses, photo attributions — renders inside a markdown blockquote, marking it as third-party content rather than instruction

## Licensing and attribution

The API is open; the records are not uniformly open.

- `license_code` is relayed verbatim and is nullable. **A null means all rights reserved** — it is never coerced to `""`, `"unknown"`, or a default licence, and the rendered text spells the null case out in words.
- Photo `attribution` strings are relayed verbatim, never reformatted or shortened, and must be reproduced wherever the image is. A photo's own `license_code` is independent of its observation's.
- `open` is derived from the hosting domain: `true` for `inaturalist-open-data.s3.amazonaws.com`, `false` for anything else, because an unrecognised host is not evidence of an open licence. A licence change moves a photo between hosts, so the flag describes fetch time rather than a permanent property.
- Photos are linked, never proxied. No tool fetches image bytes or emits base64 image content — a URL with its attribution and licence is the whole contract.
- `obscured: true` marks a locality, not a sighting position. iNaturalist withholds true coordinates for threatened taxa, and the server never sends an `Authorization` header, so hidden coordinates stay hidden.
- Observer identity collapses to `login`. The upstream user object carries a real name, an ORCID, and counts; none of it is relayed.

## Rate limits and response size

The published terms allow at most 100 requests per minute, ask clients to stay at or below 60, and ask for under 10,000 per day. No rate-limit headers come back, so pacing is entirely self-imposed: outbound requests start at least `INATURALIST_MIN_REQUEST_INTERVAL_MS` apart (1100 ms ≈ 54 per minute), at most `INATURALIST_MAX_CONCURRENT_REQUESTS` run in flight, and `INATURALIST_DAILY_REQUEST_BUDGET` bounds a UTC day. Exhausting the budget is a typed failure rather than a silent degradation.

Controlled terms (24 h), taxon profiles (6 h), places (6 h), the similar-species graph (6 h), and histograms (1 h) are cached in tenant-scoped storage. Observation search, species counts, leaderboards, and observation detail are never cached — freshness is what they are for.

Page-size maxima are sized by measured response bytes across `structuredContent` and the rendered text together, not by what upstream will serve:

| Tool | Bytes per record | `per_page` max | Default | Upstream would serve |
|:---|---:|---:|---:|---:|
| `inaturalist_search_observations` | ~1,970 | 25 | 10 | 200 |
| `inaturalist_get_species_counts` | ~860 | 50 | 25 | 500 |
| `inaturalist_get_leaderboard` | ~140 | 250 | 25 | 500 |

Each default page fits the 24,000-byte budget a single document gets, and each full page fits 50,000. Nothing is unreachable at the lower caps — `page` and `cursor` reach the same records — so the smaller page costs one more call rather than any data.

## Known limitations

- Upstream ignores its own `fields=` partial-response parameter, so every byte is fetched before being projected away. Projection saves the agent's context, not the network.
- `total_results` is an estimate over a live index. It drifts between calls seconds apart.
- `place_type` and `admin_level` have no published code table. The raw integers are relayed and `display_name` carries the meaning.
- A place crossing the antimeridian has a degenerate bounding box upstream. It is relayed as computed, not repaired.
- Obscured coordinates cannot be resolved, by design. A threatened-taxon record reports a locality with an accuracy radius in the tens of kilometres.
- A section named in `inaturalist_get_taxon` comes back whole however large it is — truncating a section the caller asked for by name is the failure the outline exists to prevent.
- The daily request counter is per process. A restart resets it, and two processes behind one egress IP do not share it. Every caller of the public hosted instance draws on that one process's budget.
- `inaturalist_get_leaderboard` can address only the top 500 entries, against the 10,000-result window on observation search.

## Getting started

### Public Hosted Instance

A public instance is available at `https://inaturalist.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "inaturalist-mcp-server": {
      "type": "streamable-http",
      "url": "https://inaturalist.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "inaturalist-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/inaturalist-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "inaturalist-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/inaturalist-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "inaturalist-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/inaturalist-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js ≥ 24.0.0).
- No API key required — the iNaturalist v1 API is keyless, and this server never authenticates.
- The published terms ask clients to identify themselves. A descriptive `User-Agent` with a contact URL is sent by default; keep one in any `INATURALIST_USER_AGENT` override.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/inaturalist-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd inaturalist-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override defaults — no required vars
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateless`, `stateful`, or `auto`. Overrides the `stateless` declared in `src/index.ts`. | `stateless` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. Backs the response cache. | `in-memory` |
| `INATURALIST_USER_AGENT` | `User-Agent` sent on every request to `api.inaturalist.org`. Keep a contact URL in any override. | `inaturalist-mcp-server/<version> (+<repo url>)` |
| `INATURALIST_MIN_REQUEST_INTERVAL_MS` | Minimum spacing between outbound request starts, in milliseconds. | `1100` |
| `INATURALIST_MAX_CONCURRENT_REQUESTS` | Maximum outbound requests in flight. | `4` |
| `INATURALIST_DAILY_REQUEST_BUDGET` | Outbound requests allowed per UTC day, counted in-process. | `9000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lint, format, typecheck, security
  bun run test      # Vitest test suite
  bun run lint:mcp  # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t inaturalist-mcp-server .
docker run --rm -p 3010:3010 inaturalist-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/inaturalist-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, inits the service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus the shared filter, record, and taxon-document helpers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — taxon and observation. |
| `src/services/inaturalist` | iNaturalist service layer — allowlisted client, pacer, cache, and response projections. |
| `tests/` | Unit and integration tests mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
