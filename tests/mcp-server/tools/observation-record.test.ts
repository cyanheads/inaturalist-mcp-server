/**
 * @fileoverview Tests for the shared observation record renderer — headings,
 * licence labels, blockquoted third-party text, obscured-coordinate wording,
 * and the presence-based expansion blocks (photos, annotations, sounds,
 * identifications, comments, community consensus).
 * @module tests/mcp-server/tools/observation-record.test
 */

import { describe, expect, it } from 'vitest';
import {
  blockquote,
  licenceLabel,
  renderObservation,
  renderPhoto,
} from '@/mcp-server/tools/observation-record.js';
import {
  coordinate,
  projectedAnnotation,
  projectedComment,
  projectedIdentification,
  projectedObservation,
  projectedPhoto,
  projectedSound,
  taxonSummary,
} from '../../helpers/fixtures.js';

describe('licenceLabel', () => {
  it('renders a null licence as "All rights reserved", never a blank or dash', () => {
    expect(licenceLabel(null)).toBe('All rights reserved');
  });

  it('renders any other code verbatim', () => {
    expect(licenceLabel('cc-by-nc')).toBe('cc-by-nc');
  });
});

describe('blockquote', () => {
  it('prefixes a single line with a blockquote marker', () => {
    expect(blockquote('hello')).toEqual(['> hello']);
  });

  it('prefixes every line of multi-line text independently', () => {
    expect(blockquote('line one\nline two')).toEqual(['> line one', '> line two']);
  });
});

describe('renderPhoto', () => {
  it('renders the medium_url link, the licence, and the open-licence flag', () => {
    const lines = renderPhoto(
      projectedPhoto({
        medium_url: 'https://static.inaturalist.org/photos/1/medium.jpg',
        open: true,
      }),
      'Photo',
    );
    expect(lines[0]).toBe('**Photo:** https://static.inaturalist.org/photos/1/medium.jpg');
    expect(lines.join('\n')).toContain('open licence');
  });

  it('falls back to square_url when no medium variant is present', () => {
    // ProjectedPhoto's medium_url is optional, not nullable — a photo lacking
    // it simply omits the key, so build this fixture without the builder's
    // default rather than overriding it to undefined.
    const noMediumVariant = {
      square_url: 'https://static.inaturalist.org/photos/1/square.jpg',
      attribution: '(c) Kelly Yeates, all rights reserved',
      license_code: null,
      open: false,
    };
    const lines = renderPhoto(noMediumVariant, 'Photo');
    expect(lines[0]).toBe('**Photo:** https://static.inaturalist.org/photos/1/square.jpg');
  });

  it('renders a null licence as "All rights reserved" and the licence-not-open flag', () => {
    const lines = renderPhoto(projectedPhoto({ license_code: null, open: false }), 'Photo');
    expect(lines[1]).toContain('All rights reserved');
    expect(lines[1]).toContain('licence not open');
  });

  it('blockquotes the attribution verbatim, never shortening it', () => {
    const attribution =
      '(c) Alejandro Lopez, some rights reserved (CC BY-NC-SA), uploaded by Alejandro Lopez';
    const lines = renderPhoto(projectedPhoto({ attribution }), 'Photo');
    expect(lines).toContain(`> ${attribution}`);
  });

  it('renders a placeholder when no attribution string was published', () => {
    const lines = renderPhoto(projectedPhoto({ attribution: null }), 'Photo');
    expect(lines).toContain('_No attribution string published._');
  });
});

describe('renderObservation', () => {
  it('headings an unidentified observation with the Unidentified placeholder', () => {
    const lines = renderObservation(projectedObservation({ taxon: null }));
    expect(lines[0]).toBe('## Unidentified');
  });

  it('headings a fully-named taxon as "common name (scientific name)"', () => {
    const lines = renderObservation(
      projectedObservation({
        taxon: taxonSummary({ common_name: 'Monarch', name: 'Danaus plexippus' }),
      }),
    );
    expect(lines[0]).toBe('## Monarch (Danaus plexippus)');
  });

  it('falls back to the scientific name alone when no common name is recorded', () => {
    const lines = renderObservation(
      projectedObservation({
        taxon: taxonSummary({ common_name: null, name: 'Danaus plexippus' }),
      }),
    );
    expect(lines[0]).toBe('## Danaus plexippus');
  });

  it('renders the unnamed-taxon placeholder when neither name is recorded', () => {
    const lines = renderObservation(
      projectedObservation({ taxon: taxonSummary({ common_name: null, name: null }) }),
    );
    expect(lines[0]).toBe('## *(taxon name not recorded)*');
  });

  it('renders an obscured coordinate as a locality, not a sighting position', () => {
    const lines = renderObservation(
      projectedObservation({
        obscured: true,
        coordinate: coordinate({ lat: 47.6, lng: -122.3, accuracy_m: 26_839 }),
      }),
    );
    const locationLine = lines.find((line) => line.startsWith('**Location:**'));
    expect(locationLine).toContain('obscured locality');
    expect(locationLine).toContain('±26839 m');
    expect(locationLine).not.toMatch(/^\*\*Location:\*\* 47\.6, -122\.3 \(/);
  });

  it('renders a non-obscured coordinate as a plain lat/lng with accuracy', () => {
    const lines = renderObservation(
      projectedObservation({
        obscured: false,
        coordinate: coordinate({ lat: 47.6, lng: -122.3, accuracy_m: 15 }),
      }),
    );
    const locationLine = lines.find((line) => line.startsWith('**Location:**'));
    expect(locationLine).toBe('**Location:** 47.6, -122.3 (±15 m) · obscured: false');
  });

  it('reports no public coordinate when the record carries none', () => {
    const lines = renderObservation(projectedObservation({ coordinate: null, obscured: false }));
    const locationLine = lines.find((line) => line.startsWith('**Location:**'));
    expect(locationLine).toBe('**Location:** no public coordinate · obscured: false');
  });

  it('blockquotes the observer’s free-text locality when present', () => {
    const lines = renderObservation(projectedObservation({ place_guess: 'Seattle, WA' }));
    expect(lines).toContain('> Seattle, WA');
  });

  it('renders a null observation licence as All rights reserved in the status line', () => {
    const lines = renderObservation(projectedObservation({ license_code: null }));
    const statusLine = lines.find((line) => line.startsWith('**Status:**'));
    expect(statusLine).toContain('All rights reserved');
  });

  it('renders the first photo block when present, and omits it when absent', () => {
    const withPhoto = renderObservation(projectedObservation({ photo: projectedPhoto() }));
    expect(withPhoto.some((line) => line.startsWith('**Photo:**'))).toBe(true);

    const withoutPhoto = renderObservation(projectedObservation({ photo: null }));
    expect(withoutPhoto.some((line) => line.startsWith('**Photo:**'))).toBe(false);
  });

  it('renders the community consensus line only when the by-id fields are present', () => {
    const withConsensus = renderObservation(
      projectedObservation({
        community_taxon: taxonSummary(),
        identification_disagreements_count: 2,
      }),
    );
    expect(withConsensus.some((line) => line.startsWith('**Community consensus:**'))).toBe(true);

    const withoutConsensus = renderObservation(projectedObservation({}));
    expect(withoutConsensus.some((line) => line.startsWith('**Community consensus:**'))).toBe(
      false,
    );
  });

  it('renders "no consensus taxon yet" when community_taxon is present but null', () => {
    const lines = renderObservation(
      projectedObservation({ community_taxon: null, identification_disagreements_count: 0 }),
    );
    expect(lines.some((line) => line.includes('no consensus taxon yet'))).toBe(true);
  });

  it('renders the Photos sub-block only when the expanded array is non-empty', () => {
    const withPhotos = renderObservation(
      projectedObservation({ photos: [projectedPhoto(), projectedPhoto({ open: true })] }),
    );
    expect(withPhotos).toContain('### Photos');

    const withoutPhotos = renderObservation(projectedObservation({ photos: [] }));
    expect(withoutPhotos).not.toContain('### Photos');
  });

  it('renders the Annotations sub-block, decoded label first and undecoded placeholder otherwise', () => {
    const lines = renderObservation(
      projectedObservation({
        annotations: [projectedAnnotation(), projectedAnnotation({ attribute: null, value: null })],
      }),
    );
    expect(lines).toContain('### Annotations');
    expect(lines.some((line) => line.includes('**Life Stage** = Larva'))).toBe(true);
    expect(lines.some((line) => line.includes('undecoded attribute'))).toBe(true);
  });

  it('renders the Sounds sub-block with its licence, blockquoting attribution when present', () => {
    const lines = renderObservation(projectedObservation({ sounds: [projectedSound()] }));
    expect(lines).toContain('### Sounds');
    expect(lines.some((line) => line.includes('cc-by-nc'))).toBe(true);
    expect(lines.some((line) => line.startsWith('> (c) fieldrecorder'))).toBe(true);
  });

  it('renders the Identification thread with category, disagreement, and vision flags', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: [
          projectedIdentification({ category: 'maverick', disagreement: true, from_vision: true }),
        ],
      }),
    );
    expect(lines).toContain('### Identification thread');
    const entry = lines.find((line) => line.startsWith('- **identifier_one**'));
    expect(entry).toContain('maverick');
    expect(entry).toContain('disagreement: true');
    expect(entry).toContain('from image classifier: true');
  });

  it('blockquotes an identification body when present', () => {
    const lines = renderObservation(
      projectedObservation({ identifications: [projectedIdentification({ body: 'Note.' })] }),
    );
    expect(lines).toContain('> Note.');
  });

  it('renders the Comments sub-block, blockquoting each body', () => {
    const lines = renderObservation(
      projectedObservation({ comments: [projectedComment({ body: 'Nice shot!' })] }),
    );
    expect(lines).toContain('### Comments');
    expect(lines).toContain('> Nice shot!');
  });
});
