---
name: inaturalist-guide
description: Use inaturalist_* tools to compare local wildlife records, chart annotated life stages, or assess community identification evidence. Resolve identifiers across calls and check cohort, annotation, and coverage gates before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use public iNaturalist sightings and community identifications for local species discovery, recorded seasonality, and identification research. Access is keyless and read-only. The server does not classify an uploaded image, recover hidden coordinates, or access authenticated records.

## Identifiers

- `inaturalist_resolve_name` returns typed candidates: taxon IDs, observer user IDs and logins, and project IDs. Check the candidate's kind, scientific name, and rank before using its ID; a common-name match alone may not identify the organism intended.
- `inaturalist_find_places` returns place IDs with administrative context and containment information. Select the intended place before using it in another tool; similarly named places need not cover the same area.
- `inaturalist_search_observations` returns observation IDs for `inaturalist_get_observation` and the observation resource. Species-count and similar-species results return taxon IDs for `inaturalist_get_taxon`.
- `inaturalist_get_leaderboard` entries and observation records carry observer logins. Use a login directly for observer filtering, or resolve that user when a numeric ID is needed. An identifier's login names the contributor, not the observer of every record they identified.
- `inaturalist_list_reference` supplies annotation attribute IDs and each attribute's value IDs. Its taxon-scoped observed usage also carries those pairs; retain both IDs together.

## Gates

1. Before comparing counts, curves, and individual sightings, keep the area, date range, taxon, and quality selection consistent across tools that support them. Read the applied defaults. Tools have different filter surfaces; do not describe unmatched cohorts as the same population.
2. Treat species rankings and histograms as records of sightings, not an exhaustive inventory or a measurement of organism abundance. A zero result establishes no matching records under the chosen filters, not biological absence. Check the selected place and taxon, defaults, and pagination notice before widening the search.
3. Choose an annotation value from its returned parent attribute. Labels can repeat across attributes: an Egg value under Life Stage is distinct from an Egg value under Evidence of Presence. Empty taxon-scoped usage does not make the full controlled vocabulary invalid.
4. Distinguish wild and captive cohorts. Where the tool accepts `captive`, false selects wild records and true selects captive or cultivated records only; true does not combine both groups.
5. Before describing identification agreement, inspect the community taxon, disagreement fields, and identification thread together. Compare total and shown counts before making claims about the whole thread; use the observation's source URL when the returned thread is incomplete.
6. Read truncation and continuation guidance before claiming a list is complete. Retrieve search's ordered `deferred` IDs with `inaturalist_get_observation` and the same `include` before following its upstream-page continuation, even when `has_more` is false. By-id calls may also defer IDs beyond the first ten distinct attempts; re-call with that tail and the same `include`. A contributor missing from the top-500 leaderboard may still have contributions. Counts come from a live index and can change between calls.

## Core chain

Resolve the organism and location, choose aggregate or individual evidence for the question, then retrieve the specific records needed to substantiate the answer. Carry the selected identifiers forward; do not substitute names or unrelated candidate IDs between calls.

## Workflows

### Local wildlife and seasonality

For what has been recorded in an area, start with `inaturalist_get_species_counts` rather than enumerating sightings. Use its taxon IDs with `inaturalist_get_histogram` for recorded seasonality and `inaturalist_search_observations` for examples from the same cohort. A monthly curve describes when observations were recorded; it does not establish that an organism cannot occur in another month.

For a particular life stage or reproductive state, resolve the organism, inspect `inaturalist_list_reference` controlled terms with taxon-scoped usage, and select the matching attribute/value pair before requesting the histogram or sightings. Use observation-date bucketing for phenology; upload-date bucketing answers a different question.

On histograms, `d1`/`d2` filter observation dates and `created_d1`/`created_d2` independently filter upload dates. `date_field` chooses the bucket date without changing either filter family; retain both families when comparing cohorts.

### Identification evidence

Find candidate sightings with `inaturalist_search_observations`, then inspect selected records with `inaturalist_get_observation`. Use `inaturalist_get_similar_species` for the resolved genus or finer taxon and follow returned taxon IDs into `inaturalist_get_taxon` profiles. The confusion ranking reflects identification corrections; it is not an image classifier or an exhaustive list of visually similar organisms. If the local confusion set is empty, compare the global set before concluding there are no recorded alternatives.

### Local contributors and source context

Use `inaturalist_get_leaderboard` to distinguish observation activity from identification activity. Follow a returned login into observer-filtered searches or species counts when the question concerns that person's sightings; identifier activity does not mean that person observed the records.

For injectable source context, read `inaturalist://observations/{observation_id}` for a record with its identification thread, or `inaturalist://taxa/{taxon_id}` for a whole projected taxon profile. Use `inaturalist_get_taxon` instead when an outline or selected sections are needed. Preserve each record's licensing, attribution, and coordinate uncertainty when presenting evidence.
