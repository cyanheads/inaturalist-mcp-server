<div align="center">
  <h1>@cyanheads/inaturalist-mcp-server</h1>
  <p><b>Search wildlife sightings, read identification threads, rank species by area, chart phenology, and find look-alike taxa from iNaturalist via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/inaturalist-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/inaturalist-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/inaturalist-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

iNaturalist's index of 387M+ georeferenced citizen-science observations of plants, animals, and fungi. Search sightings by area, date, taxon, and annotation; read the identification thread behind a record; chart when a taxon appears; rank the species of an area; and check what a look-alike is most often confused with. Keyless and read-only, it runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `inaturalist_list_reference` | Decode the controlled vocabularies the other tools filter on: annotation attributes and values, quality grades, licences, ranks, iconic taxa, conservation-status codes |
| `inaturalist_resolve_name` | Resolve a common or scientific name to a taxon id, or a place, project, or observer name to its id, as ranked candidates |
| `inaturalist_find_places` | Resolve a place name to a place id, or list the places covering a map area, each with its bounding box and containment chain |
| `inaturalist_search_observations` | Search georeferenced sightings by area, date, taxon, quality grade, annotation, conservation status, observer, project, and licence |
| `inaturalist_get_observation` | Fetch up to 10 observations by id with their community identification thread and consensus taxon |
| `inaturalist_get_species_counts` | Rank the distinct species recorded in an area and period, most-observed first, optionally for one observer or project |
| `inaturalist_get_histogram` | Build a phenology histogram for a taxon in an area: which months, weeks, or years it is recorded in |
| `inaturalist_get_leaderboard` | Rank the most active observers or identifiers for an area, period, and taxon |
| `inaturalist_get_similar_species` | List the taxa a genus-or-finer taxon is most often misidentified as, ranked by correction count |
| `inaturalist_get_taxon` | Fetch a taxon profile: taxonomic path, conservation listings by authority, encyclopedia summary, photos, and children |

### Resources

| Resource | Description |
|:---|:---|
| `inaturalist://taxa/{taxon_id}` | Taxon profile by numeric taxon id, as injectable context |
| `inaturalist://observations/{observation_id}` | One observation with its identification thread expanded, as injectable context |

Both resources mirror data also reachable through `inaturalist_get_taxon` and `inaturalist_get_observation`, for clients that don't surface MCP resources.

## Capability reference

### `inaturalist_list_reference` <sub>tool</sub>

- `topic` picks one table: `controlled_terms` (fetched live), `quality_grades`, `licenses`, `ranks`, `iconic_taxa`, or `conservation_status_codes`; `taxon_id`, valid only with `controlled_terms`, adds `observed_usage`, the annotation pairs recorded for that taxon with counts
- `source` is `upstream` or `static`; annotation attributes and their values carry numeric ids to pass as `term_id` and `term_value_id`, since labels repeat across attributes

---

### `inaturalist_resolve_name` <sub>tool</sub>

- `q` plus `type`: `taxon` (default; name-prefix autocomplete, so "monarch" hits where "monarch butterfly" misses, with an optional `rank`) or `place` / `project` / `user` / `any` (scored cross-kind search); `limit` 1–30, default 10
- Each candidate carries `kind` and `id`, plus `login` on users; a miss returns `found: false` with `guidance` instead of an error

---

### `inaturalist_find_places` <sub>tool</sub>

- Exactly one of `q` (place-name prefix) or all four of `nelat`, `nelng`, `swlat`, `swlng`, otherwise `invalid_geography`; `per_page` 1–30 (default 10) applies to the box arm only, per list
- `q` returns `places[]`, a box returns `standard[]` and `community[]`; each place carries `id`, `bbox`, `ancestor_place_ids`, `place_type`, `admin_level`, and `location`, with boundary polygons stripped

---

### `inaturalist_search_observations` <sub>tool</sub>

- One area form plus `taxon_id`, `d1`/`d2`, `quality_grade`, `captive`, `term_id`+`term_value_id`, `iconic_taxa`, `hrank`/`lrank`, `csi`, `threatened`/`native`/`introduced`/`endemic`, `user_id` or `user_login`, `project_id`, and `q`+`search_on`; `per_page` 1–25, default 10; `include` expands `photos`, `annotations`, `sounds` (identification threads live on `inaturalist_get_observation`)
- `page` walks the first 10,000 results; past that, order by `id` descending and pass each page's `next_cursor` as `cursor`. Returns `total_results` (a live estimate) and `has_more`, and echoes `applied_filters`
- `license` / `photo_license` take the seven CC codes, OR-joined; `photo_license` matches any photo under the code, independent of the record's own `license_code`

---

### `inaturalist_get_observation` <sub>tool</sub>

- 1–10 `observation_id`s in one upstream request; `include` defaults to `["identifications"]`, with `comments`, `photos`, `annotations`, and `sounds` available
- Resolved records come back in `observations` in request order, misses in `unresolved`; fails as `not_found` only when none resolve. Adds `community_taxon`, `description`, and filled `observation_fields`
- Identifications, comments, and observation fields share a 40-entry budget: each record keeps `max(4, floor(40 / records returned))` entries per array and reports `*_total` beside `*_shown`

---

### `inaturalist_get_species_counts` <sub>tool</sub>

- One area form plus the search filters for taxon, dates, quality grade, captive, annotations, iconic taxa, observer, and project; `per_page` 1–50, default 25, with `page` offset
- Rows carry `position` (absolute, counted from page 1), `taxon_id`, and `observation_count`; `truncationCeiling` is the last count shown, which nothing off the page exceeds

---

### `inaturalist_get_histogram` <sub>tool</sub>

- `interval`: `month_of_year` (default) or `week_of_year` for a seasonal curve, or `year` / `month` / `week` / `day` / `hour` for absolute dates; `date_field` `observed` (default) or `created`; `taxon_id` optional, and an annotation pair (Life Stage `1` = Larva `6`) or `iconic_taxa` narrows the curve
- Returns every bucket in order, zeros included, plus a `total` across all of them; capped at 800 buckets from the start of the range, with `truncated` / `shown` / `cap`

---

### `inaturalist_get_leaderboard` <sub>tool</sub>

- `kind`: `observers` or `identifiers`, with one area form, `taxon_id`, `d1`/`d2`, and `quality_grade`; `per_page` 1–250, default 25
- Only the top 500 are addressable, so `page × per_page` past 500 fails as `leaderboard_window_exceeded`; entries carry `rank`, `login`, and `count` (measured per `count_metric`), plus `species_count` for observers

---

### `inaturalist_get_similar_species` <sub>tool</sub>

- `taxon_id` at genus or finer, otherwise `taxon_rank_too_coarse`; an optional area, `d1`/`d2`, `quality_grade`, and `captive` scope the set to a region; `limit` 1–50, default 20
- Ranked by `misidentification_count`, with `truncationCeiling` when the limit cuts the set

---

### `inaturalist_get_taxon` <sub>tool</sub>

- One `taxon_id`; `sections` selects from `summary`, `taxonomy`, `children`, `conservation`, `photos`, `encyclopedia`, and an unknown name fails as `unknown_section`
- `kind: "full"` carries the profile; `kind: "outline"` lists each section with its byte size when the profile overflows. A named section always comes back whole, so sum the outline's sizes before asking for several

---

### `inaturalist://taxa/{taxon_id}` <sub>resource</sub>

- The whole projected taxon document as `application/json`; a resource read can't name sections, so use `inaturalist_get_taxon` for the outline path
- `taxon_id` comes from `inaturalist_resolve_name`; cached for six hours

---

### `inaturalist://observations/{observation_id}` <sub>resource</sub>

- One observation as `application/json` with its first 40 identifications and first 40 filled observation fields, each with its `_total` beside its `_shown`
- `observation_id` comes from `inaturalist_search_observations`; cached for fifteen minutes

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

iNaturalist-specific:

- Keyless, read-only coverage of the iNaturalist v1 API. Upstream ignores its own `fields=` parameter, so every response is projected in-process (a common taxon record arrives at 95 KB)
- Area-scoped tools take one area form: `place_id`, `lat`+`lng`+`radius` in kilometres (up to 500), or a four-corner box. Partial or mixed forms fail as `invalid_geography`, and `d1` after `d2` as `inverted_date_range`
- Per-endpoint parameter allowlist, plus in-process rejection of input upstream would silently widen or zero out: a lone `term_value_id`, an impossible date, an unknown licence code
- Self-paced traffic: spaced request starts, capped concurrency, and a per-UTC-day budget that fails as `rate_budget_exhausted`. The counter is per process, so every caller of the hosted instance shares it. Taxa, places, controlled terms, histograms, and look-alike sets are cached; observation queries are not
- Licences relayed verbatim: a null `license_code` means all rights reserved, photo `attribution` must travel with the image, and photos are linked, never proxied. An `obscured` coordinate is a locality, and observers are identified by `login` only

Agent-friendly output:

- Applied defaults echoed: search, species counts, histograms, and leaderboards return `applied_filters` (research-grade and wild-only unless widened, plus any ordering a cursor forced)
- Zero-hit notices name the filter most likely responsible and the tool that decodes it (`inaturalist_list_reference` for vocabularies, since an unrecognised value returns nothing); a page past the end names the last page with results
- Truncation disclosed on every path: `truncated`, `shown`, and `cap`, plus `truncationCeiling` on descending rankings
- Upstream free text (encyclopedia summaries, identification and comment bodies, place guesses, photo attributions) renders inside a markdown blockquote, marking it as third-party content

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: the iNaturalist v1 API is keyless. The published terms ask clients to identify themselves, so a `User-Agent` with a contact URL is sent by default; keep one in any `INATURALIST_USER_AGENT` override.

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
| `INATURALIST_USER_AGENT` | `User-Agent` sent on every request to `api.inaturalist.org`. Keep a contact URL in any override. | `inaturalist-mcp-server/<version> (+<repo url>)` |
| `INATURALIST_MIN_REQUEST_INTERVAL_MS` | Minimum gap between outbound request starts, in ms. The default holds the rate near 54 per minute. | `1100` |
| `INATURALIST_MAX_CONCURRENT_REQUESTS` | Maximum outbound requests in flight. | `4` |
| `INATURALIST_DAILY_REQUEST_BUDGET` | Outbound requests allowed per UTC day, counted in-process and reset on restart. | `9000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend for the response cache: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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
| `src/index.ts` | `createApp()` entry point: identity, server instructions, tool and resource registration, service init. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) plus the shared filter, observation-record, and taxon-document helpers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`): taxon and observation. |
| `src/services/inaturalist` | iNaturalist service layer: allowlisted client, pacer, daily budget, cache, and response projections. |
| `tests/` | Unit, integration, and smoke tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
