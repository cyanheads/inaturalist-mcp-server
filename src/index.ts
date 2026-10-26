#!/usr/bin/env node
/**
 * @fileoverview inaturalist-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { inaturalistObservationResource } from './mcp-server/resources/definitions/inaturalist-observation.resource.js';
import { inaturalistTaxonResource } from './mcp-server/resources/definitions/inaturalist-taxon.resource.js';
import { inaturalistFindPlaces } from './mcp-server/tools/definitions/inaturalist-find-places.tool.js';
import { inaturalistGetHistogram } from './mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import { inaturalistGetLeaderboard } from './mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { inaturalistGetObservation } from './mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { inaturalistGetSimilarSpecies } from './mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { inaturalistGetSpeciesCounts } from './mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
import { inaturalistGetTaxon } from './mcp-server/tools/definitions/inaturalist-get-taxon.tool.js';
import { inaturalistListReference } from './mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import { inaturalistResolveName } from './mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';
import { inaturalistSearchObservations } from './mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import { initINaturalistService } from './services/inaturalist/inaturalist-service.js';

await createApp({
  name: 'inaturalist-mcp-server',
  title: 'inaturalist-mcp-server',
  instructions:
    "Citizen-science wildlife observations from iNaturalist — sightings with photos, community identification threads, phenology, look-alike species, places, and annotations. Keyless and read-only. Identifiers are integers and are not names: resolve an organism name to a taxon id, and an observer or project name to its id, with inaturalist_resolve_name, and a place name or map area to a place id with inaturalist_find_places before searching, since an unrecognised filter value silently returns either the whole global index or nothing at all. Every area filter takes exactly one form — a place_id, a lat/lng/radius triple in kilometres, or a four-corner bounding box. inaturalist_search_observations defaults to research-grade, wild-only records and echoes those defaults in every response. captive false selects wild records only and true selects captive or cultivated records only. Its page parameter walks the first 10,000 results under any ordering; past 10,000, order by id descending and pass each page's next_cursor as cursor — the only ordering a cursor continues. Search returns whole records within its 50,000-byte serialized reply budget; retrieve its ordered deferred IDs through inaturalist_get_observation using the same include before following the full upstream page's continuation. By-id lookup accepts up to 100 submitted IDs by default, attempts the first ten distinct IDs, and returns the remainder as deferred; re-call with those IDs and the same include. Detail strings remain complete without a universal byte ceiling. inaturalist_list_reference decodes every controlled vocabulary the other tools accept. Records carry their own licence: a null license_code means all rights reserved, photo attribution strings are relayed verbatim and must be reproduced with any image, photos are linked rather than proxied, and an obscured coordinate is a locality, not a sighting position. The upstream asks clients to stay under 60 requests a minute, so this server paces its own traffic and may queue a burst.",
  // No handler asks the caller for input mid-request, so nothing needs a live
  // session. Declared in source rather than left to MCP_SESSION_MODE's `auto`
  // default, which resolves to stateful.
  sessionMode: 'stateless',
  skills: 'skills',
  tools: [
    inaturalistListReference,
    inaturalistResolveName,
    inaturalistFindPlaces,
    inaturalistSearchObservations,
    inaturalistGetObservation,
    inaturalistGetSpeciesCounts,
    inaturalistGetHistogram,
    inaturalistGetLeaderboard,
    inaturalistGetSimilarSpecies,
    inaturalistGetTaxon,
  ],
  resources: [inaturalistTaxonResource, inaturalistObservationResource],
  prompts: [],
  setup() {
    initINaturalistService();
  },
});
