---
name: inaturalist-guide
description: Use inaturalist_* tools to compare local wildlife records, chart annotated life stages, or assess community identification evidence. Resolve identifiers across calls and check cohort, annotation, and coverage gates before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.3"
---

## Scope

Use public iNaturalist sightings and community identifications for local species discovery, recorded seasonality, and identification research. Access is keyless and read-only. The server does not classify an uploaded image, recover hidden coordinates, or access authenticated records.

## Identifiers

- `inaturalist_resolve_name` returns typed candidates: taxon IDs, observer user IDs and logins, and project IDs. Check the candidate's kind, scientific name, and rank before using its ID; a common-name match alone may not identify the organism intended. A taxon candidate with `is_active: false` was retired by a taxonomic change and carries `current_synonymous_taxon_ids`; pass one of those as `taxon_id` for the current taxon, choosing among several after a split, and treat an empty list as no recorded successor.
- `inaturalist_find_places` returns place IDs with administrative context and containment information. Select the intended place before using it in another tool; similarly named places need not cover the same area.
- `inaturalist_search_observations` returns observation IDs for `inaturalist_get_observation` and the observation resource. Species-count and similar-species results return taxon IDs for `inaturalist_get_taxon`.
- `inaturalist_get_leaderboard` entries and observation records carry observer logins. Use a login directly for observer filtering, or resolve that user when a numeric ID is needed. An identifier's login names the contributor, not the observer of every record they identified.
- `inaturalist_list_reference` supplies annotation attribute IDs and each attribute's value IDs. Its taxon-scoped observed usage also carries those pairs; retain both IDs together.

## Gates

1. Before comparing counts, curves, and individual sightings, keep the area, date range, taxon, and quality selection consistent across tools that support them. Read the applied defaults. Tools have different filter surfaces; do not describe unmatched cohorts as the same population.
2. Treat taxon rankings and histograms as records of sightings, not an exhaustive inventory or a measurement of organism abundance. A zero result establishes no matching records under the chosen filters, not biological absence. Check the selected place and taxon, defaults, and pagination notice before widening the search.
3. Choose an annotation value from its returned parent attribute. Labels can repeat across attributes: an Egg value under Life Stage is distinct from an Egg value under Evidence of Presence. Empty taxon-scoped usage does not make the full controlled vocabulary invalid.
4. Distinguish wild and captive cohorts. Where the tool accepts `captive`, false selects wild records and true selects captive or cultivated records only; true does not combine both groups. iNaturalist grades captive records casual, so pair `captive: true` with `"casual"` in `quality_grade`; without it the call returns only records whose grade disagrees with their captive flag, and a notice says so.
5. Before describing identification agreement, inspect the community taxon, disagreement fields, and identification thread together. Compare total and shown counts before making claims about the whole thread; hidden identifications (`hidden: true`) stay in the thread and in `identifications_total`, so read `identifications_hidden` and say so when citing a hidden entry; when the returned thread is incomplete, follow `next_array_offset` as `array_offset` with the same ids and `include`, or raise `array_limit`. By-id identifications, comments, and observation fields are sorted by ascending `id`, which is creation order, so the newest entries sit at the end.
6. Read truncation and continuation guidance before claiming a list is complete. Retrieve search's ordered `deferred` IDs with `inaturalist_get_observation` and the same `include` before following its upstream-page continuation, even when `has_more` is false. By-id calls may also defer IDs beyond the first ten distinct attempts; re-call with that tail and the same `include`. A contributor missing from the top-500 leaderboard may still have contributions. Counts come from a live index and can change between calls.

## Core chain

Resolve the organism and location, choose aggregate or individual evidence for the question, then retrieve the specific records needed to substantiate the answer. Carry the selected identifiers forward; do not substitute names or unrelated candidate IDs between calls.

For more name candidates, start explicit browsing at page 1 with a fixed limit. Taxon name browsing uses ascending ID order and can match a different multilingual population from relevance autocomplete; do not append browse pages to an autocomplete list as if they continued it. Numeric taxon IDs are singleton lookups. Place autocomplete has no offsets: narrow the name or explore a smaller area rather than claiming exhaustive recovery.

## Workflows

### Local wildlife and seasonality

For what has been recorded in an area, start with `inaturalist_get_species_counts` rather than enumerating sightings. Use its taxon IDs with `inaturalist_get_histogram` for recorded seasonality and `inaturalist_search_observations` for examples from the same cohort. A monthly curve describes when observations were recorded; it does not establish that an organism cannot occur in another month.

Species counts rank leaf taxa, including hybrids and coarser identifications; subspecies roll up to their species. Read `total_results` as a taxon count, not species richness; the returned array is still named `species`.

For a particular life stage or reproductive state, resolve the organism, inspect `inaturalist_list_reference` controlled terms with taxon-scoped usage, and select the matching attribute/value pair before requesting the histogram or sightings. Use observation-date bucketing for phenology; upload-date bucketing answers a different question.

Annotation arrays are membership sets, not positional pairs: multiple attributes or values match any one annotation, rather than requiring both annotations. For adult males, filter on the rarer annotation and request `include: ["annotations"]`, then retain records carrying the other annotation too. To estimate an intersection count, query A, B, and their union with otherwise identical filters, then calculate A + B minus the union. Counts come from a live index and may drift between calls; this is an estimate, not a stable census.

On histograms, `d1`/`d2` filter observation dates and `created_d1`/`created_d2` independently filter upload dates. `date_field` chooses the bucket date without changing either filter family; retain both families when comparing cohorts.

For absolute curves, compare the disclosed effective window starts before comparing totals; a generated start can differ from the intended historical cohort. When continuing a truncated curve, retain other filters and upper bounds, deduplicate bucket keys, and preserve counts from earlier responses. Date-only continuation can produce partial boundary buckets and cannot reconstruct complete bucket totals; never sum overlapping replies' totals.

### Identification evidence

Find candidate sightings with `inaturalist_search_observations`, then inspect selected records with `inaturalist_get_observation`. Use `inaturalist_get_similar_species` for the resolved genus or finer taxon and follow returned taxon IDs into `inaturalist_get_taxon` profiles. Its ranking counts observations carrying current, non-hidden identifications of both taxa, including ancestor taxa. Treat this symmetric evidence as a lead to inspect in identification threads, never as correction direction, an image classification, or an exhaustive neighbor list. If the local set is empty, compare the global evidence before concluding there are no recorded alternatives; an empty set does not establish rarity of misidentification.

### Local contributors and source context

Use `inaturalist_get_leaderboard` to distinguish observation activity from identification activity. Follow a returned login into observer-filtered searches or species counts when the question concerns that person's sightings; identifier activity does not mean that person observed the records.

Histogram and both leaderboard kinds accept an observer (`user_id` or `user_login`) and `project_id`. Carry those selectors into supported tools when comparing cohorts. On observers, the observer selector returns that person's own row; on identifiers it ranks people who identified that observer's sightings, rather than identifications authored by that observer.

For injectable source context, read `inaturalist://observations/{observation_id}` for a record with its first 40 identifications (use `inaturalist_get_observation` with `array_offset` for the rest), or `inaturalist://taxa/{taxon_id}` for a whole projected taxon profile. Use `inaturalist_get_taxon` instead when an outline or selected sections are needed. Preserve each record's licensing, attribution, and coordinate uncertainty when presenting evidence.
