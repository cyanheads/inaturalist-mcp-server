/**
 * @fileoverview Smoke coverage for every tool this server registers: the
 * defaults each input schema applies, and the one handler that answers without
 * an upstream call, run end to end through `format()`.
 * @module tests/smoke/definitions.smoke.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { inaturalistFindPlaces } from '@/mcp-server/tools/definitions/inaturalist-find-places.tool.js';
import { inaturalistGetHistogram } from '@/mcp-server/tools/definitions/inaturalist-get-histogram.tool.js';
import { inaturalistGetLeaderboard } from '@/mcp-server/tools/definitions/inaturalist-get-leaderboard.tool.js';
import { inaturalistGetObservation } from '@/mcp-server/tools/definitions/inaturalist-get-observation.tool.js';
import { inaturalistGetSimilarSpecies } from '@/mcp-server/tools/definitions/inaturalist-get-similar-species.tool.js';
import { inaturalistGetSpeciesCounts } from '@/mcp-server/tools/definitions/inaturalist-get-species-counts.tool.js';
import { inaturalistListReference } from '@/mcp-server/tools/definitions/inaturalist-list-reference.tool.js';
import { inaturalistResolveName } from '@/mcp-server/tools/definitions/inaturalist-resolve-name.tool.js';
import { inaturalistSearchObservations } from '@/mcp-server/tools/definitions/inaturalist-search-observations.tool.js';
import {
  projectedAnnotation,
  projectedObservation,
  projectedPhoto,
  projectedSound,
} from '../helpers/fixtures.js';
import { markdownText } from '../helpers/rendering-commonmark.js';

describe('definition smoke test', () => {
  it('serves a static vocabulary and renders every entry', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'iconic_taxa' });
    const result = await inaturalistListReference.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(inaturalistListReference.output));
    expect(result.source).toBe('static');
    expect(result.entries).toHaveLength(14);

    const [block] = inaturalistListReference.format?.(result) ?? [];
    expect(block).toMatchObject({ type: 'text' });
    expect(markdownText(block && 'text' in block ? block.text : '')).toContain('code Aves');
  });

  it('rejects taxon_id on a topic that does not take it', async () => {
    const ctx = createMockContext({ errors: inaturalistListReference.errors });
    const input = inaturalistListReference.input.parse({ topic: 'ranks', taxon_id: 48662 });

    await expect(inaturalistListReference.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'taxon_id_not_applicable' },
    });
  });

  it('applies the documented defaults on every registered tool', () => {
    expect(inaturalistResolveName.input.parse({ q: 'monarch' })).toMatchObject({
      type: 'taxon',
      limit: 10,
    });
    expect(inaturalistFindPlaces.input.parse({ q: 'Seattle' })).toMatchObject({ per_page: 10 });
    expect(inaturalistSearchObservations.input.parse({ place_id: 1 })).toMatchObject({
      quality_grade: ['research'],
      captive: false,
      order_by: 'observed_on',
      order: 'desc',
      per_page: 10,
    });
    expect(inaturalistGetObservation.input.parse({ observation_id: [401617560] })).toMatchObject({
      include: ['identifications'],
    });
    expect(inaturalistGetSimilarSpecies.input.parse({ taxon_id: 48662 })).toMatchObject({
      quality_grade: ['research'],
      captive: false,
      limit: 20,
    });
  });

  it.each([
    inaturalistSearchObservations,
    inaturalistGetSpeciesCounts,
    inaturalistGetHistogram,
    inaturalistGetSimilarSpecies,
    inaturalistGetLeaderboard,
  ])('describes what $name fields do, not how upstream is wired', (definition) => {
    const advertised = JSON.stringify([definition.description, z.toJSONSchema(definition.input)]);
    for (const clause of [
      'answers HTTP 500 upstream',
      'ignored upstream and the unfiltered corpus comes back',
      'matches nothing upstream',
      'sent upstream as id_below',
      '28 KB',
    ]) {
      expect(advertised).not.toContain(clause);
    }
    expect(advertised).toContain('inaturalist_find_places');
  });

  it('keeps each trimmed field’s constraint and pointer', () => {
    const shape = inaturalistSearchObservations.input.shape;
    expect(shape.place_id.description).toContain('Mutually exclusive');
    expect(shape.term_value_id.description).toContain('Requires term_id');
    expect(shape.iconic_taxa.description).toContain('inaturalist_list_reference topic iconic_taxa');
    expect(shape.cursor.description).toContain('Mutually exclusive with page');
    expect(inaturalistSearchObservations.description).toContain('inaturalist_get_observation');
  });

  it('declares the upstream rank floor on inaturalist_get_similar_species as a typed reason', () => {
    expect(inaturalistGetSimilarSpecies.errors?.map((entry) => entry.reason)).toEqual([
      'unknown_place_id',
      'invalid_geography',
      'inverted_date_range',
      'unknown_taxon_id',
      'taxon_rank_too_coarse',
      'rate_budget_exhausted',
    ]);
  });

  it('accepts the by-id thread counts and detail fields on the observation output schema', () => {
    const record = inaturalistGetObservation.output.shape.observations.element.parse({
      id: 1,
      uuid: null,
      url: null,
      observed_on: null,
      observed_at: null,
      created_at: null,
      updated_at: null,
      taxon: null,
      place_guess: null,
      coordinate: null,
      obscured: false,
      geoprivacy: null,
      taxon_geoprivacy: null,
      quality_grade: 'needs_id',
      license_code: null,
      captive: false,
      photo: null,
      photo_count: 0,
      sound_count: 0,
      observer: null,
      identifications_count: 0,
      agreements: 0,
      disagreements: 0,
      community_taxon_id: null,
      identifications: [],
      identifications_total: 0,
      identifications_shown: 0,
      description: null,
      observation_fields: [],
    });
    expect(record).toMatchObject({ identifications_total: 0, description: null });
  });

  it('advertises only reachable search record fields while retaining all media expansions', () => {
    const search = inaturalistSearchObservations.output.shape.observations.element;
    const detail = inaturalistGetObservation.output.shape.observations.element;
    expect(Object.keys(detail.shape).filter((key) => !(key in search.shape))).toEqual([
      'identifications',
      'identifications_total',
      'identifications_shown',
      'identifications_hidden',
      'comments',
      'comments_total',
      'comments_shown',
      'comments_hidden',
      'community_taxon',
      'identification_disagreements_count',
      'description',
      'observation_fields',
      'observation_fields_total',
      'observation_fields_shown',
    ]);
    for (const record of [
      projectedObservation(),
      projectedObservation({
        photos: [projectedPhoto()],
        annotations: [projectedAnnotation()],
        sounds: [projectedSound()],
      }),
    ]) {
      expect(search.parse(record)).toEqual(record);
    }
  });
});
