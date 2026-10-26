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
  it('exports a schema omitting exactly the twelve unreachable detail fields', async () => {
    const detailFields = [
      'identifications',
      'identifications_total',
      'identifications_shown',
      'comments',
      'comments_total',
      'comments_shown',
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
          observation_fields: [{ name: value, value }],
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
      for (let size = 5_000; size <= 320_000; size *= 2) {
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
        expect(micros).toBeLessThan(2_000_000);
        timings.push(micros);
      }
      expect(timings.at(-1)! / timings[0]!).toBeLessThan(256);
    },
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
      '### Identification thread — first 40 of 1113 shown, in upstream order',
    );
    expect(lines).toContain('### Comments — first 40 of 1377 shown, in upstream order');
    expect(lines.filter((line) => line.startsWith('- **identifier_one**'))).toHaveLength(40);
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

  it('renders filled observation fields as an inline bullet list', () => {
    const lines = renderObservation(
      projectedObservation({
        observation_fields: [
          { name: 'Habitat_Description', value: 'Garden' },
          { name: null, value: '8' },
        ],
      }),
    );
    const at = lines.indexOf('### Observation fields');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '- **Habitat_Description:** Garden',
      '- **unnamed field:** 8',
    ]);
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

  it('does not let an observation-field name or value break out of its bullet', () => {
    const lines = renderObservation(
      projectedObservation({
        observation_fields: [{ name: `Habitat\n${FORGERY}`, value: `Garden\r${FORGERY}` }],
      }),
    );
    expect(forgedLines(lines)).toEqual([]);
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
