# inaturalist-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `inaturalist_list_reference` | Decode the vocabularies the other tools take as input: annotation attributes and values, quality grades, license codes, taxonomic ranks, iconic taxa, and IUCN conservation-status codes. | `topic`, `taxon_id` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_resolve_name` | Resolve a common or scientific name to a taxon id, or a place, project, or observer name to its id. Returns ranked candidates with the identifiers the other tools take. | `q`, `type`, `rank`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_search_observations` | Search georeferenced wildlife sightings by area, date, taxon, quality grade, annotation, and conservation status. Returns a projected record per sighting with coordinates, licence, photo, and identification counts. | `place_id` \| `lat`+`lng`+`radius` \| bbox, `taxon_id`, `d1`/`d2`, `quality_grade`, `captive`, `term_id`/`term_value_id`, `iconic_taxa`, `page` \| `cursor`, `per_page`, `include` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_get_observation` | Fetch up to 10 observations by id with their community identification thread — who identified what, whether each identification agrees, and the community consensus taxon. | `observation_id[]`, `include` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `inaturalist_get_species_counts` | Rank the distinct species recorded in an area and period, most-observed first. Answers "what lives here" without paging through individual sightings. | `place_id` \| `lat`+`lng`+`radius` \| bbox, `d1`/`d2`, `taxon_id`, `quality_grade`, `per_page` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_get_histogram` | Build a phenology histogram for a taxon in an area — which months, weeks, or years it is recorded in. | `taxon_id`, `place_id` \| `lat`+`lng`+`radius` \| bbox, `interval`, `date_field` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_get_taxon` | Fetch a taxon profile: taxonomic path, per-authority conservation statuses, encyclopedia summary, photo gallery, immediate children, and observation counts. | `taxon_id`, `sections` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `inaturalist_get_similar_species` | List the taxa this one is most often misidentified as, ranked by how many times identifiers made the correction. The field-identification check for a look-alike. | `taxon_id`, `place_id` \| `lat`+`lng`+`radius` \| bbox, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_find_places` | Resolve a place name to a place id, or list the places containing a map area. Returns each place's bounding box for follow-up area searches. | `q` \| bbox (`nelat`,`nelng`,`swlat`,`swlng`), `per_page` | `readOnlyHint: true`, `openWorldHint: true` |
| `inaturalist_get_leaderboard` | Rank the most active observers or identifiers for an area, period, and taxon. | `kind`, `place_id` \| `lat`+`lng`+`radius` \| bbox, `taxon_id`, `d1`/`d2`, `per_page` | `readOnlyHint: true`, `openWorldHint: true` |

No tool declares `title`. The snake_case `name` is the display surface everywhere.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `inaturalist://taxa/{taxon_id}` | Taxon profile as injectable context — the same projected document `inaturalist_get_taxon` returns, minus the section-selection arm. | No |
| `inaturalist://observations/{observation_id}` | One observation with its identification thread — the same projection `inaturalist_get_observation` returns for a single id. | No |

Resource `name` values are `inaturalist-taxon` and `inaturalist-observation`. Neither declares `title`. Both mirror data already reachable through tools, so a tool-only client loses nothing.

### Prompts

None. The server is lookup- and discovery-oriented; the workflow chain lives in the server `instructions` string and the tool descriptions, and no recurring interaction pattern needs a template.

---

## Overview

Read-only access to iNaturalist — 387M+ georeferenced citizen-science observations of plants, animals, and fungi, with photos, the community identification thread behind each record, per-taxon phenology, annotations, places, and the similar-species graph that answers "what is this commonly mistaken for."

The audience is naturalists, hikers, conservation biologists, park rangers, wildlife photographers, foragers, educators, and agents doing spatial reasoning about local flora and fauna. The server wraps the keyless read subset of `https://api.inaturalist.org/v1/` — one upstream, one service, no API key, no account, no writes.

Two properties shape every decision below and are treated as first-class engineering constraints rather than caveats: **responses are enormous and cannot be trimmed upstream**, and **the API silently widens a query it does not understand instead of rejecting it**.

Composes with servers covering institutional specimen records, avian checklists, fish taxonomy, botanical nomenclature, phylogenetic trees, and geocoding — this server contributes the observation, identification-thread, and phenology layer.

---

## Requirements

- Read-only. No writes, no account operations, no authenticated surfaces.
- Keyless. The spec declares an optional `Authorization` api-token on `/observations` and `/observations/{id}`; every probe succeeded without it, and authentication only unlocks private coordinates the server must not seek.
- Search observations by point-and-radius, place id, or bounding box; by date range, taxon, quality grade, annotation, conservation status, rank band, iconic taxon, licence, and captivity.
- Resolve a common or scientific name to a taxon id, and a place name or map area to a place id.
- Read one observation's identification thread and the community consensus taxon.
- Per-taxon phenology histograms and per-area species rankings.
- The similar-species confusion graph, optionally scoped to an area.
- Relay licence and attribution on every record and every photo, verbatim.
- Honour the upstream rate posture from a shared egress IP: the published terms allow a maximum of 100 requests per minute, ask callers to stay at or below 60 per minute, and ask for under 10,000 requests per day; the terms also state the API is intended to support application development, not data scraping, and that blocks may be instituted without notification.
- Every input that upstream would silently widen, narrow to zero, or 500 on is rejected in-process with a typed error before a request is made.

---

## User Goals

1. **"What's been seen near me lately?"** — a point and radius, wild organisms only, recent first. → `inaturalist_search_observations`
2. **"What lives here?"** — the distinct species of an area, ranked by how often they are recorded. → `inaturalist_get_species_counts`
3. **"When does this bloom / appear here?"** — monthly or weekly phenology for a taxon in a place. → `inaturalist_get_histogram`
4. **"What is this commonly confused with?"** — the look-alike set before committing to a field identification. → `inaturalist_get_similar_species`
5. **"Tell me about this organism."** — taxonomy, conservation status by authority, photos, encyclopedia summary. → `inaturalist_get_taxon`
6. **"Turn this name into an id."** — a common or scientific name, a place name, a project, an observer. → `inaturalist_resolve_name`, `inaturalist_find_places`
7. **"Why is this record identified as it is?"** — the identification thread, who agreed, and the community consensus. → `inaturalist_get_observation`
8. **"Show me only adults / only flowering / only tracks and scat."** — annotation-filtered search. → `inaturalist_list_reference` then `inaturalist_search_observations`
9. **"Who knows this area or this group?"** — the most active observers and identifiers. → `inaturalist_get_leaderboard`
10. **"Which threatened taxa are recorded here?"** — conservation-status-filtered search. → `inaturalist_list_reference` then `inaturalist_search_observations`

---

## Response projection

**The upstream partial-response parameter does not work.** `GET /observations?fields=id&per_page=1` returned a complete 16,091-byte record — the `fields=` parameter is accepted and ignored. The only upstream trim is `only_id=true`, which returns `[{"id": …}]` and nothing else (3 ids in 110 bytes). Everything else is projected in-process.

Measured payloads, all from live probes on 2026-09-19:

| Request | Raw bytes | Note |
|:--|--:|:--|
| `/observations?per_page=2` | 94,872 | ~47 KB per observation; `identifications[]` and `comments[]` are embedded in *search* results |
| `/observations?per_page=999` | 4,318,378 | `per_page` silently clamps to 200; 200 full records |
| `/observations/{id}` | 50,671 | `identifications` 28,497 B, `non_owner_ids` 14,925 B — the latter is a near-duplicate of the former |
| `/taxa/{id}` | 95,133 | `taxon_photos` 27,377 · `listed_taxa` 26,462 · `conservation_statuses` 18,611 · `ancestors` 13,251 · `children` 6,827 |
| `/identifications/similar_species?taxon_id=48662` | 228,989 | 24 results, 5,754–11,669 B each — each is a full taxon record |
| `/places/nearby` (2+2 results) | 268,112 | `standard` alone is 246,887 B, all of it `geometry_geojson` polygons |
| `/places/autocomplete?q=Seattle` | 117,949 | 10 results, same cause |
| `/search?q=monarch&per_page=8` | 78,285 | Taxon record 11,790 B, Project record 15,522 B |
| `/observations/species_counts?per_page=501` | 662,109 | `per_page` clamps to 500 |
| `/observations/species_counts?per_page=5` | 5,898 | pre-aggregated and small at sane page sizes |
| `/observations/histogram` | 153 | month_of_year; 439 B for week_of_year |
| `/controlled_terms` | 6,613 | 7 attributes, static-ish |

### The projected observation record

The default record for `inaturalist_search_observations`. Every field name below was read from a live response; the `maps to` column names the upstream key.

| Output field | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `id` | number | `id` | Also the cursor value — see Pagination. |
| `uuid` | string | `uuid` | Stable across the id sequence. |
| `url` | string | `uri` | The upstream key is `uri`; the output field is `url`. |
| `observed_on` | string \| null | `observed_on` | `YYYY-MM-DD`. Null when the observer recorded no date. |
| `observed_at` | string \| null | `time_observed_at` | ISO 8601 with offset. |
| `taxon` | object \| null | `taxon` | `{ id, name, rank, common_name, iconic_taxon_name }` from `taxon.{id,name,rank,preferred_common_name,iconic_taxon_name}`. Null for an observation nobody has identified — declare optional and guard rather than assume. |
| `place_guess` | string \| null | `place_guess` | Free text written by the observer. Untrusted — see below. |
| `coordinate` | object \| null | `location`, `public_positional_accuracy` | `location` is the string `"lat,lng"`; split to `{ lat, lng, accuracy_m }`. Null when the observation has no public coordinate. |
| `obscured` | boolean | `obscured` | True when the true coordinate is withheld. Never resolved or approximated. |
| `geoprivacy` | string \| null | `geoprivacy` | `obscured` / `obscured_private` / `open` / `private`; observer-set. |
| `taxon_geoprivacy` | string \| null | `taxon_geoprivacy` | Same vocabulary; set automatically for threatened taxa. |
| `quality_grade` | enum | `quality_grade` | `research` / `needs_id` / `casual`. |
| `license_code` | string \| null | `license_code` | Relayed verbatim. **Null means all rights reserved** — never coerced to a string. |
| `captive` | boolean | `captive` | True for zoo animals and garden plantings. |
| `photo` | object \| null | `photos[0]` | `{ square_url, medium_url, attribution, license_code, open }` — see Photos. |
| `photo_count` | number | `photos.length` | So an agent knows `include: ["photos"]` is worth spending. |
| `sound_count` | number | `sounds.length` | |
| `observer` | string | `user.login` | The `user` object carries 22 keys including a real name; only `login` is relayed. |
| `identifications_count` | number | `identifications_count` | |
| `agreements` | number | `num_identification_agreements` | |
| `disagreements` | number | `num_identification_disagreements` | |
| `community_taxon_id` | number \| null | `community_taxon_id` | The consensus taxon; differs from `taxon.id` while a thread is contested. |

Roughly 450 bytes per record against ~16 KB raw. A 20-record page lands near 9 KB instead of 320 KB.

Dropped outright: `non_owner_ids` (duplicate of `identifications`), `place_ids` (40 integers per record with no labels), `project_ids`, `ident_taxon_ids`, `preferences`, `flags`, `votes`, `faves`, `reviewed_by`, `quality_metrics`, `outlinks`, `oauth_application_id`, `site_id`, `map_scale`, `spam`, `created_at_details`, `observed_on_details`, `geojson` (redundant with `location`), and the full `user` and `taxon` sub-objects beyond the fields above.

### `include` — opt-in expansion

`inaturalist_search_observations` accepts `include: ("photos" | "annotations" | "sounds")[]`. It deliberately does **not** accept `identifications` or `comments`: one observation's `identifications` measured 28,497 bytes, so a 20-record page would reintroduce the problem the projection exists to solve. The thread lives on `inaturalist_get_observation`, which resolves up to 10 ids in a single upstream request.

`inaturalist_get_observation` accepts `include: ("identifications" | "comments" | "photos" | "annotations" | "sounds")[]`, default `["identifications"]`.

| Expansion | Adds | Projection |
|:--|:--|:--|
| `photos` | `photos[]` | `{ square_url, medium_url, attribution, license_code, open }` per photo. |
| `annotations` | `annotations[]` | `{ attribute, value, attribute_id, value_id, by }` — decoded, see Annotations. |
| `sounds` | `sounds[]` | `{ url, attribution, license_code }`. |
| `identifications` | `identifications[]` | `{ id, taxon: {id,name,rank,common_name}, by, current, category, disagreement, from_vision, body, created_at }` from `{id, taxon, user.login, current, category, disagreement, vision, body, created_at}`. `category` is `improving` / `supporting` / `leading` / `maverick`. |
| `comments` | `comments[]` | `{ id, by, body, created_at }`. |

### Photos

The upstream spec states that the hosting domain reflects the licence: photos under `inaturalist-open-data.s3.amazonaws.com` carry open licences, photos under `static.inaturalist.org` do not. Both cases were observed — an open `cc0` photo on the S3 domain, and a `license_code: null` / `"(c) Kelly Yeates, all rights reserved"` photo on `static.inaturalist.org`.

Per photo the server emits:

- `square_url` — `photos[].url` verbatim. The upstream value is always the 75px square variant.
- `medium_url` — derived by replacing only the size qualifier in the path segment (`…/photos/737155276/square.jpg` → `…/photos/737155276/medium.jpg`). The spec documents this substitution and states every variant shares the same extension. Available qualifiers: `original`, `large`, `medium`, `small`, `thumb`, `square`. Derived by string substitution on the last path segment only; if the segment does not match the expected shape, `medium_url` is omitted rather than guessed.
- `attribution` — verbatim, never reformatted. Example: `"(c) Alejandro Lopez, some rights reserved (CC BY-NC-SA), uploaded by Alejandro Lopez"`.
- `license_code` — verbatim, nullable.
- `open` — boolean, derived from the host: `true` for `inaturalist-open-data.s3.amazonaws.com`, `false` for `static.inaturalist.org`, and `false` for any other host, since an unrecognised host is not evidence of an open licence.

**Photos are linked, never proxied.** No tool fetches image bytes, and no tool emits base64 image content. A URL plus its attribution and licence is the whole contract.

### Annotations

Upstream annotations carry no labels — only `{ controlled_attribute_id, controlled_value_id, concatenated_attr_val, user_id, user, votes, vote_score }`, where the embedded `user` is a full 22-key profile. Decoding requires `/controlled_terms`, which the service caches.

Projected to `{ attribute, value, attribute_id, value_id, by }` — e.g. `{ attribute: "Life Stage", value: "Larva", attribute_id: 1, value_id: 6, by: "the_insect_cabinet" }`. An id pair absent from the cached vocabulary emits `attribute: null` with the ids still present, rather than a fabricated label.

### One fat document: `inaturalist_get_taxon`

`/taxa/{id}` is 95 KB for a common species. Order of operations matters:

1. **Project first.** Drop `listed_taxa` entirely (26 KB of per-country checklist membership; `listed_taxa_count` is kept as a scalar). Drop the full taxon record duplicated inside each `taxon_photos[].taxon` (the bulk of that 27 KB). Trim `ancestors` and `children` to `{ id, name, rank, common_name, observations_count }`. Trim `conservation_statuses` to `{ status, authority, iucn, place, url }`. That alone brings the monarch record to roughly 11 KB.
2. **Then disclose overflow.** Run `outlineOnOverflow()` from `@cyanheads/mcp-ts-core/utils` over the *projected* document with the default 24,000-byte budget. `taxonomy`, `children`, `conservation`, `photos`, and `encyclopedia` are nested keys; `summary` is a virtual section covering the flat scalar fields at the document root (`id`, `name`, `rank`, and the rest — see `inaturalist_get_taxon` below), measured as one group for overflow accounting rather than emitted as a nested `summary` object. A taxon with hundreds of conservation statuses or children overflows and returns the outline; a typical species returns `kind: "full"`.
3. **Re-call with `sections`.** `selectSections(doc, sections, { alwaysKeep: ['id', 'name', 'rank'] })`. The selection call re-fetches (the upstream query is deterministic from `taxon_id`) and hits the service's TTL cache, so the redundant fetch costs no upstream request within the TTL.

Output is a flat object with a `kind: 'full' | 'outline'` discriminator and presence-based optional arms, per the outline-on-overflow contract; `format()` renders each arm on field presence, never by branching on `kind`.

### Places: geometry stripped to a bounding box

Every place payload embeds `geometry_geojson`, and it dominates: `/places/nearby` returned 246,887 bytes of `standard` results for two places. Each record also carries `bounding_box_geojson`, a five-point polygon of ~196 bytes.

Every place response drops `geometry_geojson` and reduces `bounding_box_geojson` to `bbox: { swlat, swlng, nelat, nelng }` by taking the min and max of its coordinates. Relayed as computed from upstream coordinates and not repaired: the North America record returned a degenerate box spanning longitudes 0.0132 to -0.0033, which is what upstream holds for a place crossing the antimeridian. A degenerate or zero-area box is passed through with no correction.

### Untrusted upstream text

`wikipedia_summary`, identification `body`, comment `body`, `place_guess`, `species_guess`, `tags`, and every photo `attribution` are written by third parties. `wikipedia_summary` additionally contains inline HTML (`<b>`, `<i>`) and is relayed verbatim rather than stripped.

`format()` renders all such free text inside a markdown blockquote, so a reading model sees it as quoted third-party content rather than instruction. Nothing in an upstream string is ever executed, followed, or used to select a code path.

### `format()` rendering contract

`format()` is the markdown twin of `structuredContent`, not a summary: every terminal field in a tool's `output` appears in the rendered text, which the `format-parity` lint enforces. Per-tool renderings are specified in the Tools — detail sections; these rules apply across all of them.

| Rule | Applies to |
|:--|:--|
| One `##` heading per record, carrying the taxon's common name and scientific name, or the record's own title. A record whose heading value is absent renders a placeholder constant rather than an empty heading. | Every list-returning tool |
| `license_code: null` renders as `All rights reserved`, never as an empty value or a dash. Any other value renders as the code itself. | Every record-bearing tool |
| A photo renders as its `medium_url` (or `square_url` when no medium variant could be derived) followed by its verbatim `attribution`, its licence, and `open licence` / `licence not open` from the domain flag. Attribution is never shortened in the text. | Every tool that returns a photo |
| `obscured: true` renders the coordinate as `obscured locality — accurate to ±{accuracy_m} m`, never as a sighting position. `obscured: false` renders `lat, lng (±{accuracy_m} m)`. | Observation records |
| Upstream free text — `wikipedia_summary`, identification and comment bodies, `place_guess`, tags, attributions — renders inside a `>` blockquote. | Every tool that surfaces it |
| A capped text list renders the first N and closes with `…and {x} more (complete list in structuredContent)`; the same cut is disclosed through `ctx.enrich.truncated`. | Tools with per-record arrays |
| The enrichment trailer carries applied defaults, totals, notices, and truncation — never hand-authored into `format()`, since `ctx.enrich` already reaches both surfaces. | Every tool |

---

## Input validation

The API answers almost any malformed query with HTTP 200 and a plausible-looking result set. Everything in this table was reproduced live on 2026-09-19.

| Input | Verified upstream behaviour | Server rule |
|:--|:--|:--|
| Unknown parameter name (`bogus_param=xyz`) | 200, `total_results: 387,388,207` — the entire global index | Only parameter names on the confirmed allowlist are ever sent. The allowlist is copied from the spec's own parameter list for each path; a new filter needs a probe before it ships. |
| `quality_grade=bogus` | 200, `total_results: 0` | Strict enum `research \| needs_id \| casual`, array-valued, joined with commas (`research,needs_id` verified to narrow correctly). |
| `iconic_taxa=Birds` | 200, `total_results: 0` — silently narrowed to nothing | Strict enum of the 14 spec values: `Actinopterygii, Amphibia, Animalia, Arachnida, Aves, Chromista, Fungi, Insecta, Mammalia, Mollusca, Plantae, Protozoa, Reptilia, unknown`. |
| `lat` without `lng`/`radius` | 200, `total_results: 387,388,228` — went global | The coordinate triple is validated as a unit: all three or none. |
| `radius` alone | 200, `total_results: 387,389,093` — went global | Same rule, enforced from both directions. |
| `d1=notadate` | 200, `total_results: 4,660,461` — identical to the unfiltered place total, so the date filter was dropped entirely | `d1` and `d2` must match `^\d{4}-\d{2}-\d{2}$`. Anything else is rejected before the request. |
| `term_value_id` without `term_id` | 200, `total_results: 4,660,477` — the filter was ignored | `term_value_id` requires `term_id`; the pair is validated together. |
| `per_page=999` | 200, clamped to 200 with no signal, 4.3 MB body | `per_page` capped in the schema: 200 for observation search, 500 for leaderboards and species counts — verified live: `/observations/observers?per_page=999` and `/observations/identifiers?per_page=999` both clamp to 500, not 200. |
| `page × per_page > 10,000` | **403** `{"error":"Result window is too large, page x size must be less than or equal to [10000]. Please narrow your search, or use a sliding window approach with id_above or id_below params.","status":403}` | Rejected in-process before the request, as a typed error whose recovery names the cursor. |
| `place_id=abc` | **500** `{"error":"Error","status":500}` | `place_id` is a positive integer in the schema. |
| `taxon_id=999999999` (as a filter) | **422** `{"error":"Unknown taxon_id 999999999","status":422}` | Mapped to a typed `unknown_taxon_id` routing to `inaturalist_resolve_name`. |
| `/taxa/abc` (path) | **422** `{"error":"Error","status":422}` — no usable message | `taxon_id` is a positive integer in the schema; the server authors the message. |
| `/taxa/999999999` (path) | 200, `total_results: 0` — not a 404 | Empty `results` is the not-found signal for every by-id path. |
| `/observations/999999999999` (path) | 200, `total_results: 0` | Same. A multi-id request silently omits ids it cannot resolve — `/observations/401617560,401644181,999999999999` returned `total_results: 2` — so a missing id is reported per-id in `unresolved`. |

### Pagination

Two mechanisms, and they are not interchangeable.

- **`page`** (1-based, default 1) walks the first 10,000 results. `page × per_page > 10,000` is refused in-process rather than sent.
- **`cursor`** continues past the window. The value is the `id` of the last record on the previous page, sent upstream as `id_below`. Verified contiguous: `order_by=id&order=desc&per_page=3` returned ids `401666986, 401666956, 401666942`; re-calling with `id_below=401666942` returned `401666869, 401666817, 401666811`.
- A cursor is only a correct continuation under id ordering, so **supplying `cursor` forces `order_by=id&order=desc`**, and the applied ordering is echoed in the enrichment block. Supplying `cursor` and `page` together is a typed error rather than a silent precedence rule.
- `total_results` drifts between calls on a live index (4,660,480 then 4,660,477 seconds apart). It is reported as an upstream estimate, not a stable count.

---

## Provenance and licensing

The API is open; the records are not uniformly open. Every record-bearing response carries:

| Signal | Source | Rule |
|:--|:--|:--|
| `license_code` | `license_code` on the observation | Verbatim, nullable. **Null means all rights reserved.** Never coerced to `""`, `"unknown"`, or a default licence. |
| Photo `attribution` | `photos[].attribution` | Verbatim, never reformatted, never truncated in `structuredContent`. |
| Photo `license_code` | `photos[].license_code` | Verbatim, nullable, independent of the observation's own licence. |
| Photo `open` | hosting domain | `inaturalist-open-data.s3.amazonaws.com` → `true`; anything else → `false`. |
| `obscured` | `obscured` | Surfaced, never resolved. When true, `coordinate.accuracy_m` carries `public_positional_accuracy` (26,839 m on the probed record) and `format()` labels the point as an obscured locality rather than a sighting position. |
| `quality_grade` | `quality_grade` | On every record. |
| `url` | `uri` | So a human can reach the source record and its full attribution. |

Observer identity collapses to `user.login`. The upstream `user` object carries `name`, `orcid`, `icon_url`, counts, and preferences; a hosted relay must not ship 20 full profiles per page nobody asked for, and the real name is not needed to credit an observation.

Photos are linked, never proxied or re-hosted.

---

## Tools — detail

Shared conventions below: every param table's `maps to` column names the verified upstream parameter; a blank means the parameter is handled in-process. Every tool that accepts an area accepts it in exactly one of three forms — `place_id`, the `lat`+`lng`+`radius` triple, or the `nelat`+`nelng`+`swlat`+`swlng` bbox — validated as a unit and refused when mixed or partial.

### `inaturalist_list_reference`

Decodes the vocabularies every other tool takes as input. Built first: it has one cached upstream dependency and grounds field-testing for the rest. It is the standing routing target for recovery strings across the surface, and nothing gates it.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `topic` | enum, required | — | `controlled_terms` \| `quality_grades` \| `licenses` \| `ranks` \| `iconic_taxa` \| `conservation_status_codes` |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Only valid with `topic: "controlled_terms"`. Adds observed annotation usage for that taxon. |

Sources per topic:

| Topic | Source | Content |
|:--|:--|:--|
| `controlled_terms` | `GET /controlled_terms`, cached 24 h | 7 attributes verified live: Life Stage (1), Sex (9), Flowers and Fruits (12), Alive or Dead (17), Evidence of Presence (22), Established (33), Leaves (36). Each with `{ id, label, multivalued, values: [{ id, label, blocking }] }`. |
| `quality_grades` | Static, spec-derived | `research`, `needs_id`, `casual`, with the data-quality criteria the spec exposes as filters: accurate, date, evidence, location, needs_id, recent, subject, wild. |
| `licenses` | Static, spec enum | `cc-by`, `cc-by-nc`, `cc-by-nd`, `cc-by-sa`, `cc-by-nc-nd`, `cc-by-nc-sa`, `cc0`, plus the null case meaning all rights reserved. |
| `ranks` | Static, spec enum | The 25 ranks `stateofmatter … form`, with the `rank_level` scale the spec documents: 70 kingdom, 60 phylum, 50 class, 40 order, 30 family, 20 genus, 10 species, 5 subspecies. |
| `iconic_taxa` | Static, spec enum | The 14 values. |
| `conservation_status_codes` | Static, spec enum | The `csi` codes `LC, NT, VU, EN, CR, EW, EX`, with the note that a taxon's `conservation_statuses[].status` is authority-specific free text (`"Special Concern"`, `"G4"`, `"Sujeta a protección especial"` all observed) while `csi` is the normalised search filter. |

With `taxon_id`, the `controlled_terms` topic adds an `observed_usage` array from `GET /observations/popular_field_values?taxon_id=`, projected to `{ attribute, value, count }` — for taxon 48662 that is Life Stage = Adult 336,576, Alive or Dead = Alive 128,365, Life Stage = Larva 127,161, and so on. The per-entry `month_of_year` breakdown is dropped.

`/controlled_terms/for_taxon` is **not** used: it matches a term's `taxon_ids` exactly rather than by ancestry, so it returned zero results for taxon 48662 (monarch), zero for 52669 (a fern), zero for 47158 (Insecta), and only "Flowers and Fruits" for 47126 (Plantae). Observed usage counts answer the same question honestly.

**Output:** `topic`, `entries[]` (shape varies by topic; `{ id, label, values[] }` for `controlled_terms`, `{ code, label, notes }` for the static topics), `observed_usage[]` (optional), `source` (`"upstream"` or `"static"`).

**format():** the topic name and its source as a header line, then one `- ` bullet per entry — `**{label}** (id {id}) — {value label} ({value id}), …` for `controlled_terms`, `**{code}** — {label}. {notes}` for the static topics. When `observed_usage` is present it follows as its own `### Observed usage` list, `{attribute} = {value} — {count} observations`, most-used first.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `taxon_id_not_applicable` | `ValidationError` | `taxon_id` was supplied with a topic other than `controlled_terms`. | `Drop taxon_id, or set topic to controlled_terms where taxon-scoped annotation usage applies.` |

**Enrichment:** `notice` when `observed_usage` is empty for the requested taxon — `No annotations have been recorded for this taxon yet; the full vocabulary above still applies.`

### `inaturalist_resolve_name`

The name-to-id front door. A miss is a result, not a failure.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `q` | string, 1–100, required | `q` | For `type: "taxon"` this is a **prefix** match or an exact id, per the spec. |
| `type` | enum, default `taxon` | `sources` | `taxon` \| `place` \| `project` \| `user` \| `any`. `taxon` routes to `/taxa/autocomplete`; everything else routes to `/search` with `sources` set to `places` / `projects` / `users`, or omitted for `any`. |
| `rank` | enum, optional | `rank` | One of the 25 ranks. Only honoured on `type: "taxon"` — `/search` has no rank filter. |
| `limit` | int 1–30, default 10 | `per_page` | |

**Routing:** `type: "taxon"` → `GET /taxa/autocomplete?q=&rank=&per_page=` (returns `matched_term`, verified). Everything else → `GET /search?q=&sources=&per_page=` (returns `{ type, score, matches[], record }`; `type` values observed: `Taxon`, `Place`, `Project`, `User`).

**Output:** `found` (boolean), `candidates[]`, `guidance` (optional).

Each candidate: `kind` (`taxon` \| `place` \| `project` \| `user`), `id`, `name`, `common_name` (optional), `rank` (optional), `display_name` (optional, places), `slug` (optional, places and projects), `matched_term` (optional — `matched_term` on the autocomplete route, the first entry of `matches[]` on the search route), `score` (optional, search route only), `observations_count` (optional), `photo` (optional, projected). No `url`: none of these record kinds returns one, and the identifier is what the other tools consume.

**format():** `found` first as `{n} candidates` or `No match`, then one `## ` heading per candidate — `{common_name} ({name})` for taxa, `{display_name}` for places, `{name}` otherwise — carrying `kind`, `id`, `rank`, `slug`, `matched_term`, `score`, and `observations_count` on a single pipe-separated line, plus the photo block. On a miss, `guidance` renders as its own paragraph rather than the enrichment trailer, because it is the primary result.

Search-route records are 11.8 KB (Taxon) to 15.5 KB (Project) each and are projected to the fields above before anything is returned.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `rank_not_applicable` | `ValidationError` | `rank` was supplied with a `type` other than `taxon`. | `Drop rank, or set type to taxon where the rank filter applies; list valid ranks with inaturalist_list_reference topic ranks.` |

**Miss (`found: false`) guidance, per condition:**

| Condition | `guidance` |
|:--|:--|
| Taxon route, zero candidates | `No taxon name starts with that text — the taxon search matches a name prefix, not words inside a name. Try the scientific name, a shorter prefix, or drop the rank filter.` |
| Taxon route, zero candidates, `rank` was set | `No taxon of that rank starts with that text. Re-run without rank, or list valid ranks with inaturalist_list_reference topic ranks.` |
| Search route, zero candidates | `No place, project, or observer matched that text. Try fewer words, or set type to any to search every record kind at once.` |

### `inaturalist_search_observations`

The spine of the surface.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `place_id` | int ≥ 1, optional | `place_id` | From `inaturalist_find_places`. Non-numeric values 500 upstream, so the schema enforces the integer. |
| `lat` | number −90…90, optional | `lat` | Requires `lng` and `radius`. |
| `lng` | number −180…180, optional | `lng` | Requires `lat` and `radius`. |
| `radius` | number 0…500, optional | `radius` | **Kilometres**. The spec names no numeric bound; live probes on 2026-09-19 confirmed 500 km and 1,000 km both return correctly scoped, non-global results (only a radius approaching the antipodal maximum, ~20,000 km, degenerates toward a global search — by circle geometry, not upstream clamping). 500 is a generous, verified ceiling, not an upstream-enforced one. Requires `lat` and `lng`. |
| `nelat` / `nelng` / `swlat` / `swlng` | number, optional | same | All four or none. |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Matches the taxon and its descendants. |
| `d1` / `d2` | string `YYYY-MM-DD`, optional | `d1` / `d2` | Observed on or after / on or before. A malformed value drops the filter upstream, so the regex is enforced. |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | Joined with commas. Widening to `needs_id` roughly doubles the corpus and lowers identification confidence. |
| `captive` | boolean, default `false` | `captive` | `false` excludes zoo animals and garden plantings. |
| `term_id` | int array, optional | `term_id` | Annotation attribute ids from `inaturalist_list_reference`. |
| `term_value_id` | int array, optional | `term_value_id` | Requires `term_id`; ignored upstream on its own. |
| `iconic_taxa` | enum array, optional | `iconic_taxa` | The 14 spec values. |
| `hrank` / `lrank` | enum, optional | `hrank` / `lrank` | Highest / lowest taxonomic rank of the identification. |
| `csi` | enum array, optional | `csi` | `LC, NT, VU, EN, CR, EW, EX`. |
| `threatened` / `native` / `introduced` / `endemic` | boolean, optional | same | Taxon status relative to the observation's location. |
| `licensed` | boolean, optional | `licensed` | The observation's own licence is not null. |
| `photo_licensed` | boolean, optional | `photo_licensed` | At least one photo's licence is not null. |
| `q` | string, optional | `q` | Free text over observation properties. |
| `search_on` | enum, optional | `search_on` | `names` \| `tags` \| `description` \| `place`. Requires `q`. |
| `order_by` | enum, default `observed_on` | `order_by` | `created_at` \| `geo_score` \| `id` \| `observed_on` \| `random` \| `species_guess` \| `updated_at` \| `votes`. Forced to `id` when `cursor` is supplied. |
| `order` | enum, default `desc` | `order` | |
| `page` | int ≥ 1, default 1 | `page` | Refused in-process when `page × per_page > 10000`. |
| `cursor` | string, optional | `id_below` | The `next_cursor` from a previous page. Mutually exclusive with `page`. |
| `per_page` | int 1–200, default 20 | `per_page` | Upstream clamps 999 to 200 silently; the schema refuses it instead. |
| `include` | enum array, optional | — | `photos` \| `annotations` \| `sounds`. |

**Output:** `total_results`, `observations[]` (the projected record), `next_cursor` (string, optional), `has_more` (boolean).

**format():** a header line carrying `total_results`, the number returned, `has_more`, and `next_cursor` when present. Then one `## ` heading per observation — `{taxon.common_name} ({taxon.name})`, or `Unidentified` when `taxon` is null — followed by `id`, `uuid`, and `url`; the date line from `observed_on` and `observed_at`; the locality line from `place_guess` and the coordinate (obscured-labelled per the contract above); a status line carrying `quality_grade`, `captive`, `geoprivacy`, `taxon_geoprivacy`, and the licence; the identification line from `identifications_count`, `agreements`, `disagreements`, and `community_taxon_id`; then the photo block with `photo_count` and `sound_count`. Included expansions render as `### Identifications` / `### Comments` / `### Photos` / `### Annotations` / `### Sounds` sub-blocks.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | An area was given partially or in two forms at once. | `Pass lat, lng and radius together, or all four of nelat, nelng, swlat and swlng, or a single place_id from inaturalist_find_places.` |
| `result_window_exceeded` | `ValidationError` | `page × per_page` would exceed the upstream 10,000-result window. | `Continue past 10,000 results by passing cursor set to next_cursor from the previous page instead of raising page.` |
| `conflicting_pagination` | `ValidationError` | Both `page` and `cursor` were supplied. | `Pass page alone to walk the first 10,000 results, or cursor alone to continue past that window.` |
| `unpaired_annotation_value` | `ValidationError` | `term_value_id` without `term_id`. | `Pass term_id alongside term_value_id; list the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.` |
| `unknown_taxon_id` | `ValidationError` | Upstream answered 422 `Unknown taxon_id`. | `Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.` (`thrownBy: 'service'`) |
| `search_on_without_query` | `ValidationError` | `search_on` without `q`. | `Pass q alongside search_on, or drop search_on to search every observation property.` |

**Enrichment:** `applied_filters` (echo of the server-applied defaults — `quality_grade`, `captive`, and the forced ordering under a cursor), `total_results`, `notice`.

**Zero-hit notice fragments, composed by condition:**

| Condition | Fragment |
|:--|:--|
| Default `quality_grade` still in force | `Only research-grade records were searched. Add "needs_id" to quality_grade to include sightings whose identification is not yet community-confirmed.` |
| Default `captive: false` still in force | `Captive and cultivated records were excluded. Set captive to true to include zoo animals and garden plantings.` |
| A date range was given | `No sightings fall in {d1}…{d2}. Widen the range, or call inaturalist_get_histogram to see which months this taxon is recorded in here.` |
| An annotation filter was given | `No sightings carry that annotation. Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.` |
| A radius was given | `No sightings within {radius} km of that point. Raise radius, or search a named area with a place_id from inaturalist_find_places.` |
| Nothing else applies | `No sightings matched. Relax one filter at a time — taxon_id and the date range are the usual culprits.` |

**Truncation:** when the page fills `per_page`, `ctx.enrich.truncated({ shown, cap, guidance })` with the guidance naming `next_cursor`.

### `inaturalist_get_observation`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `observation_id` | int array, 1–10, required | path `id` | Comma-joined into one request. Verified: three ids, one bogus, returned `total_results: 2` with the bogus id omitted. |
| `include` | enum array, default `["identifications"]` | — | `identifications` \| `comments` \| `photos` \| `annotations` \| `sounds`. |

**Output:** `observations[]` — the projected record plus, per `include`, the expansions above, plus `community_taxon` (`{ id, name, rank, common_name }` from the 1.2 KB embedded object) and `identification_disagreements_count`. `unresolved[]` — `{ observation_id }` for each requested id upstream did not return.

`non_owner_ids` (14,925 bytes on the probed record, a near-duplicate of `identifications`) is dropped.

**format():** the same per-observation block as `inaturalist_search_observations`, plus a `**Community consensus:**` line from `community_taxon` and `identification_disagreements_count`, and an `### Identification thread` list rendering each identification as `{by} → {taxon.common_name} ({taxon.name}) — {category}{, disagreement}{, from image classifier}` with the body as a blockquote beneath. `unresolved` renders as a closing `**Unresolved ids:**` list.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `not_found` | `NotFound` | None of the requested ids resolved to an observation. | `Check the observation ids, or find current ones for this area with inaturalist_search_observations.` |

Partial success is the norm: ids that resolve come back in `observations`, the rest in `unresolved`, and the call fails only when nothing resolved.

**Enrichment:** `notice` when `unresolved` is non-empty — `{n} of {total} ids returned no observation; they may have been deleted or never existed.`

### `inaturalist_get_species_counts`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| area params | as above | same | One form, validated as a unit. |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Narrows to a clade — birds within a park, say. |
| `d1` / `d2` | `YYYY-MM-DD`, optional | same | |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | |
| `captive` | boolean, default `false` | `captive` | |
| `term_id` / `term_value_id` | int arrays, optional | same | Same pairing rule. |
| `iconic_taxa` | enum array, optional | `iconic_taxa` | |
| `per_page` | int 1–500, default 25 | `per_page` | Upstream caps at 500 (501 clamped silently); 500 species measured 662 KB raw. |
| `page` | int ≥ 1, default 1 | `page` | |

**Output:** `total_results` (distinct species matching), `species[]` — `{ taxon_id, name, common_name, rank, iconic_taxon_name, observation_count, photo }`, from `results[].count` and `results[].taxon`.

**format():** `total_results` as a header line, then a numbered list ranked by `observation_count` — `{n}. **{common_name}** (*{name}*) — {observation_count} observations · {rank} · {iconic_taxon_name} · taxon_id {taxon_id}` — with the photo block indented under each entry.

**Errors:** `invalid_geography`, `unknown_taxon_id` — same reasons, codes, and recovery strings as on `inaturalist_search_observations`.

**Enrichment:** `applied_filters`, `total_results`, `notice`, truncation disclosure when the page fills.

**Zero-hit notice:** `No species recorded for that area and period. Widen the date range or the area, or set quality_grade to include "needs_id".`

### `inaturalist_get_histogram`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Omit for all taxa in the area. |
| area params | as above | same | |
| `interval` | enum, default `month_of_year` | `interval` | `year` \| `month` \| `week` \| `day` \| `hour` \| `month_of_year` \| `week_of_year`. The spec notes the absolute intervals set a default `d1`. |
| `date_field` | enum, default `observed` | `date_field` | `observed` \| `created`. |
| `d1` / `d2` | `YYYY-MM-DD`, optional | same | |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | |
| `captive` | boolean, default `false` | `captive` | |

**Output:** `interval`, `buckets[]` — `{ key, count }` in upstream key order — and `total` (the summed counts). Upstream returns `results: { month_of_year: { "1": 0, …, "12": 2 } }` in 153 bytes; the array form keeps ordering explicit for a reading model.

**format():** a header line naming `interval` and `total`, then a two-column markdown table of `key` and `count` — small enough at every interval (12 rows for `month_of_year`, 53 for `week_of_year`) to render whole, with no cap.

**Errors:** `invalid_geography`, `unknown_taxon_id` — same strings.

**Enrichment:** `applied_filters`, `notice`.

**Zero-hit notice** (every bucket zero): `Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.`

### `inaturalist_get_taxon`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `taxon_id` | int ≥ 1, required | path `id` | `/taxa/abc` answers 422 with an empty message, so the integer is enforced in the schema. |
| `sections` | string array, optional | — | Omit for the full document, or an outline when it overflows. |

**Output:** a flat object with `kind: 'full' | 'outline'`.

Full arm: `id`, `name`, `rank`, `rank_level`, `common_name`, `iconic_taxon_name`, `is_active`, `extinct`, `observations_count`, `listed_taxa_count`, `vision` (boolean — whether the taxon is covered by the upstream image classifier), plus the sections:

| Section | Content | Source |
|:--|:--|:--|
| `summary` | The scalars above, flat at the document root — not a nested `summary` key. | top-level keys |
| `taxonomy` | `ancestors[]` as `{ id, name, rank, common_name }`. | `ancestors` (13,251 B raw) |
| `children` | `{ id, name, rank, common_name, observations_count }`. | `children` (6,827 B raw) |
| `conservation` | `{ status, authority, iucn, place, url }` per entry, plus `global_status` from the singular `conservation_status`. 29 entries on the probed taxon. | `conservation_statuses`, `conservation_status` (18,611 + 542 B raw) |
| `photos` | `{ square_url, medium_url, large_url, attribution, license_code, open }` — this endpoint returns every size variant upstream, so nothing is derived here. | `taxon_photos[].photo` (27,377 B raw) |
| `encyclopedia` | `wikipedia_summary` verbatim (contains inline HTML) and `wikipedia_url`. | (555 + 46 B raw) |

Outline arm: `sections[]` (`{ name, bytes }`, largest first) and `notice`.

`listed_taxa` (26,462 B) is dropped; `listed_taxa_count` is kept. The taxon record publishes no canonical web URL for itself — `wikipedia_url` is the only link it carries, and no other link is constructed. Observations are the one record kind that returns a page URL of their own, on the `uri` key.

**format():** the two arms render on field presence, independently — never by branching on `kind`, which would fail parity against the linter's all-fields sample. The full arm renders `## {common_name} ({name})` then the scalars as a pipe-separated line, then a `### ` block per section: taxonomy as a `Kingdom › Phylum › … › Species` rank path, children as a list, conservation as a table of `status`, `authority`, `iucn`, `place`, and `url`, photos as the standard photo block, and `encyclopedia` as a blockquote followed by `wikipedia_url`. The outline arm renders through `formatOutline()` from `@cyanheads/mcp-ts-core/utils`.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `not_found` | `NotFound` | Upstream answered 200 with an empty `results` array. | `Resolve the organism name with inaturalist_resolve_name and retry with the taxon id it returns.` |
| `unknown_section` | `ValidationError` | `sections` named a key the projected document does not carry. | `Call inaturalist_get_taxon without sections to see the section outline, then name sections from that list.` |

**Enrichment:** `notice` when the outline arm fired.

### `inaturalist_get_similar_species`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `taxon_id` | int ≥ 1, required | `taxon_id` | |
| area params | as above | same | Verified to work: unscoped returned 24 look-alikes in 228,989 bytes; `place_id=46` returned 3 in 24,642 bytes. |
| `d1` / `d2`, `quality_grade`, `captive` | as above | same | The endpoint accepts the full observation filter set. |
| `limit` | int 1–50, default 20 | — | Applied in-process — the endpoint publishes no `page` or `per_page` parameter. |

**Output:** `taxon_id`, `similar_species[]` — `{ taxon_id, name, common_name, rank, observations_count, misidentification_count, photo }` from `results[].taxon` and `results[].count`. Each upstream result is a full 5.7–11.7 KB taxon record and is projected to roughly 250 bytes.

`misidentification_count` is named for what it counts — how many times identifiers corrected this taxon to the queried one — rather than the upstream key `count`.

**format():** a header line naming the queried `taxon_id` and how many look-alikes were found, then a numbered list ranked by `misidentification_count` — `{n}. **{common_name}** (*{name}*) — corrected {misidentification_count} times · {rank} · {observations_count} observations · taxon_id {taxon_id}` — with the photo block under each entry, since a look-alike without a picture is not much use in the field.

**Errors:** `unknown_taxon_id`, `invalid_geography` — same strings.

**Enrichment:** `total_results`, `notice`, truncation disclosure when `limit` cut the list.

**Zero-hit notice:** `No look-alikes are recorded for this taxon — either it is rarely misidentified, or the area filter is too narrow. Re-run without the area filter to see the global confusion set.`

### `inaturalist_find_places`

Two arms, one of which must be supplied.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `q` | string 1–100, optional | `q` | Routes to `/places/autocomplete`. Name-prefix match. |
| `nelat` / `nelng` / `swlat` / `swlng` | number, optional | same | All four together. Routes to `/places/nearby`, where the spec marks all four required. |
| `per_page` | int 1–30, default 10 | `per_page` | Honoured on the nearby arm only — `/places/autocomplete` publishes no `per_page` and returned a fixed page of 10 out of 45 matches. |

**Output:** `places[]` for the autocomplete arm; `standard[]` and `community[]` for the nearby arm, which returns `results` as an object with those two keys. Each place: `id`, `name`, `display_name`, `place_type` (int \| null), `admin_level` (int \| null), `bbox` (`{ swlat, swlng, nelat, nelng }`), `ancestor_place_ids`, `location` (`{ lat, lng }`), `slug`. No `url` — the place record carries a `slug` but no URL of its own, and none is constructed.

`place_type` and `admin_level` are relayed as the raw integers upstream returns (100, 16, 29, and null all observed). The spec publishes no code table for either, so no label is invented; `display_name` carries the human-readable context.

**format():** one `## {display_name}` heading per place, then `name`, `id`, `slug`, `place_type`, and `admin_level` on a pipe-separated line, the `bbox` as `SW {swlat}, {swlng} → NE {nelat}, {nelng}`, the centre from `location`, and `ancestor_place_ids` as a trailing containment chain. The nearby arm renders `### Standard places` and `### Community places` as separate blocks so the two lists never merge.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | Neither `q` nor a complete bbox was given, or both were. | `Pass q to search place names, or all four of nelat, nelng, swlat and swlng to list the places covering a map area.` |

**Enrichment:** `total_results`, `notice`, truncation disclosure — the autocomplete arm's fixed page of 10 against 45 matches is disclosed every time it caps.

**Zero-hit notice:** `No place name starts with that text — place search matches a name prefix. Try a shorter prefix or the official name, or pass a bounding box to list the places covering a map area.`

### `inaturalist_get_leaderboard`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `kind` | enum, required | — | `observers` → `/observations/observers`; `identifiers` → `/observations/identifiers`. |
| area params | as above | same | |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | |
| `d1` / `d2` | `YYYY-MM-DD`, optional | same | |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | |
| `per_page` | int 1–500, default 25 | `per_page` | Verified live: `per_page=999` clamps to 500 on both `/observations/observers` and `/observations/identifiers`. |
| `page` | int ≥ 1, default 1 | `page` | Refused in-process when `page × per_page > 500` — see below. |

The two endpoints return different shapes and are normalised: `observers` gives `{ user_id, observation_count, species_count, user }`, `identifiers` gives `{ user_id, count, user }`.

**Both endpoints cap the addressable window at 500 total results — far tighter than the 10,000-result window on `/observations`.** Verified live on `place_id=1`: `page=5&per_page=100` (offset 400–500) returns 100 rows; `page=6&per_page=100` (offset 500–600) returns zero, on both `/observations/observers` and `/observations/identifiers`, despite `total_results` reporting millions of candidates. There is no error signal — it is the same silent-empty failure mode the rest of this surface rejects in-process, so `page × per_page > 500` is rejected the same way rather than read as a genuine zero-hit.

**Output:** `kind`, `count_metric` (`"observations"` or `"identifications"` — names what `count` measures), `total_results`, `entries[]` — `{ rank, login, count, species_count? }`, where `species_count` is present on the observers arm only.

Top species for an area is not a `kind` here; `inaturalist_get_species_counts` already answers it and the tool description says so.

**format():** a header line naming `kind`, `count_metric`, and `total_results`, then a numbered list — `{rank}. **{login}** — {count} {count_metric}{ · {species_count} species}` — where the species clause renders only on the observers arm.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | An area was given partially or in two forms at once. | Same string as `inaturalist_search_observations`. |
| `unknown_taxon_id` | `ValidationError` | Upstream answered 422 `Unknown taxon_id`. | Same string as `inaturalist_search_observations`. (`thrownBy: 'service'`) |
| `leaderboard_window_exceeded` | `ValidationError` | `page × per_page` would exceed 500. | `This leaderboard only ranks the top 500 entries; page and per_page must multiply to 500 or less. Narrow the area, date range, or taxon_id to bring a specific user's rank into the top 500 instead.` |

**Enrichment:** `applied_filters`, `total_results`, `notice`, truncation disclosure.

**Zero-hit notice:** `Nobody has recorded observations matching those filters. Widen the date range or the area, or drop taxon_id.`

---

## Resources — detail

| Aspect | `inaturalist://taxa/{taxon_id}` | `inaturalist://observations/{observation_id}` |
|:--|:--|:--|
| `name` | `inaturalist-taxon` | `inaturalist-observation` |
| Params | `taxon_id` (positive integer) | `observation_id` (positive integer) |
| Output | The projected taxon document, always the full arm — a resource read has no way to ask for sections, so the handler returns the projected document whatever its size. | The projected observation with `identifications` expanded. |
| `mimeType` | `application/json` | `application/json` |
| Cache hint | `{ ttlMs: 21_600_000, cacheScope: 'public' }` — matches the service's 6 h taxon TTL. | `{ ttlMs: 900_000, cacheScope: 'public' }` — an observation's thread accrues identifications. |
| Miss | `notFound(...)` on an empty `results` array. | Same. |
| Tool coverage | `inaturalist_get_taxon` | `inaturalist_get_observation` |
| Completion | None. Both params are opaque integers with no bounded vocabulary. | None. |

---

## Services

| Service | Wraps | Used By |
|:--|:--|:--|
| `INaturalistService` | `https://api.inaturalist.org/v1/` — taxa, observations, places, projects, controlled terms, identifications | Every tool and both resources |

One upstream, one base URL, one rate regime, one response envelope (`{ total_results, page, per_page, results }` on every endpoint probed). Splitting it would buy nothing.

### Responsibilities

| Concern | Decision |
|:--|:--|
| **Parameter allowlist** | The service builds query strings from a per-endpoint allowlist copied from the spec's parameter list. A key not on the allowlist is never sent — an unknown parameter returns the entire 387M-record index with HTTP 200. |
| **Pacing** | A minimum start interval between outbound requests, default 1,100 ms (≈ 54 requests/minute), under the published 60/minute ask and well under the 100/minute ceiling. |
| **Concurrency** | At most 4 requests in flight. This is a separate control from pacing: several probed calls took 2.7–3.2 s, so a strictly serial lane would throttle far below the interval target while a slow call blocked everything. Start spacing bounds the rate; the in-flight cap bounds the burst. |
| **Daily budget** | An in-process counter of outbound requests per UTC day, default ceiling 9,000, under the published 10,000/day ask. Exhaustion is a typed `rate_budget_exhausted` failure, not a silent degradation. The counter resets on restart, which is documented rather than worked around — it is a guard rail for a shared egress IP, not an accounting system. |
| **Caching** | `ctx.state` (tenant-scoped KV, best-effort, independent of session mode) for the static-ish surfaces. Every read and write is wrapped so a miss or a storage failure falls through to a live fetch — correctness never depends on the cache. |
| **Cache keys** | `ctx.state` keys must match `^[a-zA-Z0-9_.\-/]+$`, so a URL cannot be a key. Keys are `inat/<surface>/<base64url of the canonical query string>` — base64url's alphabet is legal in that charset. |
| **User-Agent** | Sent on every request. Default `inaturalist-mcp-server/<version> (+https://github.com/cyanheads/inaturalist-mcp-server)` — a descriptive client name with a contact URL, per the terms' ask for identifiable clients. |
| **Retry boundary** | `withRetry` wraps fetch-plus-parse, base delay 2,000 ms — the rate-limited/degraded band, not the ephemeral one. |
| **HTTP** | `fetchWithTimeout` (15 s) with `ctx.signal`. No caller-supplied URLs ever reach it; every URL is built from the allowlist against the fixed base. |
| **Not-found mapping** | Upstream signals a missing by-id record as HTTP 200 with `results: []`, never 404. The service returns `null` for that case so each tool takes its own `not_found` path. |
| **422 mapping** | `{"error":"Unknown taxon_id N","status":422}` is mapped to `data: { reason: 'unknown_taxon_id' }` so the tool contract's reason reaches the wire. `/taxa/abc`'s bare `{"error":"Error","status":422}` never occurs, because the schema rejects the non-integer first. |
| **HTML guard** | A response body starting with `<!DOCTYPE html` or `<html` is thrown as a transient error rather than a serialization error — an edge or maintenance page is upstream degradation, not malformed data. |

### Cached surfaces

| Surface | TTL | Why |
|:--|--:|:--|
| `GET /controlled_terms` | 24 h | 7 rows, 6,613 bytes, and the annotation vocabulary is the surface every other tool routes recovery to. |
| `GET /taxa/{id}` | 6 h | A taxon profile changes on the order of months. Also what makes the outline-then-`sections` re-call free. |
| `GET /places/autocomplete`, `GET /places/nearby` | 6 h | Place boundaries are near-static. |
| `GET /observations/histogram` | 1 h | Aggregated across years; one more hour does not change a phenology curve. |
| `GET /identifications/similar_species` | 6 h | The confusion graph moves slowly and the raw payload is the largest on the surface. |

Observation search, species counts, leaderboards, and observation detail are **never cached**. Freshness is what this server is for, and upstream already sets `cache-control: public, max-age=120` on its own responses.

No rate-limit headers are returned (no `X-RateLimit-*`, no `Retry-After` on the probed responses), so pacing is entirely self-imposed — there is no upstream signal to react to.

---

## Config

| Env Var | Required | Description |
|:--|:--|:--|
| `INATURALIST_USER_AGENT` | No | `User-Agent` sent on every request. Default: `inaturalist-mcp-server/<version> (+https://github.com/cyanheads/inaturalist-mcp-server)`. Keep a contact URL in any override. |
| `INATURALIST_MIN_REQUEST_INTERVAL_MS` | No | Minimum spacing between outbound request starts. Default `1100`. |
| `INATURALIST_MAX_CONCURRENT_REQUESTS` | No | Maximum requests in flight. Default `4`. |
| `INATURALIST_DAILY_REQUEST_BUDGET` | No | Outbound requests allowed per UTC day. Default `9000`. |

No API key. Both `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`) carry all four, since `lint:packaging` checks parity.

`createApp()` declares `sessionMode: 'stateless'` — no handler calls `ctx.requestInput`, so nothing needs a live session, and the posture belongs in source rather than being left to the `auto` default.

---

## Server Instructions

Draft `instructions` string for `createApp()`:

> Citizen-science wildlife observations from iNaturalist — sightings with photos, community identification threads, phenology, look-alike species, places, and annotations. Keyless and read-only. Identifiers are integers and are not names: resolve an organism name to a taxon id with inaturalist_resolve_name and a place name or map area to a place id with inaturalist_find_places before searching, since an unrecognised filter value silently returns either the whole global index or nothing at all. Every area filter takes exactly one form — a place_id, a lat/lng/radius triple in kilometres, or a four-corner bounding box. inaturalist_search_observations defaults to research-grade, wild-only records and echoes those defaults in every response; widen them deliberately. Results past 10,000 need the cursor from the previous page rather than a higher page number. inaturalist_list_reference decodes every controlled vocabulary the other tools accept. Records carry their own licence: a null license_code means all rights reserved, photo attribution strings are relayed verbatim and must be reproduced with any image, photos are linked rather than proxied, and an obscured coordinate is a locality, not a sighting position. The upstream asks clients to stay under 60 requests a minute, so this server paces its own traffic and may queue a burst.

Identity: `name: 'inaturalist-mcp-server'`, `title: 'inaturalist-mcp-server'`.

---

## Implementation Order

1. `src/config/server-config.ts` — the four env vars, lazy `parseEnvConfig`.
2. `INaturalistService` — allowlist, pacer, concurrency cap, daily budget, TTL cache, projection helpers (`projectObservation`, `projectTaxonRecord`, `projectPlace`, `projectPhoto`, `decodeAnnotations`, `parseLocation`, `bboxFromPolygon`).
3. `inaturalist_list_reference` — one cached upstream call plus static tables; it is the routing target of nearly every recovery string, so it must exist before the rest are field-testable.
4. `inaturalist_resolve_name` — the entry point for every other tool's identifiers.
5. `inaturalist_find_places` — the second identifier source; exercises the bbox projection.
6. `inaturalist_search_observations` — the spine; exercises the full validation and projection layer.
7. `inaturalist_get_observation` — batch fetch and the identification-thread projection.
8. `inaturalist_get_species_counts`, `inaturalist_get_histogram`, `inaturalist_get_leaderboard` — the aggregate trio; they share the area-and-filter validator built in step 6.
9. `inaturalist_get_taxon` — projection plus `outlineOnOverflow` / `selectSections`.
10. `inaturalist_get_similar_species`.
11. Resources.

Each step is independently testable against recorded upstream payloads.

---

## API Reference

Base URL `https://api.inaturalist.org/v1/`. The published spec lists 86 paths, 41 of them GET with no declared security. Everything below was exercised live on 2026-09-19.

### Endpoints used

| Endpoint | Purpose | Auth in spec |
|:--|:--|:--|
| `GET /taxa/autocomplete` | Name prefix → taxon. `q` is required and matches a name prefix or an exact id. | keyless |
| `GET /search` | Name → Taxon / Place / Project / User, scored. `sources` filters by kind. | keyless |
| `GET /taxa/{id}` | Taxon profile. Accepts a comma-separated id list. | keyless |
| `GET /identifications/similar_species` | Confusion graph. Accepts the full observation filter set; no pagination parameters. | keyless |
| `GET /observations` | Observation search. 105 parameters. | optional api-token |
| `GET /observations/{id}` | Observation detail. Accepts a comma-separated id list; unresolvable ids are omitted. | optional api-token |
| `GET /observations/species_counts` | Distinct species ranked. `per_page` max 500. | keyless |
| `GET /observations/histogram` | Phenology. `interval` default `month_of_year`, `date_field` default `observed`. | keyless |
| `GET /observations/observers` · `/identifiers` | Leaderboards; different result shapes. | keyless |
| `GET /observations/popular_field_values` | Annotation usage counts for a taxon. | keyless |
| `GET /controlled_terms` | Annotation vocabulary, 7 attributes. | keyless |
| `GET /places/autocomplete` | Place name prefix → place. No `per_page`; returns 10. | keyless |
| `GET /places/nearby` | Places covering a bbox. All four corners required; `results` is `{ standard, community }`. | keyless |

The optional api-token on the two observation paths only unlocks coordinates hidden from the public. Every probe succeeded without it and the server never sends one.

### Verified vocabularies

| Vocabulary | Values |
|:--|:--|
| `quality_grade` | `casual`, `needs_id`, `research` |
| `license` / `photo_license` | `cc-by`, `cc-by-nc`, `cc-by-nd`, `cc-by-sa`, `cc-by-nc-nd`, `cc-by-nc-sa`, `cc0` |
| `iconic_taxa` | `Actinopterygii`, `Amphibia`, `Animalia`, `Arachnida`, `Aves`, `Chromista`, `Fungi`, `Insecta`, `Mammalia`, `Mollusca`, `Plantae`, `Protozoa`, `Reptilia`, `unknown` |
| `rank` / `hrank` / `lrank` | `stateofmatter`, `kingdom`, `phylum`, `subphylum`, `superclass`, `class`, `subclass`, `superorder`, `order`, `suborder`, `infraorder`, `superfamily`, `epifamily`, `family`, `subfamily`, `supertribe`, `tribe`, `subtribe`, `genus`, `genushybrid`, `species`, `hybrid`, `subspecies`, `variety`, `form` |
| `rank_level` | 70 kingdom, 60 phylum, 50 class, 40 order, 30 family, 20 genus, 10 species, 5 subspecies |
| `csi` | `LC`, `NT`, `VU`, `EN`, `CR`, `EW`, `EX` |
| `geoprivacy` / `taxon_geoprivacy` | `obscured`, `obscured_private`, `open`, `private` |
| `interval` | `year`, `month`, `week`, `day`, `hour`, `month_of_year`, `week_of_year` |
| `order_by` (observations) | `created_at`, `geo_score`, `id`, `observed_on`, `random`, `species_guess`, `updated_at`, `votes` |
| identification `category` | `improving`, `supporting`, `leading`, `maverick` |
| `search_on` | `names`, `tags`, `description`, `place` |
| `sources` (`/search`) | `places`, `projects`, `taxa`, `users` |
| annotation attributes | Life Stage (1), Sex (9), Flowers and Fruits (12), Alive or Dead (17), Evidence of Presence (22), Established (33), Leaves (36) |

### Terms of use, as published in the spec

Maximum 100 requests per minute, with an ask to stay at or below 60 per minute and under 10,000 per day. The API is stated to be intended for application development, not data scraping, and blocks may be instituted without notification. Photos on `inaturalist-open-data.s3.amazonaws.com` are shared under open licences; photos on `static.inaturalist.org` are not, and a photo's domain can change when its licence changes.

---

## Known Limitations

- **No upstream field selection.** `fields=` is accepted and ignored, so every byte is fetched before being projected away. Projection saves the agent's context, not the network.
- **Counts drift under the query.** `total_results` moved by three between two calls seconds apart. It is an estimate of a live index.
- **`place_type` and `admin_level` have no published code table.** Raw integers are relayed; `display_name` carries the meaning.
- **`/controlled_terms/for_taxon` matches exactly, not by ancestry**, so it is empty for most taxa. Observed annotation usage is served from `popular_field_values` instead.
- **Bounding boxes can be degenerate upstream** for places crossing the antimeridian. Relayed as given, not repaired.
- **A photo's licence can change**, which moves it between hosting domains. The `open` flag reflects the domain at fetch time, not a permanent property.
- **Obscured coordinates cannot be resolved**, by design. A threatened-taxon record reports a locality with an accuracy radius in the tens of kilometres.
- **A single oversized section stays oversized.** `selectSections` returns what the agent named; a taxon whose `conservation` section alone exceeds the outline budget comes back whole, because truncating a section the agent asked for by name is the failure the outline exists to prevent.
- **The daily request counter is per process.** A restart resets it, and two processes behind one egress IP do not share it.
- **Leaderboard endpoints cap at 500 total results, not the 10,000 window of `/observations`.** `/observations/observers` and `/observations/identifiers` return an empty result set once `page × per_page` exceeds 500, verified live, despite `total_results` reporting millions of candidates. `inaturalist_get_leaderboard` rejects the combination in-process rather than surfacing a false zero-hit.

---

## Out of Scope

- **Computer vision.** The v1 spec publishes 86 paths and none of them is a `/computervision/*` endpoint; image scoring is not part of this API surface. The keyless proxy for classifier coverage is the taxon record's `vision` boolean, which `inaturalist_get_taxon` surfaces.
- **Observation fields.** There is no `/observation_fields` path in v1. `/observation_field_values` exists but publishes only POST, PUT, and DELETE — writes.
- **All writes.** No POST, PUT, or DELETE, on any path, under any configuration. Every registered tool and resource is `readOnlyHint: true`.
- **Authenticated surfaces.** `/users/me`, messages, updates, and vote endpoints need a 24-hour token this server never obtains. It also never sends an `Authorization` header on the two observation paths where the spec marks one optional, so hidden coordinates stay hidden.

---

## Decisions Log

| Decision | Rationale |
|:--|:--|
| **Projection happens in-process, unconditionally, on every response.** | `fields=` is accepted and ignored upstream, and `only_id=true` is the sole trim. Two observations measured 94,872 bytes; 200 measured 4.3 MB. There is no configuration in which relaying raw payloads is viable. |
| **Project first, then `outlineOnOverflow`.** | Running the outline over the raw 95 KB taxon record would outline `listed_taxa` — 26 KB of per-country checklist membership nobody asked for. Dropping known-noise fields before measuring means the overflow path fires on genuinely large taxa instead of on every taxon. |
| **`inaturalist_search_observations` excludes `identifications` and `comments` from `include`.** | One observation's `identifications` array measured 28,497 bytes. A 20-record page would reintroduce exactly the problem the projection exists to solve. The thread lives on `inaturalist_get_observation`, which resolves up to 10 ids in one upstream request. |
| **`inaturalist_get_observation` takes a batch of up to 10 ids.** | The path accepts a comma-separated list and resolves the whole batch in one request — verified. Against a 10,000-request daily budget shared by every tenant on one egress IP, ten lookups for the price of one is the difference between a usable and an unusable hosted deployment. |
| **A missed id in a batch is reported per-id, not thrown.** | `/observations/401617560,401644181,999999999999` returned `total_results: 2`, silently omitting the bogus id. Resolved ids land in `observations`, the rest in `unresolved`, and the call fails only when nothing resolved — one bad id must not cost the other nine. |
| **`inaturalist_get_taxon` takes one id, though the path accepts a list.** | The outline-and-`sections` contract is per-document: `outlineOnOverflow` measures one payload and `selectSections` projects one document. A batch arm would need a per-document outline, which the technique does not define. |
| **`inaturalist_resolve_name` returns `{ found: false, guidance }` rather than throwing.** | Its whole job is resolving one name to an id, so a miss is an expected outcome the agent must reason about. The guidance names the specific reason — prefix matching, an over-narrow rank — because "no results" alone tells the agent nothing it can act on. |
| **`inaturalist_get_leaderboard` has no `species` arm.** | It would return exactly what `inaturalist_get_species_counts` already returns. A duplicate arm is cognitive load at tool-selection time; a cross-reference in the description costs nothing. |
| **`inaturalist_find_places` and `inaturalist_resolve_name` both reach places, and both stay.** | They answer different questions: `resolve_name` scores a name across every record kind and returns an id; `find_places` returns the bounding box, place type, and ancestry an area search needs, and carries the bbox arm that answers "what places cover this map view." |
| **Both `page` and `cursor` are exposed, and supplying both is an error.** | `page` is what an agent reaches for and is correct inside the 10,000-record window; `cursor` is the only thing that works past it. A silent precedence rule between them would make a deep page quietly return the wrong records. |
| **A cursor forces `order_by=id&order=desc`, and the forced ordering is echoed.** | `id_below` is only a correct continuation under id ordering; under any other sort it filters by id while ordering by something else, silently skipping records. Forcing it is right, and echoing it is required because it changes what the result means. |
| **Defaults that change result meaning are echoed in every response.** | `quality_grade: ["research"]` and `captive: false` are safe defaults on the two parameters that most determine what an answer means. An agent cannot reason about a filter it cannot see, so both ride the enrichment block on every call, not just empty ones. |
| **`license_code` is relayed as a nullable string, never coerced.** | Null means all rights reserved, which is a fact about the record. Substituting `"unknown"` or `""` would turn a legal constraint into a formatting artefact. `format()` renders the null case in words; `structuredContent` keeps the null. |
| **Photo `medium_url` is derived; nothing else about a photo is.** | The spec documents the size-qualifier substitution and the shared extension, so the derivation is upstream-sanctioned rather than guessed — and the endpoint that already returns every variant (`/taxa/{id}`) is relayed as-is instead. A path segment that does not match the expected shape yields no `medium_url` at all. |
| **The photo `open` flag is derived from the hosting domain.** | The spec states the domain reflects the licence. An unrecognised host resolves to `false`, because not recognising a host is not evidence that a photo is openly licensed. |
| **Photos are linked, never proxied.** | Re-serving images would put this server in the redistribution path for content whose licences it does not control, and would blow any sane context budget. A URL with its verbatim attribution and licence is the whole contract. |
| **Observer identity collapses to `login`.** | The upstream `user` object carries 22 keys including a real name and an ORCID. None of it is needed to credit an observation, and a hosted relay should not ship 20 profiles per page nobody asked for. |
| **The server never sends an `Authorization` header.** | The spec marks an optional api-token on the two observation paths whose only effect is unlocking coordinates hidden from the public. Obscured localities are a protection for threatened taxa, and a read-only public relay has no business seeking around it. |
| **Every parameter is sent from a per-endpoint allowlist.** | An unknown parameter name returns HTTP 200 and the entire 387M-record index. Without an allowlist, one typo anywhere in the service turns a scoped query into a global one with no signal at any layer. |
| **A malformed date is rejected rather than sent.** | `d1=notadate` returned the unfiltered place total — upstream drops the filter entirely. A result set that looks fine and silently ignores the date range is worse than a rejection the agent can fix. |
| **`term_value_id` requires `term_id`, enforced in-process.** | Sent alone it is silently ignored and the caller gets the unfiltered corpus back believing it was annotation-filtered. |
| **Pacing and the concurrency cap are two knobs, not one.** | Probed call durations ranged from 9 ms to 3.2 s. A single serial lane would fall far below the target rate whenever a slow call landed; start spacing bounds the sustained rate, the in-flight cap bounds the burst. |
| **A per-UTC-day request budget, failing loudly at exhaustion.** | The published ask is under 10,000 requests a day per IP, and a hosted deployment shares one egress IP across every tenant. Degrading silently at the ceiling would look like an upstream outage; a typed failure names the actual constraint. |
| **`inaturalist_get_leaderboard` rejects `page × per_page` above 500 in-process.** | Both `/observations/observers` and `/observations/identifiers` return an empty result set once the combined window passes 500 — verified live up to `page=6, per_page=100` — a far smaller ceiling than the 10,000-result window on `/observations`. Left unchecked, an agent paging past it reads a pagination limit as a genuine zero-hit. |
| **Only the static-ish surfaces are cached.** | Controlled terms, taxa, places, histograms, and the similar-species graph change on the order of hours to months and account for the largest raw payloads. Observation search is never cached — freshness is the product. |
| **The cache rides `ctx.state`, best-effort, with base64url keys.** | `ctx.state` is independent of session mode and needs no stateful sessions. Its key charset excludes `?`, `&`, and `=`, so a URL cannot be a key; base64url's alphabet is legal as-is. Every read and write is wrapped so a storage failure falls through to a live fetch. |
| **No DataCanvas, and no dataframe tools.** | `species_counts`, `histogram`, and `popular_field_values` arrive pre-aggregated and small — a five-species page measured 5,898 bytes and a histogram 153. Observation search is discovery over categorical metadata, which is the shape the canvas gate explicitly excludes. Nothing on this surface should emit a `canvas_id`, and no `dataframe_query` / `dataframe_describe` pair should be added. |
| **No prompts.** | The server is lookup- and discovery-oriented. The workflow chain belongs in the `instructions` string and the tool descriptions, where every client sees it, rather than in a template most clients never surface. |
| **Two resources, mirroring two tools.** | Taxa and observations are the only entities here with stable, URI-addressable identifiers worth injecting as conversation context. Places are intermediate results and reference vocabularies are tool output. Both resources duplicate tool-reachable data, so a tool-only client loses nothing. |
| **`sessionMode: 'stateless'`.** | No handler calls `ctx.requestInput`, so nothing needs a live session. Declaring it in source beats leaving it to the `auto` default, which resolves to stateful. |
| **No `title` on any tool or resource; `name` is the display surface.** | The server's own identity is the bare hyphenated repo name on every surface, and a Title Case tool or resource title would reintroduce exactly the display-name convention the identity rule exists to prevent. |
| **Upstream free text renders inside a blockquote.** | `wikipedia_summary`, identification and comment bodies, `place_guess`, tags, and attribution strings are all written by third parties. Quoting them in `format()` marks them as content to report on rather than instruction to follow. |
| **`/controlled_terms/for_taxon` is not used.** | It matched zero terms for a butterfly, a fern, and Insecta, and one term for Plantae — it tests exact `taxon_ids` membership rather than ancestry. `popular_field_values` answers the real question with real counts. |
