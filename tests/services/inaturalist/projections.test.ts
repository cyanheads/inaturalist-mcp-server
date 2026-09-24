/**
 * @fileoverview Tests for the pure upstream-to-domain projection functions —
 * coordinate parsing, bounding-box reduction, photo/licence derivation,
 * annotation decoding, and the observation/place/taxon projections.
 * @module tests/services/inaturalist/projections.test
 */

import { describe, expect, it } from 'vitest';
import {
  bboxFromPolygon,
  buildControlledTermIndex,
  decodeAnnotations,
  parseLocation,
  projectControlledTerm,
  projectObservation,
  projectObservedUsage,
  projectPhoto,
  projectPlace,
  projectTaxonRecord,
  projectTaxonSummary,
  THREAD_ENTRY_BUDGET,
  THREAD_ENTRY_FLOOR,
  threadCap,
} from '@/services/inaturalist/projections.js';
import {
  openPhoto,
  rawAnnotation,
  rawBoundingBoxPolygon,
  rawComment,
  rawControlledTerm,
  rawIdentification,
  rawObservation,
  rawPhoto,
  rawPlace,
  rawPopularFieldValue,
  rawSound,
  rawTaxon,
} from '../../helpers/fixtures.js';

describe('parseLocation', () => {
  it('splits the "lat,lng" string, pairing it with the accuracy radius', () => {
    expect(parseLocation('47.6062,-122.3321', 15)).toEqual({
      lat: 47.6062,
      lng: -122.3321,
      accuracy_m: 15,
    });
  });

  it('returns null when the observation carries no public coordinate', () => {
    expect(parseLocation(undefined, 15)).toBeNull();
    expect(parseLocation(null, 15)).toBeNull();
  });

  it('reports null accuracy when upstream omits it, rather than fabricating a value', () => {
    expect(parseLocation('1,2', undefined)).toEqual({ lat: 1, lng: 2, accuracy_m: null });
    expect(parseLocation('1,2', null)).toEqual({ lat: 1, lng: 2, accuracy_m: null });
  });

  it('returns null for a malformed location string rather than throwing', () => {
    expect(parseLocation('not-a-coordinate', 1)).toBeNull();
    expect(parseLocation('1,2,3', 1)).toBeNull();
    expect(parseLocation('1', 1)).toBeNull();
    expect(parseLocation('abc,def', 1)).toBeNull();
  });

  it('still reports the (unresolved) coordinate and its wide accuracy radius on an obscured record', () => {
    // obscured is surfaced by the caller, never resolved here — parseLocation
    // reads whatever upstream published on `location`/`public_positional_accuracy`.
    expect(parseLocation('47.6,-122.3', 26_839)).toEqual({
      lat: 47.6,
      lng: -122.3,
      accuracy_m: 26_839,
    });
  });
});

describe('bboxFromPolygon', () => {
  it('reduces a rectangular polygon ring to its corner pair by min/max', () => {
    expect(bboxFromPolygon(rawBoundingBoxPolygon())).toEqual({
      swlat: 47.5,
      swlng: -122.4,
      nelat: 47.7,
      nelng: -122.2,
    });
  });

  it('returns null when coordinates are missing or the wrong shape', () => {
    expect(bboxFromPolygon(undefined)).toBeNull();
    expect(bboxFromPolygon(null)).toBeNull();
    expect(bboxFromPolygon({ type: 'Polygon', coordinates: undefined })).toBeNull();
    expect(bboxFromPolygon({ type: 'Polygon', coordinates: 'not-an-array' })).toBeNull();
  });

  it('relays a degenerate box exactly as computed, without repair', () => {
    // The design log records a real upstream example: a place record whose
    // bounding polygon reduces to a near-zero-width sliver once the naive
    // min/max is taken. The function still computes the min/max faithfully —
    // "degenerate" describes the upstream geometry, not a bug in the reduction.
    const degenerate = rawBoundingBoxPolygon({
      coordinates: [
        [
          [0.0132, 10],
          [-0.0033, 10],
          [-0.0033, 20],
          [0.0132, 20],
          [0.0132, 10],
        ],
      ],
    });
    expect(bboxFromPolygon(degenerate)).toEqual({
      swlat: 10,
      swlng: -0.0033,
      nelat: 20,
      nelng: 0.0132,
    });
  });

  it('does not unwrap a MultiPolygon’s extra nesting level, so it returns null', () => {
    // A MultiPolygon nests one level deeper than a Polygon (polygons -> rings
    // -> points). bboxFromPolygon only unwraps rings -> points, so every
    // "point" it sees at the outer level is itself a ring array rather than a
    // [lng, lat] pair, and none of them passes the numeric-pair check. Not a
    // documented input shape for bounding_box_geojson (upstream always
    // returns a rectangular Polygon for it), so this is a robustness note
    // rather than a contract violation — flagged here in case a future
    // caller ever feeds this function a full geometry_geojson value instead.
    const multiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-122.4, 47.5],
            [-122.2, 47.5],
            [-122.2, 47.7],
            [-122.4, 47.7],
          ],
        ],
      ],
    };
    expect(bboxFromPolygon(multiPolygon)).toBeNull();
  });
});

describe('projectPhoto', () => {
  it('returns null for an absent photo', () => {
    expect(projectPhoto(undefined)).toBeNull();
    expect(projectPhoto(null)).toBeNull();
  });

  it('derives medium_url by substituting the size segment when upstream supplies none', () => {
    const photo = projectPhoto(
      rawPhoto({
        square_url: 'https://static.inaturalist.org/photos/1/square.jpg',
        medium_url: null,
      }),
    );
    expect(photo?.medium_url).toBe('https://static.inaturalist.org/photos/1/medium.jpg');
  });

  it('uses the upstream medium_url when supplied instead of deriving one', () => {
    const photo = projectPhoto(
      rawPhoto({
        square_url: 'https://static.inaturalist.org/photos/1/square.jpg',
        medium_url: 'https://static.inaturalist.org/photos/1/medium.jpg?variant=explicit',
      }),
    );
    expect(photo?.medium_url).toBe(
      'https://static.inaturalist.org/photos/1/medium.jpg?variant=explicit',
    );
  });

  it('omits medium_url rather than guessing when the path segment does not match a known size', () => {
    const photo = projectPhoto(
      rawPhoto({
        square_url: 'https://static.inaturalist.org/photos/1/cover.jpg',
        medium_url: null,
      }),
    );
    expect(photo?.medium_url).toBeUndefined();
  });

  it('derives open: true only for the S3 open-data host', () => {
    expect(projectPhoto(openPhoto())?.open).toBe(true);
  });

  it('derives open: false for the static.inaturalist.org host', () => {
    expect(projectPhoto(rawPhoto())?.open).toBe(false);
  });

  it('derives open: false for a host it does not recognize, never treating it as evidence of an open licence', () => {
    const photo = projectPhoto(
      rawPhoto({ square_url: 'https://cdn.some-other-host.example/photos/1/square.jpg' }),
    );
    expect(photo?.open).toBe(false);
  });

  it('relays a null license_code and attribution verbatim, never coercing them', () => {
    const photo = projectPhoto(rawPhoto({ license_code: null, attribution: null }));
    expect(photo).toMatchObject({ license_code: null, attribution: null });
  });

  it('falls back to url when square_url is absent', () => {
    const photo = projectPhoto({ url: 'https://static.inaturalist.org/photos/1/square.jpg' });
    expect(photo?.square_url).toBe('https://static.inaturalist.org/photos/1/square.jpg');
  });
});

describe('buildControlledTermIndex / decodeAnnotations', () => {
  it('decodes an annotation pair present in the cached vocabulary', () => {
    const index = buildControlledTermIndex([projectControlledTerm(rawControlledTerm())]);
    const [decoded] = decodeAnnotations(
      [rawAnnotation({ controlled_attribute_id: 1, controlled_value_id: 6 })],
      index,
    );
    expect(decoded).toEqual({
      attribute: 'Life Stage',
      value: 'Larva',
      attribute_id: 1,
      value_id: 6,
      by: 'the_insect_cabinet',
    });
  });

  it('emits null labels for an id pair the vocabulary does not carry, never fabricating one', () => {
    const index = buildControlledTermIndex([projectControlledTerm(rawControlledTerm())]);
    const [decoded] = decodeAnnotations(
      [rawAnnotation({ controlled_attribute_id: 999, controlled_value_id: 999 })],
      index,
    );
    expect(decoded).toEqual({
      attribute: null,
      value: null,
      attribute_id: 999,
      value_id: 999,
      by: 'the_insect_cabinet',
    });
  });

  it('emits null labels with no vocabulary index at all rather than throwing', () => {
    const [decoded] = decodeAnnotations([rawAnnotation()], undefined);
    expect(decoded?.attribute).toBeNull();
    expect(decoded?.value).toBeNull();
  });

  it('drops an annotation missing either id', () => {
    expect(decodeAnnotations([{ user: { login: 'x' } }], undefined)).toEqual([]);
  });

  it('returns an empty array for an absent annotations list', () => {
    expect(decodeAnnotations(undefined, undefined)).toEqual([]);
    expect(decodeAnnotations(null, undefined)).toEqual([]);
  });
});

describe('projectTaxonSummary / projectTaxonRecord', () => {
  it('projects the five-field summary', () => {
    expect(projectTaxonSummary(rawTaxon())).toEqual({
      id: 48662,
      name: 'Danaus plexippus',
      rank: 'species',
      common_name: 'Monarch',
      iconic_taxon_name: 'Insecta',
    });
  });

  it('returns null when the raw taxon carries no numeric id', () => {
    expect(projectTaxonSummary(undefined)).toBeNull();
    expect(projectTaxonSummary({})).toBeNull();
  });

  it('projects a sparse taxon without fabricating the optional fields', () => {
    const record = projectTaxonRecord({ id: 1, name: 'Bare species' });
    expect(record).toEqual({
      id: 1,
      name: 'Bare species',
      rank: null,
      common_name: null,
      iconic_taxon_name: null,
    });
    expect(record).not.toHaveProperty('rank_level');
    expect(record).not.toHaveProperty('observations_count');
    expect(record).not.toHaveProperty('photo');
  });

  it('carries rank_level, observations_count, and photo when upstream supplies them', () => {
    const record = projectTaxonRecord(rawTaxon());
    expect(record).toMatchObject({ rank_level: 10, observations_count: 250_000 });
    expect(record?.photo).not.toBeNull();
  });
});

describe('projectObservation', () => {
  it('projects the default record with no expansion arrays present', () => {
    const observation = projectObservation(rawObservation());
    expect(observation).toMatchObject({
      id: 401617560,
      uuid: 'abc-uuid-1',
      url: 'https://www.inaturalist.org/observations/401617560',
      observed_on: '2026-06-01',
      quality_grade: 'research',
      obscured: false,
      captive: false,
      photo_count: 1,
      sound_count: 0,
      observer: 'observer_one',
    });
    expect(observation.photos).toBeUndefined();
    expect(observation.annotations).toBeUndefined();
    expect(observation.sounds).toBeUndefined();
    expect(observation.identifications).toBeUndefined();
    expect(observation.comments).toBeUndefined();
    expect(observation.community_taxon).toBeUndefined();
    expect(observation.identification_disagreements_count).toBeUndefined();
  });

  it('projects an unidentified, sparse observation without fabricating facts', () => {
    const observation = projectObservation({
      id: 2,
      taxon: null,
      photos: [],
      sounds: [],
      location: null,
    });
    expect(observation.taxon).toBeNull();
    expect(observation.coordinate).toBeNull();
    expect(observation.photo).toBeNull();
    expect(observation.photo_count).toBe(0);
    expect(observation.uuid).toBeNull();
    expect(observation.license_code).toBeNull();
    expect(observation.community_taxon_id).toBeNull();
  });

  it('expands photos only when "photos" is included', () => {
    const withPhotos = projectObservation(rawObservation({ photos: [rawPhoto(), openPhoto()] }), {
      include: new Set(['photos']),
    });
    expect(withPhotos.photos).toHaveLength(2);
    expect(withPhotos.photos?.[1]?.open).toBe(true);

    const withoutPhotos = projectObservation(rawObservation({ photos: [rawPhoto(), openPhoto()] }));
    expect(withoutPhotos.photos).toBeUndefined();
  });

  it('decodes annotations against the cached vocabulary when "annotations" is included', () => {
    const index = buildControlledTermIndex([projectControlledTerm(rawControlledTerm())]);
    const observation = projectObservation(rawObservation(), {
      include: new Set(['annotations']),
      terms: index,
    });
    expect(observation.annotations).toEqual([
      {
        attribute: 'Life Stage',
        value: 'Larva',
        attribute_id: 1,
        value_id: 6,
        by: 'the_insect_cabinet',
      },
    ]);
  });

  it('expands sounds only when "sounds" is included', () => {
    const observation = projectObservation(rawObservation({ sounds: [rawSound()] }), {
      include: new Set(['sounds']),
    });
    expect(observation.sounds).toEqual([
      {
        url: 'https://static.inaturalist.org/sounds/1.mp3',
        attribution: '(c) fieldrecorder, some rights reserved (CC BY-NC)',
        license_code: 'cc-by-nc',
      },
    ]);
  });

  it('projects an agreeing, current identification', () => {
    const observation = projectObservation(
      rawObservation({
        identifications: [
          rawIdentification({ category: 'supporting', disagreement: false, current: true }),
        ],
      }),
      { include: new Set(['identifications']) },
    );
    expect(observation.identifications?.[0]).toMatchObject({
      category: 'supporting',
      disagreement: false,
      current: true,
    });
  });

  it('projects a disagreeing identification', () => {
    const observation = projectObservation(
      rawObservation({
        identifications: [rawIdentification({ category: 'maverick', disagreement: true })],
      }),
      { include: new Set(['identifications']) },
    );
    expect(observation.identifications?.[0]).toMatchObject({
      category: 'maverick',
      disagreement: true,
    });
  });

  it('projects a withdrawn (no longer current) identification', () => {
    const observation = projectObservation(
      rawObservation({ identifications: [rawIdentification({ current: false })] }),
      { include: new Set(['identifications']) },
    );
    expect(observation.identifications?.[0]).toMatchObject({ current: false });
  });

  it('marks from_vision true for a computer-vision identification', () => {
    const observation = projectObservation(
      rawObservation({ identifications: [rawIdentification({ vision: true })] }),
      { include: new Set(['identifications']) },
    );
    expect(observation.identifications?.[0]?.from_vision).toBe(true);
  });

  it('expands comments only when "comments" is included', () => {
    const observation = projectObservation(rawObservation(), { include: new Set(['comments']) });
    expect(observation.comments).toEqual([
      {
        id: 2001,
        by: 'commenter_one',
        body: 'Great find!',
        created_at: '2026-06-01T13:00:00-07:00',
      },
    ]);
  });

  it('carries community_taxon and identification_disagreements_count only in detail mode', () => {
    const detailed = projectObservation(rawObservation(), { detail: true });
    expect(detailed.community_taxon).toEqual({
      id: 48662,
      name: 'Danaus plexippus',
      rank: 'species',
      common_name: 'Monarch',
      iconic_taxon_name: 'Insecta',
    });
    expect(detailed.identification_disagreements_count).toBe(0);

    const notDetailed = projectObservation(rawObservation());
    expect(notDetailed.community_taxon).toBeUndefined();
    expect(notDetailed.identification_disagreements_count).toBeUndefined();
  });

  it('projects every identification and comment in upstream order when no thread cap is given', () => {
    const observation = projectObservation(
      rawObservation({
        identifications: [3, 1, 2].map((id) => rawIdentification({ id })),
        comments: [30, 10, 20].map((id) => rawComment({ id })),
      }),
      { include: new Set(['identifications', 'comments']) },
    );
    expect(observation.identifications?.map((entry) => entry.id)).toEqual([3, 1, 2]);
    expect(observation.comments?.map((entry) => entry.id)).toEqual([30, 10, 20]);
  });

  it('keeps the first threadCap entries of each thread array, in upstream order, with the upstream total', () => {
    const observation = projectObservation(
      rawObservation({
        identifications: [5, 3, 1, 4, 2].map((id) => rawIdentification({ id })),
        comments: [50, 30, 10].map((id) => rawComment({ id })),
      }),
      { include: new Set(['identifications', 'comments']), detail: true, threadCap: 2 },
    );
    expect(observation.identifications?.map((entry) => entry.id)).toEqual([5, 3]);
    expect(observation.identifications_total).toBe(5);
    expect(observation.identifications_shown).toBe(2);
    expect(observation.comments?.map((entry) => entry.id)).toEqual([50, 30]);
    expect(observation.comments_total).toBe(3);
    expect(observation.comments_shown).toBe(2);
  });

  it('keeps a thread exactly at the cap whole, and reports shown equal to total', () => {
    const observation = projectObservation(
      rawObservation({ identifications: [1, 2, 3].map((id) => rawIdentification({ id })) }),
      { include: new Set(['identifications']), detail: true, threadCap: 3 },
    );
    expect(observation.identifications).toHaveLength(3);
    expect(observation.identifications_total).toBe(3);
    expect(observation.identifications_shown).toBe(3);
  });

  it('reports zero for an included thread upstream returned empty or omitted', () => {
    const { comments: _omitted, ...withoutComments } = rawObservation({ identifications: [] });
    const observation = projectObservation(withoutComments, {
      include: new Set(['identifications', 'comments']),
      detail: true,
      threadCap: 40,
    });
    expect(observation.identifications).toEqual([]);
    expect(observation.identifications_total).toBe(0);
    expect(observation.identifications_shown).toBe(0);
    expect(observation.comments).toEqual([]);
    expect(observation.comments_total).toBe(0);
    expect(observation.comments_shown).toBe(0);
  });

  it('carries no thread counts for an arm that was not included', () => {
    const observation = projectObservation(rawObservation(), {
      include: new Set(['identifications']),
      detail: true,
      threadCap: 40,
    });
    expect(observation.identifications_total).toBe(1);
    expect(observation).not.toHaveProperty('comments');
    expect(observation).not.toHaveProperty('comments_total');
    expect(observation).not.toHaveProperty('comments_shown');

    const bare = projectObservation(rawObservation(), { detail: true, threadCap: 40 });
    expect(bare).not.toHaveProperty('identifications_total');
    expect(bare).not.toHaveProperty('identifications_shown');
  });

  it("relays the observer's description and the filled observation-field values in detail mode", () => {
    const observation = projectObservation(
      rawObservation({
        description: 'caterpillar on narrow-leaf milkweed',
        ofvs: [
          { name: 'Habitat_Description', value: 'Garden' },
          { name: 'Blank', value: '' },
          { name: 'Whitespace', value: '   ' },
          { name: 'Missing', value: null },
          { name: 'Literal null', value: 'null' },
          { name: null, value: '8' },
        ],
      }),
      { detail: true },
    );
    expect(observation.description).toBe('caterpillar on narrow-leaf milkweed');
    expect(observation.observation_fields).toEqual([
      { name: 'Habitat_Description', value: 'Garden' },
      { name: 'Literal null', value: 'null' },
      { name: null, value: '8' },
    ]);
  });

  it('reports a null description and no observation fields when upstream carries none', () => {
    const observation = projectObservation(rawObservation({ ofvs: null }), { detail: true });
    expect(observation.description).toBeNull();
    expect(observation.observation_fields).toEqual([]);
  });

  it('leaves description and observation_fields off a search (non-detail) record', () => {
    const observation = projectObservation(
      rawObservation({ description: 'A note.', ofvs: [{ name: 'A', value: 'B' }] }),
    );
    expect(observation).not.toHaveProperty('description');
    expect(observation).not.toHaveProperty('observation_fields');
    expect(observation).not.toHaveProperty('observation_fields_total');
    expect(observation).not.toHaveProperty('observation_fields_shown');
  });

  it('cuts filled observation fields to the thread cap after dropping blanks, with the filled total', () => {
    const observation = projectObservation(
      rawObservation({
        ofvs: [
          { name: 'A', value: '' },
          { name: 'B', value: '1' },
          { name: 'C', value: ' ' },
          { name: 'D', value: '2' },
          { name: 'E', value: '3' },
        ],
      }),
      { detail: true, threadCap: 2 },
    );
    expect(observation.observation_fields).toEqual([
      { name: 'B', value: '1' },
      { name: 'D', value: '2' },
    ]);
    expect(observation.observation_fields_total).toBe(3);
    expect(observation.observation_fields_shown).toBe(2);
  });

  it('keeps every filled field and reports shown equal to total when no cap is given', () => {
    const observation = projectObservation(
      rawObservation({
        ofvs: [
          { name: 'A', value: '1' },
          { name: 'B', value: '2' },
        ],
      }),
      { detail: true },
    );
    expect(observation.observation_fields).toHaveLength(2);
    expect(observation.observation_fields_total).toBe(2);
    expect(observation.observation_fields_shown).toBe(2);
  });

  it('reports an obscured observation’s coordinate and wide accuracy radius without resolving it', () => {
    const observation = projectObservation(
      rawObservation({
        obscured: true,
        location: '47.6,-122.3',
        public_positional_accuracy: 26_839,
      }),
    );
    expect(observation.obscured).toBe(true);
    expect(observation.coordinate).toEqual({ lat: 47.6, lng: -122.3, accuracy_m: 26_839 });
  });
});

describe('threadCap — the batch-shared identification/comment budget', () => {
  it('pins the budget at 40 entries and the per-record floor at 4', () => {
    expect(THREAD_ENTRY_BUDGET).toBe(40);
    expect(THREAD_ENTRY_FLOOR).toBe(4);
  });

  it('gives a single record the whole budget', () => {
    expect(threadCap(1)).toBe(40);
  });

  it('splits the budget evenly across a batch, rounding down', () => {
    expect(threadCap(2)).toBe(20);
    expect(threadCap(3)).toBe(13);
    expect(threadCap(8)).toBe(5);
  });

  it('never drops below the floor, however large the batch', () => {
    expect(threadCap(9)).toBe(4);
    expect(threadCap(10)).toBe(4);
  });
});

describe('projectPlace', () => {
  it('projects a place, dropping geometry_geojson and reducing the bounding polygon to a bbox', () => {
    expect(projectPlace(rawPlace())).toEqual({
      id: 1,
      name: 'Seattle',
      display_name: 'Seattle, WA, US',
      place_type: 100,
      admin_level: null,
      bbox: { swlat: 47.5, swlng: -122.4, nelat: 47.7, nelng: -122.2 },
      ancestor_place_ids: [97394, 1],
      location: { lat: 47.6062, lng: -122.3321 },
      slug: 'seattle-wa-us',
    });
  });

  it('relays raw place_type and admin_level integers without inventing a label', () => {
    const place = projectPlace(rawPlace({ place_type: 16, admin_level: 29 }));
    expect(place.place_type).toBe(16);
    expect(place.admin_level).toBe(29);
  });

  it('reports a null bbox and location, and an empty containment chain, for a sparse place', () => {
    const place = projectPlace({ id: 2 });
    expect(place.bbox).toBeNull();
    expect(place.location).toBeNull();
    expect(place.ancestor_place_ids).toEqual([]);
  });
});

describe('projectControlledTerm / projectObservedUsage', () => {
  it('projects a controlled term with its values', () => {
    expect(projectControlledTerm(rawControlledTerm())).toEqual({
      id: 1,
      label: 'Life Stage',
      multivalued: false,
      values: [
        { id: 2, label: 'Adult', blocking: false },
        { id: 6, label: 'Larva', blocking: false },
      ],
    });
  });

  it('projects observed annotation usage from popular_field_values', () => {
    expect(projectObservedUsage(rawPopularFieldValue())).toEqual({
      attribute: 'Life Stage',
      value: 'Adult',
      count: 336_576,
    });
  });

  it('defaults a missing count to zero rather than null', () => {
    expect(projectObservedUsage({}).count).toBe(0);
  });
});
