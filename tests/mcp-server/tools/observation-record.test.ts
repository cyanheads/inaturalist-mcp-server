/**
 * @fileoverview Tests for the shared observation record renderer — headings,
 * licence labels, blockquoted third-party text, obscured-coordinate wording,
 * and the presence-based expansion blocks (photos, annotations, sounds,
 * identifications, comments, community consensus).
 * @module tests/mcp-server/tools/observation-record.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  blockquote,
  inlineText,
  licenceLabel,
  ObservationSchema,
  renderObservation,
  renderPhoto,
  SearchObservationSchema,
} from '@/mcp-server/tools/observation-record.js';
import { projectObservation } from '@/services/inaturalist/projections.js';
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
import { markdownNodes, markdownText } from '../../helpers/rendering-commonmark.js';

describe('literal relay characterization', () => {
  it('keeps the structured record and omitted expansion state unchanged while rendering', () => {
    const observation = projectedObservation({ observer: 'literal &amp; <b>observer</b>' });
    const before = structuredClone(observation);
    renderObservation(observation);
    expect(observation).toEqual(before);
    expect(observation.observer).toBe('literal &amp; <b>observer</b>');
    expect(observation).not.toHaveProperty('photos');
    expect(observation).not.toHaveProperty('description');
  });
});

describe('search schema fragment', () => {
  it('preserves full timestamp strings through projection, parsing and literal rendering', () => {
    const created_at = `2026-10-31T18:21:59.123456789-07:00${' '.repeat(8_000)}<&amp;>\r\n`;
    const updated_at = '';
    const observation = projectObservation({ id: 1, created_at, updated_at });
    for (const schema of [ObservationSchema, SearchObservationSchema]) {
      const parsed = schema.parse(observation);
      expect(parsed.created_at).toBe(created_at);
      expect(parsed.updated_at).toBe(updated_at);
      const text = markdownText(renderObservation(parsed).join('\n'));
      expect(text).toContain(`created_at: ${created_at} · updated_at:`);
    }
  });

  it('retains complete observation timestamps on both output schemas and CommonMark', () => {
    const timestamps = {
      created_at: '2026-10-31T18:21:59-07:00',
      updated_at: '2026-10-31T21:14:43-07:00',
    };
    for (const schema of [ObservationSchema, SearchObservationSchema]) {
      const parsed = schema.parse({ ...projectedObservation(), ...timestamps });
      expect(parsed).toMatchObject(timestamps);
      const text = markdownText(renderObservation(parsed).join('\n'));
      expect(text).toContain(`created_at: ${timestamps.created_at}`);
      expect(text).toContain(`updated_at: ${timestamps.updated_at}`);
    }
  });

  it('renders both null observation timestamp keys explicitly', () => {
    const parsed = ObservationSchema.parse({
      ...projectedObservation(),
      created_at: null,
      updated_at: null,
    });
    expect(parsed).toMatchObject({ created_at: null, updated_at: null });
    const text = markdownText(renderObservation(parsed).join('\n'));
    expect(text).toContain('created_at: null');
    expect(text).toContain('updated_at: null');
  });

  it('exports a schema omitting exactly the fourteen unreachable detail fields', async () => {
    const detailFields = [
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
    ];
    expect(
      Object.keys(ObservationSchema.shape).filter((key) => !(key in SearchObservationSchema.shape)),
    ).toEqual(detailFields);
    for (const [key, schema] of Object.entries(SearchObservationSchema.shape)) {
      expect(schema).toBe(ObservationSchema.shape[key as keyof typeof ObservationSchema.shape]);
    }
    const record = projectedObservation({
      photos: [projectedPhoto()],
      annotations: [projectedAnnotation()],
      sounds: [projectedSound()],
    });
    expect(SearchObservationSchema.parse(record)).toEqual(record);
    expect(Object.keys(SearchObservationSchema.shape)).toEqual(
      expect.arrayContaining([
        'community_taxon_id',
        'outlinks',
        'identifications_count',
        'agreements',
        'disagreements',
        'photos',
        'annotations',
        'sounds',
      ]),
    );
  });
});

describe('lossless literal relay', () => {
  const values = [
    '<b>x</b> *x* `x` &amp; [x](https://example.test)',
    '  leading\tand trailing  ',
    '\n\n  blank\r\nline\rtrail\n',
    '# heading\n- list\n> quote\n---',
    'a\\b \\* [brackets] _emphasis_',
  ];

  it.each(values)('recovers inline text exactly: %j', (value) => {
    const rendered = `## ${inlineText(value)}`;
    expect(markdownText(rendered)).toBe(value);
    expect(markdownNodes(rendered).map((node) => node.type)).not.toEqual(
      expect.arrayContaining(['html_inline', 'html_block', 'link', 'code', 'emph', 'list']),
    );
    expect(markdownNodes(rendered).filter((node) => node.type === 'heading')).toHaveLength(1);
  });

  it.each(values)('recovers quoted text exactly: %j', (value) => {
    const rendered = blockquote(value).join('\n');
    expect(rendered.split('\n').every((line) => line.startsWith('> '))).toBe(true);
    expect(markdownText(rendered)).toBe(value);
    expect(markdownNodes(rendered).map((node) => node.type)).not.toEqual(
      expect.arrayContaining([
        'html_inline',
        'html_block',
        'link',
        'code',
        'emph',
        'list',
        'heading',
      ]),
    );
  });

  it('labels a NUL-containing value as a lossless JSON string literal', () => {
    const value = 'null\u0000byte\r\n<b>&amp;</b>';
    for (const rendered of [inlineText(value), blockquote(value).join('\n')]) {
      const text = markdownText(rendered);
      expect(text.startsWith('JSON string literal: ')).toBe(true);
      expect(JSON.parse(text.slice('JSON string literal: '.length))).toBe(value);
    }
  });

  it('keeps URL destinations and attribution text independently lossless', () => {
    const url = 'https://example.test/a_(b)?q=&amp;';
    const attribution = '  <b>Owner</b> &amp; *rights*\r\nreserved\n';
    const photo = projectedPhoto({ medium_url: url, square_url: url, attribution });
    const before = structuredClone(photo);
    const rendered = renderPhoto(photo, 'Photo').join('\n');
    expect(
      markdownNodes(rendered)
        .filter((node) => node.type === 'link')
        .map((node) => node.destination),
    ).toEqual([url, url]);
    expect(markdownText(rendered)).toContain(attribution);
    expect(photo).toEqual(before);
  });

  it('renders outlinks as one line of links whose destinations round-trip exactly', () => {
    const outlinks = [
      { source: 'GBIF', url: 'http://www.gbif.org/occurrence/2006102216' },
      {
        source: 'GloBI',
        url: 'http://www.globalbioticinteractions.org/?interactionType=interactsWith&accordingTo=https://www.inaturalist.org/observations/5890862',
      },
      { source: 'Odd <source> & *label*', url: 'https://example.test/a_(b)?q=&amp;&x=1' },
    ];
    const observation = projectedObservation({ outlinks });
    const before = structuredClone(observation);
    const line = renderObservation(observation).find((entry) => entry.startsWith('**Outlinks:**'));
    expect(line).toMatch(
      /^\*\*Outlinks:\*\* \[GBIF\]\(<http:\/\/www\.gbif\.org\/occurrence\/2006102216>\) · \[GloBI\]\(<http:\/\/www\.globalbioticinteractions\.org\/\?interactionType=interactsWith&accordingTo=https:\/\/www\.inaturalist\.org\/observations\/5890862>\) · \[/,
    );
    const nodes = markdownNodes(line ?? '');
    const links = nodes.filter((node) => node.type === 'link');
    expect(links.map((node) => node.destination)).toEqual(outlinks.map((entry) => entry.url));
    expect(markdownText(line ?? '')).toBe(
      `Outlinks: ${outlinks.map((entry) => entry.source).join(' · ')}`,
    );
    expect(nodes.filter((node) => node.type === 'html_inline' || node.type === 'emph')).toEqual([]);
    expect(observation).toEqual(before);
  });

  it('renders none for an empty outlinks array and no line when the record carries none', () => {
    const lines = renderObservation(projectedObservation({ outlinks: [] }));
    expect(lines).toContain('**Outlinks:** none');
    const { outlinks: _omitted, ...withoutOutlinks } = projectedObservation();
    expect(renderObservation(withoutOutlinks).join('\n')).not.toContain('Outlinks');
  });

  it('keeps an outlink with a missing source or url visible as literal text', () => {
    const line = renderObservation(
      projectedObservation({
        outlinks: [
          { source: 'EDDMapS', url: null },
          { source: null, url: 'https://x.test/' },
        ],
      }),
    ).find((entry) => entry.startsWith('**Outlinks:**'));
    expect(line).toBe(
      '**Outlinks:** EDDMapS (no URL published) · [source not recorded](<https://x.test/>)',
    );
  });

  it('distinguishes omitted, null, empty, and populated detail states', () => {
    const omitted = renderObservation(projectedObservation()).join('\n');
    expect(omitted).not.toContain('Observer’s description');
    expect(omitted).not.toContain('### Photos');
    const nullText = renderObservation(projectedObservation({ description: null })).join('\n');
    expect(nullText).toContain('**Observer’s description:** no description');
    const emptyText = renderObservation(projectedObservation({ description: '' })).join('\n');
    expect(emptyText).toContain('**Observer’s description:** empty string');
    const expanded = projectedObservation({
      photos: [],
      annotations: [],
      sounds: [],
      observation_fields: [],
      observation_fields_total: 0,
      observation_fields_shown: 0,
    });
    const text = renderObservation(expanded).join('\n');
    for (const section of ['Photos', 'Annotations', 'Sounds']) {
      expect(text).toContain(`### ${section}\n_none_`);
    }
    expect(text).toContain('### Observation fields — 0 of 0 shown\n_none_');
    expect(expanded.observation_fields_total).toBe(0);
    expect(expanded.photos).toEqual([]);
  });

  it('renders either observation-field count when supplied independently', () => {
    expect(
      renderObservation(projectedObservation({ observation_fields_shown: 0 })).join('\n'),
    ).toContain('### Observation fields — 0 shown');
    expect(
      renderObservation(projectedObservation({ observation_fields_total: 5 })).join('\n'),
    ).toContain('### Observation fields — 5 total');
  });

  it('round-trips generated literal strings through the real observation formatter', () => {
    const character = fc.constantFrom(
      ...Array.from(' <>&*`[]()_\\!#|~\t\r\n'),
      'é',
      '🦋',
      '\u000b',
      '\u00a0',
    );
    fc.assert(
      fc.property(fc.array(character, { minLength: 1, maxLength: 100 }), (chars) => {
        const value = chars.join('');
        const observation = projectedObservation({
          observer: value,
          place_guess: value,
          taxon: taxonSummary({ common_name: value }),
          description: value,
          comments: [projectedComment({ by: value, body: value })],
          observation_fields: [{ name: value, value, datatype: value }],
        });
        const before = structuredClone(observation);
        const rendered = renderObservation(observation).join('\n');
        expect(markdownText(rendered)).toContain(value);
        expect(
          markdownNodes(rendered).filter(
            (node) => node.type === 'html_inline' || node.type === 'html_block',
          ),
        ).toEqual([]);
        expect(
          markdownNodes(rendered).filter((node) => node.type === 'heading' && node.level === 2),
        ).toHaveLength(1);
        expect(observation).toEqual(before);
        expect(markdownText(inlineText(value))).toBe(value);
        expect(markdownText(blockquote(value).join('\n'))).toBe(value);
      }),
      { numRuns: 200, seed: 36 },
    );
  });
});

describe('literal relay timing', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const SIZE_CPU_BOUND_MICROS = 2_000_000;
  /**
   * The body is synchronous, so vitest cannot interrupt it: its timeout only
   * compares wall-clock time after the body returns, which fails linear work on
   * a loaded machine. `0` disables that comparison; the per-size thread-CPU
   * bound and the growth ratio decide the outcome, and the per-size check stops
   * a super-linear regression at the first size over its bound.
   */
  const NO_WALL_CLOCK_TIMEOUT = 0;
  const shapes = [
    (size: number) => '1'.repeat(size),
    (size: number) => '<a'.repeat(Math.ceil(size / 2)).slice(0, size),
    (size: number) => `${'§1 x'.repeat(Math.ceil(size / 4)).slice(0, size)}\ny`,
    (size: number) => '  \r\n'.repeat(Math.ceil(size / 4)).slice(0, size),
  ];
  it.each(shapes.map((shape, index) => ({ shape, index })))(
    'bounds work across doubling input sizes, shape $index',
    ({ shape }) => {
      const timings: number[] = [];
      for (const size of SIZES) {
        const value = shape(size);
        inlineText(value);
        blockquote(value);
        const start = process.threadCpuUsage();
        for (let run = 0; run < 3; run++) {
          expect(inlineText(value).length).toBeGreaterThanOrEqual(value.length);
          expect(blockquote(value).length).toBeGreaterThan(0);
        }
        const cpu = process.threadCpuUsage(start);
        const micros = cpu.user + cpu.system;
        expect(micros).toBeLessThan(SIZE_CPU_BOUND_MICROS);
        timings.push(micros);
      }
      expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
    },
    NO_WALL_CLOCK_TIMEOUT,
  );
});

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
    expect(blockquote('line one\nline two')).toEqual(['> line one\\', '> line two']);
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
    expect(markdownText(lines[0]!)).toBe(
      'Photo: https://static.inaturalist.org/photos/1/medium.jpg',
    );
    expect(markdownNodes(lines[0]!).find((node) => node.type === 'link')?.destination).toBe(
      'https://static.inaturalist.org/photos/1/medium.jpg',
    );
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
    expect(markdownText(lines[0]!)).toBe(
      'Photo: https://static.inaturalist.org/photos/1/square.jpg',
    );
    expect(markdownNodes(lines[0]!).find((node) => node.type === 'link')?.destination).toBe(
      'https://static.inaturalist.org/photos/1/square.jpg',
    );
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

  it('renders the Photos sub-block whenever the expansion is present', () => {
    const withPhotos = renderObservation(
      projectedObservation({ photos: [projectedPhoto(), projectedPhoto({ open: true })] }),
    );
    expect(withPhotos).toContain('### Photos');

    const withoutPhotos = renderObservation(projectedObservation({ photos: [] }));
    expect(withoutPhotos).toContain('### Photos');
    expect(withoutPhotos).toContain('_none_');
    expect(renderObservation(projectedObservation())).not.toContain('### Photos');
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

  it('renders hidden: true or hidden: false in each entry’s flags whenever upstream sent the key', () => {
    const { hidden: _noIdentKey, ...unkeyedIdentification } = projectedIdentification({ id: 3 });
    const { hidden: _noCommentKey, ...unkeyedComment } = projectedComment({ id: 30 });
    const lines = renderObservation(
      projectedObservation({
        identifications: [
          projectedIdentification({ id: 1, hidden: true, body: 'Moderated text.' }),
          projectedIdentification({ id: 2, hidden: false }),
          unkeyedIdentification,
        ],
        identifications_total: 3,
        identifications_shown: 3,
        identifications_hidden: 1,
        comments: [
          projectedComment({ id: 10, hidden: true }),
          projectedComment({ id: 20, hidden: false }),
          unkeyedComment,
        ],
        comments_total: 3,
        comments_shown: 3,
        comments_hidden: 1,
      }),
    );
    const entry = (prefix: string, id: number) =>
      lines.find((line) => line.startsWith(prefix) && line.includes(` id ${id} `)) ?? '';
    expect(entry('- **identifier_one**', 1)).toContain('hidden: true');
    expect(entry('- **identifier_one**', 2)).toContain('hidden: false');
    expect(entry('- **identifier_one**', 3)).not.toContain('hidden');
    expect(entry('- **commenter_one**', 10)).toContain('hidden: true');
    expect(entry('- **commenter_one**', 20)).toContain('hidden: false');
    expect(entry('- **commenter_one**', 30)).not.toContain('hidden');
    // The hidden body is relayed unchanged, beneath its entry.
    expect(lines).toContain('> Moderated text.');
    expect(lines).toContain(
      '**identifications_hidden:** 1 — hidden entries across the whole thread, the same on every page',
    );
    expect(lines).toContain(
      '**comments_hidden:** 1 — hidden entries across all comments, the same on every page',
    );
  });

  it('renders a zero hidden count, and no count line when the record carries none', () => {
    const counted = renderObservation(
      projectedObservation({
        identifications: [],
        identifications_total: 0,
        identifications_shown: 0,
        identifications_hidden: 0,
      }),
    );
    expect(counted).toContain(
      '**identifications_hidden:** 0 — hidden entries across the whole thread, the same on every page',
    );
    const bare = renderObservation(
      projectedObservation({ identifications: [projectedIdentification()] }),
    ).join('\n');
    expect(bare).not.toContain('identifications_hidden');
  });

  it('blockquotes an identification body when present', () => {
    const lines = renderObservation(
      projectedObservation({ identifications: [projectedIdentification({ body: 'Note.' })] }),
    );
    expect(lines).toContain('> Note.');
  });

  it('renders the identification tally as a count against the community taxon, not the thread size', () => {
    const lines = renderObservation(
      projectedObservation({ identifications_count: 6, agreements: 6, disagreements: 0 }),
    );
    expect(lines.find((line) => line.startsWith('**Identifications'))).toBe(
      '**Identifications:** 6 agreeing or disagreeing with the community taxon (6 agree · 0 disagree) — upstream’s tally, not the thread size · community_taxon_id 48662',
    );
  });

  it('describes identifications_count as the agree-plus-disagree tally, pointing to identifications_total for the thread size', () => {
    const described = ObservationSchema.shape.identifications_count.description ?? '';
    expect(described).toContain('community taxon');
    expect(described).toContain('agreements + disagreements');
    expect(described).toContain('identifications_total');
    expect(described).not.toContain('thread holds');
  });

  it('keeps the thread headings bare when no thread counts are present (the search record)', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: [projectedIdentification()],
        comments: [projectedComment()],
      }),
    );
    expect(lines).toContain('### Identification thread');
    expect(lines).toContain('### Comments');
  });

  it('states shown against total at each thread heading when nothing was cut', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: [projectedIdentification()],
        identifications_total: 1,
        identifications_shown: 1,
        comments: [projectedComment()],
        comments_total: 1,
        comments_shown: 1,
      }),
    );
    expect(lines).toContain('### Identification thread — 1 of 1 shown');
    expect(lines).toContain('### Comments — 1 of 1 shown');
  });

  it('discloses a cut thread at its heading', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: Array.from({ length: 40 }, (_, i) => projectedIdentification({ id: i })),
        identifications_total: 1113,
        identifications_shown: 40,
        comments: Array.from({ length: 40 }, (_, i) => projectedComment({ id: i })),
        comments_total: 1377,
        comments_shown: 40,
      }),
    );
    expect(lines).toContain(
      '### Identification thread — 40 of 1113 shown: entries 1–40 by ascending id',
    );
    expect(lines).toContain('### Comments — 40 of 1377 shown: entries 1–40 by ascending id');
    expect(lines.filter((line) => line.startsWith('- **identifier_one**'))).toHaveLength(40);
  });

  it('names the kept range from the array offset, through the last page and past the end', () => {
    const page = (offset: number, shown: number) =>
      renderObservation(
        projectedObservation({
          identifications: Array.from({ length: shown }, (_, i) =>
            projectedIdentification({ id: offset + i }),
          ),
          identifications_total: 1139,
          identifications_shown: shown,
          observation_fields: [],
          observation_fields_total: 923,
          observation_fields_shown: 0,
        }),
        offset,
      );

    expect(page(40, 40)).toContain(
      '### Identification thread — 40 of 1139 shown: entries 41–80 by ascending id',
    );
    expect(page(1100, 39)).toContain(
      '### Identification thread — 39 of 1139 shown: entries 1101–1139 by ascending id',
    );
    expect(page(1100, 39)).toContain(
      '### Observation fields — 0 of 923 shown, array_offset 1100 is past the last entry',
    );
    expect(page(1500, 0)).toContain(
      '### Identification thread — 0 of 1139 shown, array_offset 1500 is past the last entry',
    );
    expect(page(1500, 0).join('\n')).not.toContain('upstream order');
  });

  it('still states the counts for an included thread that is empty', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: [],
        identifications_total: 0,
        identifications_shown: 0,
      }),
    );
    expect(lines).toContain('### Identification thread — 0 of 0 shown');
  });

  it("blockquotes the observer's description beneath its label", () => {
    const lines = renderObservation(
      projectedObservation({ description: 'caterpillar on narrow-leaf milkweed\nalong the road' }),
    );
    const at = lines.indexOf('**Observer’s description:**');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '> caterpillar on narrow-leaf milkweed\\',
      '> along the road',
    ]);
  });

  it('renders a present-null description explicitly', () => {
    const lines = renderObservation(projectedObservation({ description: null }));
    expect(lines).toContain('**Observer’s description:** no description');
  });

  it('renders filled observation fields as an inline bullet list with each datatype', () => {
    const lines = renderObservation(
      projectedObservation({
        observation_fields: [
          { name: 'Habitat_Description', value: 'Garden', datatype: 'text' },
          { name: null, value: '8', datatype: 'numeric' },
          { name: 'Legacy', value: 'kept', datatype: null },
        ],
      }),
    );
    const at = lines.indexOf('### Observation fields');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '- **Habitat_Description** (text): Garden',
      '- **unnamed field** (numeric): 8',
      '- **Legacy** (datatype not recorded): kept',
    ]);
  });

  it('names a resolved taxon-type value with the taxon line, and a free-text one bare', () => {
    const lines = renderObservation(
      projectedObservation({
        observation_fields: [
          {
            name: 'Host',
            value: '125625',
            datatype: 'taxon',
            taxon: taxonSummary({
              id: 125625,
              name: 'Miscanthus',
              rank: 'genus',
              common_name: 'Silvergrasses',
              iconic_taxon_name: 'Plantae',
            }),
          },
          { name: 'Species', value: 'Ondatra zibethicus', datatype: 'taxon' },
        ],
      }),
    );
    expect(lines).toContain(
      '- **Host** (taxon): 125625 — Silvergrasses (Miscanthus) · taxon_id 125625 · genus · Plantae',
    );
    expect(lines).toContain('- **Species** (taxon): Ondatra zibethicus');
  });

  it('renders an empty Observation fields block when none are filled', () => {
    const lines = renderObservation(projectedObservation({ observation_fields: [] }));
    expect(lines).toContain('### Observation fields');
    expect(lines).toContain('_none_');
  });

  it('renders the Comments sub-block, blockquoting each body', () => {
    const lines = renderObservation(
      projectedObservation({ comments: [projectedComment({ body: 'Nice shot!' })] }),
    );
    expect(lines).toContain('### Comments');
    expect(lines).toContain('> Nice shot!');
  });
});

/**
 * Upstream free text is member-authored, and a line break inside it escapes the
 * line it was rendered into — a blockquote stops quoting, and an inline slot
 * emits a forged heading. Every line of a rendered block must stay a line this
 * renderer chose to emit.
 */
describe('line breaks in upstream text cannot forge markdown structure', () => {
  const FORGERY = '## Forged heading';

  /**
   * The rendered surface is the joined text, not the line array — a break
   * smuggled inside one array element only becomes a line once `format()`
   * joins. Split the way a CommonMark reader does (CRLF, bare CR, and LF are
   * all line endings) and report any line that opens with the forgery.
   */
  const forgedLines = (lines: readonly string[]): string[] =>
    lines
      .join('\n')
      .split(/\r\n|[\r\n]/)
      .filter((line) => line.startsWith(FORGERY));

  it('quotes every physical line, including CRLF and bare CR separators', () => {
    const lines = blockquote('one\r\ntwo\rthree\nfour');
    expect(lines.every((line) => line.startsWith('> '))).toBe(true);
    expect(markdownText(lines.join('\n'))).toBe('one\r\ntwo\rthree\nfour');
  });

  it('leaves no unquoted line when a bare CR splits an attribution', () => {
    const lines = renderPhoto(projectedPhoto({ attribution: `(c) Someone\r${FORGERY}` }), 'Photo');
    expect(forgedLines(lines)).toEqual([]);
  });

  it('leaves no unquoted line when a newline splits an identification body', () => {
    const lines = renderObservation(
      projectedObservation({
        identifications: [projectedIdentification({ body: `Looks right.\n${FORGERY}` })],
      }),
    );
    expect(markdownText(lines.join('\n'))).toContain(`Looks right.\n${FORGERY}`);
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let a common name break out of the record heading', () => {
    const lines = renderObservation(
      projectedObservation({ taxon: taxonSummary({ common_name: `Monarch\n${FORGERY}` }) }),
    );
    expect(forgedLines(lines)).toEqual([]);
    expect(
      lines
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('## ')),
    ).toHaveLength(1);
  });

  it('does not let a locality string break out of its blockquote', () => {
    const lines = renderObservation(
      projectedObservation({ place_guess: `Seattle, WA\n${FORGERY}` }),
    );
    expect(markdownText(lines.join('\n'))).toContain(`Seattle, WA\n${FORGERY}`);
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let an observer login break out of its line', () => {
    const lines = renderObservation(projectedObservation({ observer: `someone\n${FORGERY}` }));
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let a photo URL break out of its line', () => {
    const lines = renderPhoto(
      projectedPhoto({ medium_url: `https://example.test/a.jpg\n${FORGERY}` }),
      'Photo',
    );
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let an observation-field name, datatype, or value break out of its bullet', () => {
    const lines = renderObservation(
      projectedObservation({
        observation_fields: [
          {
            name: `Habitat\n${FORGERY}`,
            value: `Garden\r${FORGERY}`,
            datatype: `text\n${FORGERY}`,
          },
        ],
      }),
    );
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let an outlink source or url break out of the Outlinks line', () => {
    const outlinks = [
      { source: `GBIF\n${FORGERY}`, url: 'http://www.gbif.org/occurrence/1' },
      { source: 'GloBI', url: `http://example.test/\r${FORGERY}` },
    ];
    const lines = renderObservation(projectedObservation({ outlinks }));
    expect(forgedLines(lines)).toEqual([]);
    const line = lines.find((entry) => entry.startsWith('**Outlinks:**')) ?? '';
    expect(line.split(/\r\n|[\r\n]/)).toHaveLength(1);
    expect(markdownText(line)).toContain(`GBIF\n${FORGERY}`);
    expect(markdownText(line)).toContain(`http://example.test/\r${FORGERY}`);
  });

  it('keeps a description quoted across a bare CR', () => {
    const lines = renderObservation(projectedObservation({ description: `A note.\r${FORGERY}` }));
    expect(markdownText(lines.join('\n'))).toContain(`A note.\r${FORGERY}`);
    expect(forgedLines(lines)).toEqual([]);
  });

  it('does not let a comment body or its author break out', () => {
    const lines = renderObservation(
      projectedObservation({
        comments: [projectedComment({ by: `someone\n${FORGERY}`, body: `Hi\n${FORGERY}` })],
      }),
    );
    expect(forgedLines(lines)).toEqual([]);
  });

  it('leaves single-line text byte-identical', () => {
    const lines = renderObservation(projectedObservation());
    expect(lines.join('\n')).toContain('> Seattle, WA');
    expect(lines.join('\n')).toContain('## Monarch (Danaus plexippus)');
  });
});
