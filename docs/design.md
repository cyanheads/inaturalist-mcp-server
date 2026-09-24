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
| `identifications_count` | number | `identifications_count` | Upstream's tally of identifications currently agreeing or disagreeing with the community taxon — equal to `agreements + disagreements` on every one of 270 sampled records. **Not the thread size**: it leaves out the observer's own identification and any that neither agrees nor disagrees (a coarser guess, a withdrawn one) — 116370592 has 14 identifications from 14 non-owners and `identifications_count: 6`, the six made at the community taxon itself. The thread size is `identifications_total` on `inaturalist_get_observation`. |
| `agreements` | number | `num_identification_agreements` | Identifications currently at the community taxon, the observer's own excluded (402402822: the observer's matching identification plus one other, `agreements: 1`). |
| `disagreements` | number | `num_identification_disagreements` | Identifications currently disagreeing with the community taxon. |
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
| `identifications` | `identifications[]`, `identifications_total`, `identifications_shown` | `{ id, taxon: {id,name,rank,common_name}, by, current, category, disagreement, from_vision, body, created_at }` from `{id, taxon, user.login, current, category, disagreement, vision, body, created_at}`. `category` is `improving` / `supporting` / `leading` / `maverick`. Capped per record on the by-id surfaces — see Response size budget: the by-id array cap. |
| `comments` | `comments[]`, `comments_total`, `comments_shown` | `{ id, by, body, created_at }`. Capped the same way. |

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

### Response size budget: the list tools

A single document gets the outline treatment above. A list tool gets a smaller page instead — no outline arm, no truncated records, `structuredContent` and `content[]` both complete for whatever page was asked for. Two thresholds set the caps, and the per-record cost is measured across **both** surfaces, since every record is serialised once as JSON and again as rendered markdown:

- **Default page ≤ 24,000 bytes** — the same budget `outlineOnOverflow` gives one document. A caller who names no `per_page` gets a page that fits it.
- **Advertised maximum ≤ 50,000 bytes** — a list is not one document, so the ceiling is twice the document budget. Past that, the answer is another page, not a bigger one.

Measured live on 2026-09-19 against `place_id: 97394` (North America):

| Tool | Bytes per record | Upstream would serve | `per_page` max | Full page at the max | Default | Default page |
|:--|--:|--:|--:|--:|--:|--:|
| `inaturalist_search_observations` | ~1,973 | 200 | 25 | 49,319 B | 10 | ~19,700 B |
| `inaturalist_get_species_counts` | ~856 | 500 | 50 | 42,780 B | 25 | ~21,400 B |
| `inaturalist_get_leaderboard` | ~137 | 500 | 250 | 34,182 B | 25 | ~3,400 B |
| `inaturalist_get_histogram` | ~58 (10-char day key + up to a 5-digit count, JSON entry plus one markdown row) | unbounded — `interval=day&d1=1900-01-01&taxon_id=48662` measured 25,531 buckets / 388,530 B | 800 (a bucket cap, not a `per_page`) | ~46,800 B | — (one uncapped response; no smaller default page) | — |

Sizes are the whole `tools/call` reply. Nothing is lost at the lower caps: `page` and `cursor` reach the same records, and two leaderboard pages of 250 cover the whole 500-entry window those endpoints rank. `inaturalist_find_places` (max 30; ten places measured 6,752 bytes, so ~675 each) and `inaturalist_get_similar_species` (max 50, over look-alikes projected to roughly 250 bytes each) already sit inside both thresholds and are unchanged. `include: ["photos"]` on an observation search multiplies the per-record cost and is the caller's own call to make — the field's description says as much. `inaturalist_get_histogram` has no page/default split — it is a single response, so the cap targets the 50,000-byte advertised maximum directly rather than the smaller default; the first 800 buckets in upstream key order are kept, `total` still sums every bucket upstream returned, and the `truncated`/`shown`/`cap` enrichment discloses the cut the way every other list tool does.

### Response size budget: the by-id array cap

`inaturalist_get_observation` and the `inaturalist://observations/{observation_id}` resource take no page size, and three arrays are what grows: 5890862 carries 1,114 identifications, 1,377 comments, and 906 filled observation fields. Before any cap, one id measured 624,791 bytes with the default `include`, 1,147,654 bytes with `comments` added, and 504,204 bytes as a resource read. With only the threads capped, relaying the 906 fields whole still added 86–94 KB to each reply.

**The rule.** `identifications[]`, `comments[]`, and `observation_fields[]` share one 40-entry budget across the records a call returns: each array on each record keeps its first `max(4, floor(40 / records returned))` entries — 40 for one id and for the resource, 20 for two, 4 for nine or ten. A repeated id is one record returned, although upstream answers it once per repetition. The thread arrays are cut before projection, so a 1,114-entry thread costs 40 projections; observation fields are counted after blank values are dropped, so the cap measures fields a reader could see. Each capped array carries its `_total` / `_shown` pair — the entries upstream holds against the entries kept — on every response, under-cap ones included: `identifications_*` and `comments_*` whenever the arm was included, `observation_fields_*` on every by-id record. On a cut, the tool writes one `notice` naming each cut id with the arrays it cut and the recovery: re-request a single id for the 40-entry view, or open the record's `url` for the full record. No tool wraps upstream `/identifications?observation_id=`, so the notice names none. The resource has no enrichment trailer; its counts are the disclosure. `agreements`, `disagreements`, and `community_taxon_id` still summarize the whole thread, and `description` — one string — is never cut.

**Upstream order is not chronological.** It is stable across repeated reads and roughly ascending, but not sorted: on 5890862, 16 of 1,114 identifications and 386 of 1,377 comments are dated earlier than the entry before them (116370592: 2 of 14 and 1 of 12). The kept entries are the first in upstream order, which is what the headings and the notice say — never "the earliest".

**Per-entry cost** across both surfaces of the reply, from a sample of 61 records: identifications mean 557 B, p90 591 B; comments mean 378 B, p90 603 B. On 5890862 the 40 kept identifications measured about 21,400 bytes, its 40 comments 12,053, and its 40 kept observation fields 3,301 (~83 B each).

Measured live on 2026-09-23 with the cap on all three arrays, whole `tools/call` reply (or `resources/read` reply). The batch is 5890862, 106687320, 322939816, 66463326, 264619200, 3704154, 101960556, 189784392, 116370592, 402402822, returned in that order.

| Call | Reply |
|:--|--:|
| 5890862, default `include` | 28,050 B |
| 5890862, `identifications` + `comments` | 40,102 B |
| 10-id batch, default `include` | 53,155 B |
| 10-id batch, `identifications` + `comments` | 66,853 B |
| `inaturalist://observations/5890862` | 25,336 B |
| 402402822 (two-entry thread, no fields — the common case) | 3,836 B |

A single id now stays under the 50,000-byte advertised maximum with both thread arms. The capped arrays hold near the budget at any batch size, but the budget bounds the arrays, not the records around them: the ten records' own fields add roughly 27 KB, so a ten-id batch lands past 50,000 bytes — 53,155 with the default `include`, 66,853 with comments.

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
| The text renders every record of the page. Volume is bounded by the caller through `per_page` and each tool's cap, so the text is never cut shorter than `structuredContent`; a cap that was reached is disclosed through `ctx.enrich.truncated`. | Tools with per-record arrays |
| The enrichment trailer carries applied defaults, totals, notices, and truncation — never hand-authored into `format()`, since `ctx.enrich` already reaches both surfaces. | Every tool |
| A field renders only when the response carries its key. A field a selection left out is omitted rather than shown as absent; null-case text (`no common name`, `not published`) is reserved for a value upstream genuinely left null. | Tools returning a slice of a record (`inaturalist_get_taxon` with `sections`) |

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
| `d1=notadate` | 200, `total_results: 4,660,461` — identical to the unfiltered place total, so the date filter was dropped entirely | `d1` and `d2` must match `^\d{4}-\d{2}-\d{2}$`. Anything else is rejected before the request. A blank string is the one exception: form clients submit every optional string field, blank when untouched, so a blank `d1`, `d2`, `q`, or `cursor` is treated as unset rather than as a malformed value. |
| `d1=2026-02-30`, `d1=2025-13-01` (well-shaped, not a real day) — verified 2026-09-22 | 200 on `/observations/species_counts?place_id=14`: `d1=2026-02-30&d2=2026-03-05` returned 51,499, identical to `d2` alone; `d1=2025-13-01` returned 54,336, identical to no date at all — the bound is dropped | Calendar validity is refined onto the same schema as the pattern, so an impossible day fails exactly as `notadate` does, on `d1` and `d2` independently. The advertised JSON Schema still carries only the pattern. Leap days follow the proleptic Gregorian calendar upstream applies: `d2=0000-02-29` narrows to zero results (a real day), while `1900-02-29` and `0100-02-29` are dropped like `2026-02-30`. |
| `d1` after `d2` — verified 2026-09-22 | 200, `total_results: 0` | Rejected in-process as `inverted_date_range` on every tool taking `d1`/`d2`. Equal bounds are a valid single day. |
| `hrank` finer than `lrank` (`hrank=family&lrank=order`) — verified 2026-09-22 | 200, `total_results: 0`. Upstream compares rank *levels*: `hrank=hybrid&lrank=species` and `hrank=variety&lrank=subspecies` both return the full band | Rejected in-process as `inverted_rank_range` when `hrank`'s level is below `lrank`'s. Ranks sharing a level (genus/genushybrid 20, species/hybrid 10, subspecies/variety/form 5) are valid in either order, as is an equal pair. Every adjacent pair of distinct levels, inverted, returns 0 upstream, so the rejection set is exactly upstream's empty set. |
| `radius=0` — verified 2026-09-22 | **500** `Elasticsearch error`, retried four times (~14 s) before surfacing as an upstream fault; a negative radius answers the same 500. Any positive radius answers 200, down to `radius=1e-12` | `invalid_geography` before any request: `radius` must be greater than 0. The bound lives in the handler rather than the schema so the failure carries the area recovery hint. |
| Bounding box with `nelat` south of `swlat` — verified 2026-09-22 | **500** `Elasticsearch error` on `/observations/species_counts` and `/places/nearby` alike, retried as above | `invalid_geography` before any request, on every area-scoped tool and on `inaturalist_find_places`' own box. `nelng` west of `swlng` is an antimeridian-crossing box and stays valid — `nelat=66&nelng=-170&swlat=52&swlng=170` answers 200 on every area endpoint and `/places/nearby` (1,623 species on `/observations/species_counts`). Equal latitudes are served too, so `nelat == swlat` passes. |
| `term_value_id` without `term_id` | 200, `total_results: 4,660,477` — the filter was ignored | `term_value_id` requires `term_id`; the pair is validated together. |
| `per_page=999` | 200, clamped to 200 with no signal, 4.3 MB body | `per_page` capped in the schema well below the upstream clamp — 25 for observation search, 50 for species counts, 250 for leaderboards. The caps are sized by response bytes, not by what upstream will serve; see Response size budget. Upstream's own clamps, verified live: `/observations` clamps to 200, and `/observations/observers?per_page=999` and `/observations/identifiers?per_page=999` both clamp to 500, not 200. |
| `page × per_page > 10,000` | **403** `{"error":"Result window is too large, page x size must be less than or equal to [10000]. Please narrow your search, or use a sliding window approach with id_above or id_below params.","status":403}` | Rejected in-process before the request, as a typed error whose recovery names the cursor. |
| `place_id=abc` | **500** `{"error":"Error","status":500}` | `place_id` is a positive integer in the schema. |
| `id_below=notanumber` (`cursor`) | **500** `{"error":"Error","status":500}` | `cursor` is validated against `^[1-9]\d*$` in the schema — the server's own `next_cursor` is always a decimal observation id, the same way `place_id` enforces an integer. |
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

**Truncation disclosure is unconditional.** Every tool that caps a list declares `truncated`, `shown`, and `cap` as *required* enrichment, and writes all three on every path the handler can take — a zero-hit page and an under-cap page both report `truncated: false` alongside what they did return. `ctx.enrich.truncated(...)` overwrites those three, and supplies the guidance notice, only where the cap actually bit. The framework validates the merged enrichment against `output.extend(enrichment)`, so a required field written on one branch only is not a missing field on the others — it is a failed call.

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
| `unknown_taxon_id` | `ValidationError` | iNaturalist answered 422 because the taxon_id does not exist. | `Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.` (`thrownBy: 'service'`) |

**Enrichment:** `notice` when `observed_usage` is empty for the requested taxon — `No annotations have been recorded for this taxon yet; the full vocabulary above still applies.`

### `inaturalist_resolve_name`

The name-to-id front door. A miss is a result, not a failure.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `q` | string, 1–100, required | `q` | For `type: "taxon"` this is a **prefix** match or an exact id, per the spec. |
| `type` | enum, default `taxon` | `sources` | `taxon` \| `place` \| `project` \| `user` \| `any`. `taxon` routes to `/taxa/autocomplete`; everything else routes to `/search` with `sources` set to `places` / `projects` / `users`, or omitted for `any`. |
| `rank` | enum, optional | `rank` | One of the 25 ranks. Only honoured on `type: "taxon"` — `/search` has no rank filter. |
| `limit` | int 1–30, default 10 | `per_page` | Also applied in-process on every route: `/taxa/autocomplete` returns related taxa past its `per_page` (`q=monarch&per_page=1` returned 4, `per_page=3` returned 5, verified 2026-09-22), so the candidate list is sliced to `limit`. `totalCount` still reports upstream's `total_results`. |

**Routing:** `type: "taxon"` → `GET /taxa/autocomplete?q=&rank=&per_page=` (returns `matched_term`, verified). Everything else → `GET /search?q=&sources=&per_page=` (returns `{ type, score, matches[], record }`; `type` values observed: `Taxon`, `Place`, `Project`, `User`).

**Output:** `found` (boolean), `candidates[]`, `guidance` (optional).

Each candidate: `kind` (`taxon` \| `place` \| `project` \| `user`), `id`, `name` (scientific name, place name, project title, or an observer's display name — falling back to the login when the observer set none), `login` (optional, users only — the record's `login`, the same value `inaturalist_get_leaderboard`'s `entries[].login` and an observation's `observer` carry, so a user candidate joins to both), `common_name` (optional), `rank` (optional), `display_name` (optional, places), `slug` (optional, places and projects), `matched_term` (optional — `matched_term` on the autocomplete route, the first entry of `matches[]` on the search route), `score` (optional, search route only), `observations_count` (optional), `photo` (optional, projected). No `url`: none of these record kinds returns one, and the identifier is what the other tools consume.

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
| Search route (`place` / `project` / `user`), zero candidates | `No place, project, or observer matched that text. Try fewer words, or set type to any to search every record kind at once.` |
| `type: "any"`, zero candidates | `Nothing matched that text across taxa, places, projects, or observers. Try fewer words or a different spelling; for an organism, type taxon matches a name prefix.` |

### `inaturalist_search_observations`

The spine of the surface.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `place_id` | int ≥ 1, optional | `place_id` | From `inaturalist_find_places`. Non-numeric values 500 upstream, so the schema enforces the integer. |
| `lat` | number −90…90, optional | `lat` | Requires `lng` and `radius`. |
| `lng` | number −180…180, optional | `lng` | Requires `lat` and `radius`. |
| `radius` | number ≤ 500, optional | `radius` | **Kilometres**, greater than 0 — a zero or negative radius fails as `invalid_geography` before the request (upstream answers `radius=0` with HTTP 500). The spec names no numeric bound; live probes on 2026-09-19 confirmed 500 km and 1,000 km both return correctly scoped, non-global results (only a radius approaching the antipodal maximum, ~20,000 km, degenerates toward a global search — by circle geometry, not upstream clamping). 500 is a generous, verified ceiling, not an upstream-enforced one. Requires `lat` and `lng`. |
| `nelat` / `nelng` / `swlat` / `swlng` | number, optional | same | All four or none. `nelat` must be at or north of `swlat`; `nelng` west of `swlng` is an antimeridian-crossing box and is accepted. |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Matches the taxon and its descendants. |
| `d1` / `d2` | string `YYYY-MM-DD`, optional | `d1` / `d2` | Observed on or after / on or before. A malformed or calendar-invalid value drops the filter upstream, so both the pattern and calendar validity are enforced in the schema; `d1` after `d2` fails as `inverted_date_range`. |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | Joined with commas. Widening to `needs_id` roughly doubles the corpus and lowers identification confidence. |
| `captive` | boolean, default `false` | `captive` | `false` excludes zoo animals and garden plantings. |
| `term_id` | int array, optional | `term_id` | Annotation attribute ids from `inaturalist_list_reference`. |
| `term_value_id` | int array, optional | `term_value_id` | Requires `term_id`; ignored upstream on its own. |
| `iconic_taxa` | enum array, optional | `iconic_taxa` | The 14 spec values. |
| `hrank` / `lrank` | enum, optional | `hrank` / `lrank` | Highest (coarsest) / lowest (finest) taxonomic rank of the identification. Compared by rank level, as upstream does; an `hrank` below `lrank`'s level fails as `inverted_rank_range`. |
| `csi` | enum array, optional | `csi` | `LC, NT, VU, EN, CR, EW, EX`. |
| `threatened` / `native` / `introduced` / `endemic` | boolean, optional | same | Taxon status relative to the observation's location. |
| `licensed` | boolean, optional | `licensed` | The observation's own licence is not null. |
| `photo_licensed` | boolean, optional | `photo_licensed` | At least one photo's licence is not null. |
| `q` | string, optional | `q` | Free text over observation properties. |
| `search_on` | enum, optional | `search_on` | `names` \| `tags` \| `description` \| `place`. Requires `q`. |
| `order_by` | enum, default `observed_on` | `order_by` | `created_at` \| `geo_score` \| `id` \| `observed_on` \| `random` \| `species_guess` \| `updated_at` \| `votes`. Forced to `id` when `cursor` is supplied. |
| `order` | enum, default `desc` | `order` | |
| `page` | int ≥ 1, default 1 | `page` | Refused in-process when `page × per_page > 10000`. |
| `cursor` | string, `^[1-9]\d*$`, optional | `id_below` | The `next_cursor` from a previous page — always a decimal observation id. A non-numeric value 500s upstream, so the schema enforces the pattern, the same way `place_id` enforces an integer. Mutually exclusive with `page`. |
| `per_page` | int 1–25, default 10 | `per_page` | Bounded by the response budget, not by upstream — see Response size budget. A full page of 25 measured 49,319 bytes; the default of 10 lands near 19,700. Upstream would serve 200 and clamps 999 to it silently; the schema refuses anything past 25. |
| `include` | enum array, optional | — | `photos` \| `annotations` \| `sounds`. |

**Output:** `total_results`, `observations[]` (the projected record), `next_cursor` (string, optional), `has_more` (boolean).

**format():** a header line carrying `total_results`, the number returned, `has_more`, and `next_cursor` when present. Then one `## ` heading per observation — `{taxon.common_name} ({taxon.name})`, or `Unidentified` when `taxon` is null — followed by `id`, `uuid`, and `url`; the date line from `observed_on` and `observed_at`; the locality line from `place_guess` and the coordinate (obscured-labelled per the contract above); a status line carrying `quality_grade`, `captive`, `geoprivacy`, `taxon_geoprivacy`, and the licence; the identification line from `identifications_count`, `agreements`, `disagreements`, and `community_taxon_id`; then the photo block with `photo_count` and `sound_count`. Included expansions render as `### Identifications` / `### Comments` / `### Photos` / `### Annotations` / `### Sounds` sub-blocks.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | An area was given partially, in two forms at once, with a radius of 0 or less, or with nelat south of swlat. | `Pass lat, lng and a radius above 0 together, or all four of nelat, nelng, swlat and swlng with nelat at or north of swlat, or a single place_id from inaturalist_find_places.` |
| `inverted_date_range` | `ValidationError` | `d1` is after `d2`. | `Pass d1 on or before d2 — both bounds are inclusive, so equal dates select a single day.` |
| `inverted_rank_range` | `ValidationError` | `hrank` is a finer rank than `lrank`. | `Set hrank to the coarser rank and lrank to the finer one, or pass the same rank to both for an exact-rank match; list the ranks with inaturalist_list_reference topic ranks.` |
| `result_window_exceeded` | `ValidationError` | `page × per_page` would exceed the upstream 10,000-result window. | `Continue past 10,000 results by passing cursor set to next_cursor from the previous page instead of raising page.` |
| `conflicting_pagination` | `ValidationError` | Both `page` and `cursor` were supplied. | `Pass page alone to walk the first 10,000 results, or cursor alone to continue past that window.` |
| `unpaired_annotation_value` | `ValidationError` | `term_value_id` without `term_id`. | `Pass term_id alongside term_value_id; list the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.` |
| `unknown_taxon_id` | `ValidationError` | Upstream answered 422 `Unknown taxon_id`. | `Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.` (`thrownBy: 'service'`) |
| `search_on_without_query` | `ValidationError` | `search_on` without `q`. | `Pass q alongside search_on, or drop search_on to search every observation property.` |

**Enrichment:** `applied_filters` (echo of the server-applied defaults — `quality_grade`, `captive`, and the forced ordering under a cursor), `notice`, and truncation disclosure (`truncated`, `shown`, `cap`) on every response. `total_results` is not duplicated into enrichment — it already rides `output`.

**Zero-hit notice fragments, composed by condition:**

| Condition | Fragment |
|:--|:--|
| Default `quality_grade` still in force | `Only research-grade records were searched. Add "needs_id" to quality_grade to include sightings whose identification is not yet community-confirmed.` |
| Default `captive: false` still in force | `Captive and cultivated records were excluded. Set captive to true to include zoo animals and garden plantings.` |
| A date range was given | `No sightings fall in {d1}…{d2}. Widen the range, or call inaturalist_get_histogram with the same filters to see which months have records.` |
| An annotation filter was given | `No sightings carry that annotation. Check the valid attribute and value pairs with inaturalist_list_reference topic controlled_terms.` With `taxon_id` set: `…Check which annotations exist for this taxon with inaturalist_list_reference topic controlled_terms and taxon_id.` |
| A radius was given | `No sightings within {radius} km of that point. Raise radius, or search a named area with a place_id from inaturalist_find_places.` |
| Nothing else applies | `No sightings matched. Relax one filter at a time.` With `taxon_id` set, it adds `Confirm taxon_id with inaturalist_resolve_name, or drop it.` |

No fragment names a filter the call did not supply.

**Truncation:** `truncated: false` with `shown` and `cap` on every other path; when the page fills `per_page`, `ctx.enrich.truncated({ shown, cap, guidance })` with the guidance naming `next_cursor`.

### `inaturalist_get_observation`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `observation_id` | int array, 1–10, required | path `id` | Comma-joined into one request. Verified: three ids, one bogus, returned `total_results: 2` with the bogus id omitted. |
| `include` | enum array, default `["identifications"]` | — | `identifications` \| `comments` \| `photos` \| `annotations` \| `sounds`. The two thread arms share the batch's 40-entry budget; the `.describe()` states the rule and names `identifications_total`. |

**Output:** `observations[]` — in the requested order, unresolved ids left out in place, a repeated id once — the projected record plus, per `include`, the expansions above (with `identifications_total`/`_shown` and `comments_total`/`_shown` beside the capped thread arrays — see Response size budget: the by-id array cap), plus `community_taxon` (`{ id, name, rank, common_name }` from the 1.2 KB embedded object), `identification_disagreements_count`, `description`, and `observation_fields` with `observation_fields_total`/`_shown`. `unresolved[]` — `{ observation_id }` for each requested id upstream did not return.

Upstream answers `/observations/{ids}` sorted by id as a string — requesting 5890862, 106687320, 322939816, … returned 101960556, 106687320, 116370592, … — so `getObservations()` puts the records back in the requested order before they leave the service.

| Detail field | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `description` | string \| null | `description` | The observer's own note — host plant, behaviour, habitat, count ("caterpillar on narrow-leaf milkweed along fisherman's access rd" on 402402822). Third-party free text. 23% of 272 sampled observations carry one. |
| `observation_fields` | `{ name: string \| null, value: string }[]` | `ofvs[].name`, `ofvs[].value` | Observation-field values filled in on the record, usually by a project. An entry whose `value` is blank or whitespace is dropped; every other value is relayed verbatim, the string `"null"` included. 10% of sampled observations carry any, and all values seen are strings. The tail is long — 5890862 carries 906 — so the list takes the same per-record share as the thread arrays, counted after blanks are dropped, with `observation_fields_total` / `observation_fields_shown` beside it. |

`non_owner_ids` (14,925 bytes on the probed record, a near-duplicate of `identifications`) is dropped. `searchObservations()` never sets the detail arm, so a search record carries neither `description` nor `observation_fields`.

**format():** the same per-observation block as `inaturalist_search_observations`, plus a `**Community consensus:**` line from `community_taxon` and `identification_disagreements_count`, the description as an `**Observer’s description:**` blockquote (the `place_guess` convention), `observation_fields` as a `### Observation fields` bullet list of `**{name}:** {value}` rendered inline (the `annotations` convention — values are short labels, not prose; a record with no filled fields renders no block, since the arm rides every by-id record and the common case should not grow a heading), and an `### Identification thread` list rendering each identification as `{by} → {taxon.common_name} ({taxon.name}) — {category}{, disagreement}{, from image classifier}` with the body as a blockquote beneath. Each capped block's heading carries its counts — `### Identification thread — 2 of 2 shown`, or `### Observation fields — first 40 of 906 shown, in upstream order` on a cut. `unresolved` renders as a closing `**Unresolved ids:**` list.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `not_found` | `NotFound` | None of the requested ids resolved to an observation. | `Check the observation ids, or find current ones for this area with inaturalist_search_observations.` |

Partial success is the norm: ids that resolve come back in `observations`, the rest in `unresolved`, and the call fails only when nothing resolved.

**Enrichment:** one `notice`, composed from up to two segments and written once, since the notice is last-wins. When `unresolved` is non-empty: `{n} of {total} ids returned no observation; they may have been deleted or never existed.` When an array was cut: `Arrays cut to the first {cap} entries each, in upstream order: observation {id} — identifications {shown} of {total}, comments {shown} of {total}, observation_fields {shown} of {total}. Open the record's url for the full record.` — on a batch, `…in upstream order, to share the response across {n} records: …` and the recovery `Re-request a single id for up to 40 entries per array, or open a record's url for the full record.` Only the cut arrays are named.

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
| `per_page` | int 1–50, default 25 | `per_page` | Bounded by the response budget, not by upstream — see Response size budget. A full page of 50 measured 42,780 bytes. Upstream caps at 500 (501 clamped silently) and 500 species measured 662 KB raw; the schema refuses anything past 50. |
| `page` | int ≥ 1, default 1 | `page` | |

**Output:** `total_results` (distinct species matching), `species[]` — `{ taxon_id, name, common_name, rank, iconic_taxon_name, observation_count, photo }`, from `results[].count` and `results[].taxon`.

**format():** `total_results` as a header line, then a numbered list ranked by `observation_count` — `{n}. **{common_name}** (*{name}*) — {observation_count} observations · {rank} · {iconic_taxon_name} · taxon_id {taxon_id}` — with the photo block indented under each entry.

**Errors:** `invalid_geography`, `inverted_date_range`, `unpaired_annotation_value`, `unknown_taxon_id` — same reasons, codes, and recovery strings as on `inaturalist_search_observations`.

**Enrichment:** `applied_filters`, `notice`, truncation disclosure (`truncated`, `shown`, `cap`) on every response, plus `truncationCeiling` when the page fills. `total_results` is not duplicated into enrichment — it already rides `output`.

**Zero-hit notice:** `No species recorded for those filters.`, followed by one remedy per narrowing filter the call actually supplied, in this order: `widen or drop d1/d2`, `widen the area`, `drop taxon_id or confirm it with inaturalist_resolve_name`, and `set quality_grade to include "needs_id"` unless it already does. With `place_id` and `taxon_id` under the default quality grade: `No species recorded for those filters. Widen the area, drop taxon_id or confirm it with inaturalist_resolve_name, or set quality_grade to include "needs_id".` `inaturalist_get_leaderboard` composes its notice the same way.

### `inaturalist_get_histogram`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `taxon_id` | int ≥ 1, optional | `taxon_id` | Omit for all taxa in the area. |
| area params | as above | same | |
| `interval` | enum, default `month_of_year` | `interval` | `year` \| `month` \| `week` \| `day` \| `hour` \| `month_of_year` \| `week_of_year`. The spec notes the absolute intervals set a default `d1`. `day` and `hour` over a wide range can generate thousands of buckets, so the `.describe()` names the 800-bucket cap. |
| `date_field` | enum, default `observed` | `date_field` | `observed` \| `created`. |
| `d1` / `d2` | `YYYY-MM-DD`, optional | same | `d1`'s `.describe()` also names the 800-bucket cap, since a wide range under `day`/`hour` is what triggers it. |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | |
| `captive` | boolean, default `false` | `captive` | |

**Output:** `interval`, `buckets[]` — `{ key, count }` in upstream key order, capped at 800 buckets (see below) — and `total` (the summed counts across *every* bucket upstream returned, including any past the cap). Upstream returns `results: { month_of_year: { "1": 0, …, "12": 2 } }` in 153 bytes; the array form keeps ordering explicit for a reading model.

**format():** a header line naming `interval` and `total`, then a two-column markdown table of `key` and `count` — small enough at every interval other than `day`/`hour` over a wide range (12 rows for `month_of_year`, 53 for `week_of_year`) to render whole.

**Errors:** `invalid_geography`, `inverted_date_range`, `unknown_taxon_id` — same strings.

**Enrichment:** `applied_filters`, `truncated`/`shown`/`cap` (required, written on every path — the same unconditional-disclosure pattern as the other list tools), `notice`.

**Bucket cap:** `interval=day&d1=1900-01-01&taxon_id=48662` measured 25,531 buckets / 388,530 bytes against the design's 50,000-byte advertised maximum for a list tool. Capped at 800 buckets, the first in upstream key order — a bucket costs at most ~58 bytes combined across `structuredContent` and its rendered markdown row (a 10-char day key, a JSON entry, and a `| key | count |` row up to a 5-digit count), so a full 800-bucket response lands near 46,800 bytes worst case. `ctx.enrich.truncated()` fires when upstream returned more than 800, with guidance to narrow `d1`/`d2` or choose a coarser interval; `total` still sums every bucket upstream returned, not just the shown 800, so the figure stays accurate even when the array is cut.

**Zero-hit notice** (every bucket zero, computed over the full unclipped set), composed from the call rather than fixed: with `taxon_id` set and no date range it reads `Every bucket is zero — this taxon has no records in that area. Confirm the taxon with inaturalist_resolve_name, or widen the area.` The taxon wording is dropped when `taxon_id` was omitted (`nothing is recorded in that area. Widen the area, or relax quality_grade or captive.`); when `d1` or `d2` was set, the range is named as the likeliest cause (`no records of this taxon in that area fall in {d1}…{d2}. Widen or drop d1/d2.`, with `any start`/`any end` for an open bound); and the area clauses drop when no area was given. It replaces the truncation guidance when the answer is genuinely zero everywhere, since narrowing the range would not help — the notice is written once, as the truncation guidance itself on a capped response.

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

**format():** the two arms render on field presence, independently — never by branching on `kind`, which would fail parity against the linter's all-fields sample. The full arm renders `## {common_name} ({name})` then the scalars as a pipe-separated line — each heading value and scalar only when the response carries its key, so a selection without `summary` (`sections: ["children"]`) reads `## Plantae` over `id 47126 · name Plantae · rank kingdom`, never `## no common name (Plantae)` over a row of `not published` — then a `### ` block per section: taxonomy as a `Kingdom › Phylum › … › Species` rank path, children as a list, conservation as a table of `status`, `authority`, `iucn`, `place`, and `url`, photos as the standard photo block, and `encyclopedia` as a blockquote followed by `wikipedia_url`. The outline arm renders through `formatOutline()` from `@cyanheads/mcp-ts-core/utils`.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `not_found` | `NotFound` | Upstream answered 200 with an empty `results` array. | `Resolve the organism name with inaturalist_resolve_name and retry with the taxon id it returns.` |
| `unknown_section` | `ValidationError` | `sections` named a key the projected document does not carry. | `Call inaturalist_get_taxon without sections to see the section outline, then name sections from that list.` |

**Enrichment:** `sections_applied` — the sections this response carries, empty when the whole profile came back rather than a named slice. The `notice` that appears on the outline arm is a plain output field from `outlineOnOverflow()`, not routed through enrichment.

### `inaturalist_get_similar_species`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `taxon_id` | int ≥ 1, required | `taxon_id` | Genus or finer. Verified 2026-09-23 across the full lineage kingdom → subtribe (`rank_level` 70 down to 24): every rank coarser than genus answers HTTP 422 `{"error":"Taxon 3 is not genus or finer","status":422}`; genus (20) and species (10) succeed. The tool description and the `.describe()` state the floor. |
| area params | as above | same | Verified to work: unscoped returned 24 look-alikes in 228,989 bytes; `place_id=46` returned 3 in 24,642 bytes. |
| `d1` / `d2`, `quality_grade`, `captive` | as above | same | The endpoint accepts the full observation filter set. |
| `limit` | int 1–50, default 20 | — | Applied in-process — the endpoint publishes no `page` or `per_page` parameter. |

**Output:** `taxon_id`, `similar_species[]` — `{ taxon_id, name, common_name, rank, observations_count, misidentification_count, photo }` from `results[].taxon` and `results[].count`. Each upstream result is a full 5.7–11.7 KB taxon record and is projected to roughly 250 bytes.

`misidentification_count` is named for what it counts — how many times identifiers corrected this taxon to the queried one — rather than the upstream key `count`.

**format():** a header line naming the queried `taxon_id` and how many look-alikes were found, then a numbered list ranked by `misidentification_count` — `{n}. **{common_name}** (*{name}*) — corrected {misidentification_count} times · {rank} · {observations_count} observations · taxon_id {taxon_id}` — with the photo block under each entry, since a look-alike without a picture is not much use in the field.

**Errors:** `unknown_taxon_id`, `invalid_geography`, `inverted_date_range` — same strings — plus:

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `taxon_rank_too_coarse` | `ValidationError` | iNaturalist answered 422 because the taxon is coarser than genus, such as a family, order, or class. | `Pass a genus or species id: resolve a specific organism by name with inaturalist_resolve_name, or walk children with inaturalist_get_taxon down to a genus, which takes several calls from a class (order, family, subfamily, tribe, subtribe, genus).` (`thrownBy: 'service'`, not retryable) |

**Enrichment:** `totalCount`, `notice`, truncation disclosure (`truncated`, `shown`, `cap`) on every response, plus `truncationCeiling` when `limit` cut the list.

**Zero-hit notice:** with an area given, `No look-alikes are recorded for this taxon — either it is rarely misidentified, or the area filter is too narrow. Re-run without the area filter to see the global confusion set.` A `d1`/`d2` range is named the same way (`the d1/d2 range`, or both as `the area filter and the d1/d2 range are too narrow. Re-run without them…`); with neither, the notice is `No look-alikes are recorded for this taxon — it is rarely misidentified.`

### `inaturalist_find_places`

Two arms, one of which must be supplied.

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `q` | string 1–100, optional | `q` | Routes to `/places/autocomplete`. Name-prefix match. A blank string reads as unset, so a form client submitting an untouched `q` alongside a box reaches the nearby arm. |
| `nelat` / `nelng` / `swlat` / `swlng` | number, optional | same | All four together. Routes to `/places/nearby`, where the spec marks all four required. `nelat` south of `swlat` answers HTTP 500 there, so it fails as `invalid_geography` first; `nelng` west of `swlng` (antimeridian) is accepted. |
| `per_page` | int 1–30, default 10 | `per_page` | Honoured on the nearby arm only, where it bounds `standard` and `community` independently — verified 2026-09-22, `per_page=5` over central Seattle returned 4 + 5, `per_page=3` 3 + 3. `/places/autocomplete` publishes no `per_page` and returned a fixed page of 10 out of 45 matches. |

**Output:** `places[]` for the autocomplete arm; `standard[]` and `community[]` for the nearby arm, which returns `results` as an object with those two keys. Each place: `id`, `name`, `display_name`, `place_type` (int \| null), `admin_level` (int \| null), `bbox` (`{ swlat, swlng, nelat, nelng }`), `ancestor_place_ids`, `location` (`{ lat, lng }`), `slug`. No `url` — the place record carries a `slug` but no URL of its own, and none is constructed.

`place_type` and `admin_level` are relayed as the raw integers upstream returns (100, 16, 29, and null all observed). The spec publishes no code table for either, so no label is invented; `display_name` carries the human-readable context.

**format():** one `## {display_name}` heading per place, then `name`, `id`, `slug`, `place_type`, and `admin_level` on a pipe-separated line, the `bbox` as `SW {swlat}, {swlng} → NE {nelat}, {nelng}`, the centre from `location`, and `ancestor_place_ids` as a trailing containment chain. The nearby arm renders `### Standard places` and `### Community places` as separate blocks so the two lists never merge.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | Neither `q` nor a complete bbox was given, both were, or the box has `nelat` south of `swlat`. | `Pass q to search place names, or all four of nelat, nelng, swlat and swlng, with nelat at or north of swlat, to list the places covering a map area.` |

**Enrichment:** `totalCount`, `notice`, truncation disclosure (`truncated`, `shown`, `cap`) on every response — the autocomplete arm's fixed page of 10 against 45 matches is disclosed every time it caps. `cap` means different things per arm: `per_page × 2` on the nearby arm, since `per_page` bounds each list separately, and the fixed page upstream served on the autocomplete arm, which publishes no page size to report. On the nearby arm `truncated` fires only when the standard or community list reached `per_page` — the list that may have been cut — and the guidance names which; at `per_page` 30 it points at shrinking the box instead. `totalCount` there is upstream's `total_results`, which always equals the places returned, so it is bounded by the page size rather than a full count; on the autocomplete arm it is the full match count.

**Zero-hit notice:** `No place name starts with that text — place search matches a name prefix. Try a shorter prefix or the official name, or pass a bounding box to list the places covering a map area.`

### `inaturalist_get_leaderboard`

| Param | Type | Maps to | Notes |
|:--|:--|:--|:--|
| `kind` | enum, required | — | `observers` → `/observations/observers`; `identifiers` → `/observations/identifiers`. |
| area params | as above | same | |
| `taxon_id` | int ≥ 1, optional | `taxon_id` | |
| `d1` / `d2` | `YYYY-MM-DD`, optional | same | |
| `quality_grade` | enum array, default `["research"]` | `quality_grade` | |
| `per_page` | int 1–250, default 25 | `per_page` | Bounded by the response budget, not by upstream — see Response size budget. A full page of 250 measured 34,182 bytes, and two such pages cover the whole 500-entry window. Verified live: `per_page=999` clamps to 500 on both `/observations/observers` and `/observations/identifiers`; the schema refuses anything past 250. |
| `page` | int ≥ 1, default 1 | `page` | Refused in-process when `page × per_page > 500` — see below. |

The two endpoints return different shapes and are normalised: `observers` gives `{ user_id, observation_count, species_count, user }`, `identifiers` gives `{ user_id, count, user }`.

**Both endpoints cap the addressable window at 500 total results — far tighter than the 10,000-result window on `/observations`.** Verified live on `place_id=1`: `page=5&per_page=100` (offset 400–500) returns 100 rows; `page=6&per_page=100` (offset 500–600) returns zero, on both `/observations/observers` and `/observations/identifiers`, despite `total_results` reporting millions of candidates. There is no error signal — it is the same silent-empty failure mode the rest of this surface rejects in-process, so `page × per_page > 500` is rejected the same way rather than read as a genuine zero-hit.

**Output:** `kind`, `count_metric` (`"observations"` or `"identifications"` — names what `count` measures), `total_results`, `entries[]` — `{ rank, login, count, species_count? }`, where `species_count` is present on the observers arm only.

Top species for an area is not a `kind` here; `inaturalist_get_species_counts` already answers it and the tool description says so.

**format():** a header line naming `kind`, `count_metric`, and `total_results`, then a numbered list — `{rank}. **{login}** — {count} {count_metric}{ · {species_count} species}` — where the species clause renders only on the observers arm.

**Errors:**

| reason | code | when | recovery |
|:--|:--|:--|:--|
| `invalid_geography` | `ValidationError` | An area was given partially, in two forms at once, with a radius of 0 or less, or with nelat south of swlat. | Same string as `inaturalist_search_observations`. |
| `inverted_date_range` | `ValidationError` | `d1` is after `d2`. | Same string as `inaturalist_search_observations`. |
| `unknown_taxon_id` | `ValidationError` | Upstream answered 422 `Unknown taxon_id`. | Same string as `inaturalist_search_observations`. (`thrownBy: 'service'`) |
| `leaderboard_window_exceeded` | `ValidationError` | `page × per_page` would exceed 500. | `This leaderboard only ranks the top 500 entries; page and per_page must multiply to 500 or less. Narrow the area, date range, or taxon_id to bring a specific user's rank into the top 500 instead.` |

**Enrichment:** `applied_filters`, `notice`, truncation disclosure (`truncated`, `shown`, `cap`) on every response. `total_results` is not duplicated into enrichment — it already rides `output`.

**Zero-hit notice:** `Nobody has recorded observations matching those filters.` (`Nobody has made identifications…` for `kind: "identifiers"`), followed by the remedies for the filters the call supplied, composed as on `inaturalist_get_species_counts` — `taxon_id`, the date range, and the area are named only when given.

---

## Resources — detail

| Aspect | `inaturalist://taxa/{taxon_id}` | `inaturalist://observations/{observation_id}` |
|:--|:--|:--|
| `name` | `inaturalist-taxon` | `inaturalist-observation` |
| Params | `taxon_id` (positive integer) | `observation_id` (positive integer) |
| Output | The projected taxon document, always the full arm — a resource read has no way to ask for sections, so the handler returns the projected document whatever its size. | The projected observation with `identifications` expanded — its first 40 in upstream order, with `identifications_total` and `identifications_shown` as the cut's only disclosure, since a resource has no enrichment trailer — plus `description` and `observation_fields`, likewise its first 40 with `observation_fields_total` and `observation_fields_shown`. |
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
| **422 mapping** | `mapUpstreamError()` matches the body. `{"error":"Unknown taxon_id N","status":422}` is mapped to `data: { reason: 'unknown_taxon_id' }`, and `{"error":"Taxon N is not genus or finer","status":422}` from `/identifications/similar_species` to `data: { reason: 'taxon_rank_too_coarse' }`, both `ValidationError`, not retryable, with the recovery from the calling tool's contract and no upstream path in `data` — so the tool contract's reason reaches the wire. `/taxa/abc`'s bare `{"error":"Error","status":422}` never occurs, because the schema rejects the non-integer first. |
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

No API key. `server.json` (`environmentVariables[]`) declares all four on both packages. `manifest.json` `user_config` stays empty: `lint:packaging` requires an entry there only for a variable that is required with no default, and all four are optional.

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
- **A ten-id by-id batch can exceed the list budget.** The by-id array cap bounds the thread and observation-field arrays, not the records around them: the ten records' own fields add roughly 27 KB, so the heavy ten-id batch measured 53,155 bytes with the default `include` and 66,853 with comments, past the 50,000-byte advertised maximum. A single id stays under it. See Response size budget: the by-id array cap.
- **Leaderboard endpoints cap at 500 total results, not the 10,000 window of `/observations`.** `/observations/observers` and `/observations/identifiers` return an empty result set once `page × per_page` exceeds 500, verified live, despite `total_results` reporting millions of candidates. `inaturalist_get_leaderboard` rejects the combination in-process rather than surfacing a false zero-hit.

---

## Out of Scope

- **Computer vision.** The v1 spec publishes 86 paths and none of them is a `/computervision/*` endpoint; image scoring is not part of this API surface. The keyless proxy for classifier coverage is the taxon record's `vision` boolean, which `inaturalist_get_taxon` surfaces.
- **Observation fields.** There is no `/observation_fields` path in v1. `/observation_field_values` exists but publishes only POST, PUT, and DELETE — writes. This covers the write path only: the filled values already embedded in a record (`ofvs[]`) are relayed on the by-id surfaces as `observation_fields`.
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
| **A calendar-invalid date is rejected at the schema, beside the pattern.** | `2026-02-30` drops the bound upstream exactly as `notadate` does, so it fails at the same layer with the same `invalid_arguments` envelope. A refinement rather than `z.iso.date()` keeps the advertised JSON Schema pattern unchanged. |
| **Inverted ordered pairs and 500-answering areas are rejected in the handler, with typed reasons.** | `d1` after `d2` and an inverted `hrank`/`lrank` answer 200 with zero results; `radius=0` and `nelat` south of `swlat` answer 500 and burn four retries. Cross-field or recoverable, they fail as `inverted_date_range`, `inverted_rank_range`, and `invalid_geography` so the caller gets a recovery hint a schema rejection cannot carry. |
| **`hrank`/`lrank` compare rank levels, not enum position.** | Upstream serves `hrank=hybrid&lrank=species` and `hrank=variety&lrank=subspecies` in full, because those ranks share a level; an index comparison would reject valid bands. |
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
| **Truncation disclosure is required enrichment and is written on every path, not only where the cap bit.** | The framework validates merged enrichment against `output.extend(enrichment)`, so a required field written on one branch only does not degrade to a missing field on the others — every other path fails the call outright, and a zero-hit page returns a validation error in place of its own zero-hit notice. Writing `truncated: false` with `shown` and `cap` unconditionally also earns its keep on its own terms: a page states what it returned against what was asked for whether or not anything was cut. |
| **List caps are sized by response bytes, not by what upstream will serve.** | Upstream's own limits (200 observations, 500 species, 500 leaderboard entries) are limits on upstream, and a full page at them measured 388 KB, 419 KB, and 68 KB — an agent spending a call at the advertised maximum had no way to know that before it arrived. Caps now come from the measured per-record cost across `structuredContent` and the rendered text together: the default page fits the 24,000-byte budget `outlineOnOverflow` gives one document, the advertised maximum fits 50,000. Bounding beats disclosing here because paging already reaches every record an uncapped page would have carried, so the smaller page costs nothing but a second call. |
| **A caller-facing error carries no upstream path.** | `unknown_taxon_id` reaches the agent on `structuredContent.error.data`, and the REST path it came from names nothing the caller can act on that the declared recovery does not already say. The endpoint stays on the request's own log line, which is where triage wants it. The server- and upstream-fault errors keep theirs — an allowlist violation, an HTML error page, an unparseable body — because there the path *is* the diagnostic and the caller is not its audience. |
| **Upstream text rendered inline is flattened to a single line; only quoted text keeps its own line structure.** | The blockquote rule covers the free-text fields, but names, logins, media URLs, and authority status text are interpolated into a rendered line rather than quoted — and member-created place and project names, community-editable common names, and `matched_term` are all third-party strings. A line break inside one ends its line and lets the remainder read as a heading or list item this server never emitted. `inlineText()` collapses CR, LF, and CRLF at every inline slot, and `blockquote()` splits on the same set so a bare CR cannot leave a tail outside the quote. `structuredContent` keeps every value verbatim — the flattening is render-only, so the licensing rule that attribution is never reformatted still holds on the surface that carries it. |
| **The unknown-section rejection names a bounded sample of what it rejected.** | `sections` is an unbounded array of unbounded strings, and naming every unknown entry let one call inflate its own failure message to 106 KB — mirrored into `content[]` and `structuredContent.error` alike, straight into the agent's context. Three names, 40 characters each, plus a count of the rest is all a caller needs to find the typo, and the valid section list follows it regardless. The bound sits in the handler rather than on the schema so the typed `unknown_section` contract and its recovery hint still fire; a `maxItems` on the input would pre-empt them with a framework `invalid_arguments` rejection instead. |
| **`inaturalist_get_histogram` caps `buckets[]` at 800, kept from the start of upstream key order.** | `interval=day&d1=1900-01-01&taxon_id=48662` measured 25,531 buckets / 388,530 bytes, past the design's 50,000-byte advertised maximum for a list tool. A bucket costs at most ~58 bytes combined across `structuredContent` and its rendered markdown row, so 800 lands near 46,800 bytes worst case — under budget with headroom. `total` still sums every bucket upstream returned, including any past the cap, so the one number that costs nothing to keep accurate stays accurate; only the array is cut, disclosed through the same `truncated`/`shown`/`cap` enrichment every other list tool declares. |
| **`cursor` on `inaturalist_search_observations` is validated against `^[1-9]\d*$`, the same way `place_id` enforces an integer.** | `cursor` is forwarded verbatim as upstream `id_below`, and the server's own `next_cursor` is always a decimal observation id — a caller-supplied non-numeric value 500s upstream, which the service maps to an upstream-unavailable error and retries against a fault that a schema rejection would have caught for free. `blankAsUnset` still runs first, so a form client's blank cursor is unset rather than rejected. |
| **The by-id arrays — identifications, comments, and filled observation fields — share one 40-entry budget across the batch: `max(4, floor(40 / records returned))` per array per record, first entries in upstream order.** | One heavily discussed id measured 624,791 bytes uncapped, and a per-record cap alone would let ten such records multiply it. Sharing the budget brings 5890862 alone to 28,050 B with the default `include` and 40,102 B with comments; ten ids measured 53,155 and 66,853 B, the extra being the ten records' own fields. Totals and shown counts ride every record, so an under-cap array reads as whole rather than as unknown, and one composed notice names each cut id and array with the two recoveries — a single-id re-call or the record's `url` — since no tool pages them. Upstream order is kept rather than re-sorted; it is stable but not chronological, and the surfaces say "in upstream order", never "earliest". |
| **`identifications_count` is described as upstream's agree-plus-disagree tally, and no thread-size field was added beside it.** | It equalled `agreements + disagreements` on all 270 sampled records and leaves out the observer's own and any non-committal identification, so describing it as the thread size misled by up to 8 of 14 entries. The thread size already rides `identifications_total` wherever the thread is included. |
| **The observer's `description` and non-blank `observation_fields` are relayed on the by-id detail arm only.** | The description is often the most useful field on a sighting (host plant, behaviour, habitat) and was being dropped. Search never carries them: a 25-record page would pay for 25 notes nobody asked for. Blank values are dropped because an empty project field tells a reader nothing; every other value is relayed verbatim, the string `"null"` included. The fields take the thread arrays' per-record share, counted after blanks are dropped, because the tail is long: 5890862 carries 906, which relayed whole added 86–94 KB to every reply that included it. `description` is one string and stays whole. |
| **A batch comes back in the requested order.** | Upstream answers `/observations/{ids}` sorted by id as a string, so a caller pairing the reply with its own `observation_id` array matched the wrong records. The service reorders to the requested ids, leaving unresolved ids out in place and a repeated id once; the order is stated on `observations`. |
| **A rank coarser than genus fails as a typed `taxon_rank_too_coarse`, matched on the 422 body like `unknown_taxon_id`.** | Upstream refuses every rank above genus with the same 422, and surfaced untyped it read as a generic upstream fault with no recovery. The recovery names both routes to a genus — resolving a specific organism by name, or walking `children` down from the coarse taxon — and says the walk takes several calls, so the caller can pick the cheaper one. |
| **`inaturalist_get_taxon` renders a heading value or scalar only when the response carries its key.** | A `sections` selection without `summary` omits those keys from `structuredContent`, and rendering them with null-case text told a `content[]` reader that Plantae has no common name, no observations, and no vision coverage — all false. Null-case text stays for a value upstream genuinely left null. |
