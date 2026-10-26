/**
 * @fileoverview The projected observation record — the output schema fragment
 * and the markdown block — shared by the search and by-id observation tools so
 * the two surfaces cannot drift apart.
 *
 * Everything an observation carries from a third party — `place_guess`, photo
 * attributions, identification and comment bodies — renders inside a blockquote,
 * so a reading model sees it as quoted content rather than instruction. Upstream
 * text rendered inline instead of quoted goes through {@link inlineText}; URLs
 * use {@link urlText}. Neither can end the physical line it was placed in.
 *
 * @module mcp-server/tools/observation-record
 */

import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { QUALITY_GRADES } from '@/services/inaturalist/vocabularies.js';

/** Heading stand-in for an observation nobody has identified yet. */
const UNIDENTIFIED = 'Unidentified';

/** Heading stand-in for a taxon whose name and common name are both absent. */
const UNNAMED_TAXON = '*(taxon name not recorded)*';

export const PhotoSchema = z
  .object({
    square_url: z
      .string()
      .nullable()
      .describe('75px square variant, exactly as upstream published it. Null when absent.'),
    medium_url: z
      .string()
      .optional()
      .describe(
        'Medium image URL; derived from the size path if needed. Absent when no variant is available.',
      ),
    attribution: z
      .string()
      .nullable()
      .describe('Verbatim attribution; reproduce with any use of the image.'),
    license_code: z
      .string()
      .nullable()
      .describe('Photo licence code. Null means all rights reserved, independent of the record.'),
    open: z
      .boolean()
      .describe('True when served from the open-licence host at fetch time; licences can change.'),
  })
  .describe('A photo with the attribution and licence that must travel with it.');

export const SoundSchema = z
  .object({
    url: z.string().nullable().describe('Audio file URL. Null when upstream published none.'),
    attribution: z.string().nullable().describe('Attribution string, verbatim.'),
    license_code: z
      .string()
      .nullable()
      .describe('Sound licence code. Null means all rights reserved.'),
  })
  .describe('An audio recording with its attribution and licence.');

export const AnnotationSchema = z
  .object({
    attribute: z
      .string()
      .nullable()
      .describe('Attribute label, e.g. "Life Stage"; null for an unknown id.'),
    value: z.string().nullable().describe('Value label, e.g. "Larva"; null for an unknown id.'),
    attribute_id: z.number().describe('Attribute id, usable as term_id on the search tools.'),
    value_id: z.number().describe('Value id, usable as term_value_id on the search tools.'),
    by: z.string().nullable().describe('Login of the member who added the annotation.'),
  })
  .describe('One decoded annotation on the record.');

export const TaxonSummarySchema = z.object({
  id: z.number().describe('Taxon id — the identifier every taxon-scoped filter takes.'),
  name: z.string().nullable().describe('Scientific name.'),
  rank: z.string().nullable().describe('Taxonomic rank, e.g. "species".'),
  common_name: z.string().nullable().describe('Preferred common name, when one is recorded.'),
  iconic_taxon_name: z
    .string()
    .nullable()
    .describe('Broad organism group, e.g. "Insecta". Usable as an iconic_taxa filter value.'),
});

export const IdentificationSchema = z
  .object({
    id: z.number().describe('Identification id.'),
    taxon: TaxonSummarySchema.nullable().describe('Taxon this identification proposes.'),
    by: z.string().nullable().describe('Login of the identifier.'),
    current: z
      .boolean()
      .describe('True when this is the identifier’s current identification on the record.'),
    category: z
      .string()
      .nullable()
      .describe(
        'How this identification moved the thread: improving, supporting, leading, or maverick.',
      ),
    disagreement: z
      .boolean()
      .nullable()
      .describe('True when the identifier explicitly disagreed with the preceding taxon.'),
    from_vision: z
      .boolean()
      .describe('True when the identification came from the upstream image classifier.'),
    body: z.string().nullable().describe('Free-text note written by the identifier.'),
    created_at: z.string().nullable().describe('When the identification was added, ISO 8601.'),
  })
  .describe('One identification in the community thread.');

export const CommentSchema = z
  .object({
    id: z.number().describe('Comment id.'),
    by: z.string().nullable().describe('Login of the commenter.'),
    body: z.string().nullable().describe('Free-text comment body.'),
    created_at: z.string().nullable().describe('When the comment was posted, ISO 8601.'),
  })
  .describe('One discussion comment on the record.');

export const ObservationFieldSchema = z
  .object({
    name: z.string().nullable().describe('Verbatim field name, e.g. "Habitat_Description".'),
    value: z.string().describe('The value filled in, verbatim.'),
  })
  .describe('One filled observation field.');

export const CoordinateSchema = z.object({
  lat: z.number().describe('Latitude in decimal degrees.'),
  lng: z.number().describe('Longitude in decimal degrees.'),
  accuracy_m: z
    .number()
    .nullable()
    .describe(
      'Public accuracy radius, metres. An obscured point is a locality, not a sighting position.',
    ),
});

/**
 * The full projected observation. Search derives its reachable fields from this
 * definition; detail tools and JSON resources retain every presence-based arm.
 */
export const ObservationSchema = z
  .object({
    id: z.number().describe('Observation id. Also the cursor value for deep pagination.'),
    uuid: z.string().nullable().describe('Stable UUID, independent of the id sequence.'),
    url: z.string().nullable().describe('Canonical iNaturalist page for the record.'),
    observed_on: z
      .string()
      .nullable()
      .describe('Observation date, YYYY-MM-DD. Null when the observer recorded no date.'),
    observed_at: z.string().nullable().describe('Observation timestamp with offset, ISO 8601.'),
    taxon: TaxonSummarySchema.nullable().describe(
      'Current identification. Null when nobody has identified the record.',
    ),
    place_guess: z
      .string()
      .nullable()
      .describe('Locality text written by the observer. Third-party free text.'),
    coordinate: CoordinateSchema.nullable().describe(
      'Public coordinate. Null when the record carries none.',
    ),
    obscured: z
      .boolean()
      .describe('True when the true coordinate is withheld; the public point is a locality.'),
    geoprivacy: z
      .string()
      .nullable()
      .describe('Observer-set coordinate privacy: obscured, obscured_private, open, or private.'),
    taxon_geoprivacy: z
      .string()
      .nullable()
      .describe(
        'Coordinate privacy applied automatically for a threatened taxon. Same vocabulary.',
      ),
    quality_grade: z
      .enum(QUALITY_GRADES)
      .describe('Identification confidence tier: research, needs_id, or casual.'),
    license_code: z
      .string()
      .nullable()
      .describe('Licence of the observation record itself. Null means all rights reserved.'),
    captive: z
      .boolean()
      .describe('True for a zoo animal, a garden planting, or other cultivation.'),
    photo: PhotoSchema.nullable().describe('First photo on the record. Null when there are none.'),
    photo_count: z.number().describe('Photo count; include "photos" for every photo.'),
    sound_count: z.number().describe('How many audio recordings the record carries.'),
    observer: z.string().nullable().describe('Observer login.'),
    identifications_count: z
      .number()
      .describe(
        'Tally against the community taxon: agreements + disagreements. Excludes the observer and neutral/withdrawn ids; thread size is identifications_total on inaturalist_get_observation.',
      ),
    agreements: z
      .number()
      .describe('How many identifications currently agree with the community taxon.'),
    disagreements: z
      .number()
      .describe('How many identifications currently disagree with the community taxon.'),
    community_taxon_id: z
      .number()
      .nullable()
      .describe('Consensus taxon id. Differs from taxon.id while a thread is contested.'),
    photos: z
      .array(PhotoSchema)
      .optional()
      .describe('Every photo on the record. Present when "photos" was included.'),
    annotations: z
      .array(AnnotationSchema)
      .optional()
      .describe('Decoded annotations. Present when "annotations" was included.'),
    sounds: z
      .array(SoundSchema)
      .optional()
      .describe('Audio recordings. Present when "sounds" was included.'),
    identifications: z
      .array(IdentificationSchema)
      .optional()
      .describe(
        'Requested identification thread, first entries in upstream order (not strictly chronological), sharing a 40-entry budget across records.',
      ),
    identifications_total: z
      .number()
      .optional()
      .describe('Thread size before the cap; present with "identifications".'),
    identifications_shown: z
      .number()
      .optional()
      .describe('Identification entries returned; below identifications_total when capped.'),
    comments: z
      .array(CommentSchema)
      .optional()
      .describe(
        'Requested comments, first entries in upstream order (not strictly chronological), sharing a 40-entry budget across records.',
      ),
    comments_total: z
      .number()
      .optional()
      .describe('Comment count before the cap; present with "comments".'),
    comments_shown: z
      .number()
      .optional()
      .describe('Comment entries returned; below comments_total when capped.'),
    community_taxon: TaxonSummarySchema.nullable()
      .optional()
      .describe('Resolved consensus taxon on detail records; null without consensus.'),
    identification_disagreements_count: z
      .number()
      .optional()
      .describe('Upstream disagreement count on detail records.'),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Verbatim observer note on detail records; null when none was written, distinct from an empty string.',
      ),
    observation_fields: z
      .array(ObservationFieldSchema)
      .optional()
      .describe(
        'Filled fields on detail records, verbatim; blanks omitted. First entries in upstream order, sharing a 40-entry budget across records.',
      ),
    observation_fields_total: z
      .number()
      .optional()
      .describe('Filled field count before the cap on detail records.'),
    observation_fields_shown: z
      .number()
      .optional()
      .describe('Filled fields returned; below observation_fields_total when capped.'),
  })
  .describe('One projected observation record.');

/** Search emits the shared record and media expansions, without detail/thread arms. */
export const SearchObservationSchema = ObservationSchema.omit({
  identifications: true,
  identifications_total: true,
  identifications_shown: true,
  comments: true,
  comments_total: true,
  comments_shown: true,
  community_taxon: true,
  identification_disagreements_count: true,
  description: true,
  observation_fields: true,
  observation_fields_total: true,
  observation_fields_shown: true,
}).describe('One complete projected search record, with requested media expansions.');

export type ObservationOutput = z.infer<typeof ObservationSchema>;
type TaxonSummaryOutput = z.infer<typeof TaxonSummarySchema>;
type PhotoOutput = z.infer<typeof PhotoSchema>;

/**
 * Encodes literal text for a single physical Markdown line, retaining CR/LF as
 * character references, including vertical tabs that a blank quoted line loses.
 * NUL-containing values use a labeled JSON string literal because CommonMark
 * cannot represent NUL directly. Do not wrap this in a code span.
 */
export function inlineText(text: string): string {
  const literal = text.includes('\u0000') ? `JSON string literal: ${JSON.stringify(text)}` : text;
  return literal
    .split(/([\r\n])/)
    .map((segment) =>
      segment === '\r'
        ? '&#13;'
        : segment === '\n'
          ? '&#10;'
          : escapeMarkdownInline(segment).replaceAll('\u000b', '&#11;'),
    )
    .join('');
}

/** Link a URL without normalizing its value; non-linkable values remain literal text. */
export function urlText(url: string): string {
  return url.includes('\r') || url.includes('\n') || url.includes('\u0000')
    ? inlineText(url)
    : markdownLink(url, url);
}

/** A null licence is a fact about the record, so it renders in words rather than as a blank. */
export function licenceLabel(code: string | null): string {
  return inlineText(code ?? 'All rights reserved');
}

/** Quotes third-party text so a reading model treats it as content, not instruction. */
export function blockquote(text: string): string[] {
  const encoded = text.includes('\u0000')
    ? inlineText(text)
    : text
        .split('\r')
        .map((segment) => escapeMarkdownInline(segment).replaceAll('\u000b', '&#11;'))
        .join('&#13;');
  return encoded.split('\n').map((line) => `> ${line}`);
}

function taxonLine(taxon: TaxonSummaryOutput): string {
  const common = inlineText(taxon.common_name ?? 'no common name');
  const scientific = inlineText(taxon.name ?? 'name not recorded');
  const rank = inlineText(taxon.rank ?? 'rank not recorded');
  const iconic = inlineText(taxon.iconic_taxon_name ?? 'no iconic group');
  return `${common} (${scientific}) · taxon_id ${taxon.id} · ${rank} · ${iconic}`;
}

export function renderPhoto(photo: PhotoOutput, label: string): string[] {
  const url = photo.medium_url ?? photo.square_url;
  const link = url === null ? 'no image URL published' : urlText(url);
  const lines = [
    `**${label}:** ${link}`,
    `square_url ${photo.square_url === null ? 'not published' : urlText(photo.square_url)} · ${licenceLabel(photo.license_code)} · ${photo.open ? 'open licence' : 'licence not open'}`,
  ];
  if (photo.attribution) lines.push(...blockquote(photo.attribution));
  else lines.push('_No attribution string published._');
  return lines;
}

/**
 * The heading of a capped array's block. The by-id tool reports how many entries
 * it kept against the array's upstream size; a search record carries neither
 * count and keeps the bare heading.
 */
function cappedHeading(
  label: string,
  shown: number | undefined,
  total: number | undefined,
): string {
  if (shown === undefined && total === undefined) return `### ${label}`;
  if (shown === undefined) return `### ${label} — ${total} total`;
  if (total === undefined) return `### ${label} — ${shown} shown`;
  return shown < total
    ? `### ${label} — first ${shown} of ${total} shown, in upstream order`
    : `### ${label} — ${shown} of ${total} shown`;
}

function observationHeading(observation: ObservationOutput): string {
  const taxon = observation.taxon;
  if (!taxon) return UNIDENTIFIED;
  if (taxon.common_name && taxon.name) {
    return `${inlineText(taxon.common_name)} (${inlineText(taxon.name)})`;
  }
  const single = taxon.common_name ?? taxon.name;
  return single === null ? UNNAMED_TAXON : inlineText(single);
}

/**
 * The per-observation markdown block. Every terminal field of
 * {@link ObservationSchema} is rendered here, including the presence-based
 * expansion arms, so both tools satisfy format parity from one place.
 */
export function renderObservation(observation: ObservationOutput): string[] {
  const lines: string[] = [`## ${observationHeading(observation)}`];

  lines.push(
    `**id** ${observation.id} · **uuid** ${inlineText(observation.uuid ?? 'not published')} · ${observation.url === null ? 'no page URL published' : urlText(observation.url)}`,
  );
  if (observation.taxon) lines.push(`**Identified as:** ${taxonLine(observation.taxon)}`);
  lines.push(
    `**Observed:** ${inlineText(observation.observed_on ?? 'date not recorded')} · ${inlineText(observation.observed_at ?? 'no timestamp recorded')}`,
  );

  const coordinate = observation.coordinate;
  if (coordinate) {
    const accuracy =
      coordinate.accuracy_m === null ? 'accuracy not recorded' : `±${coordinate.accuracy_m} m`;
    lines.push(
      observation.obscured
        ? `**Location:** obscured locality — accurate to ${accuracy} (obscured: true). Centre ${coordinate.lat}, ${coordinate.lng} is a locality, not a sighting position.`
        : `**Location:** ${coordinate.lat}, ${coordinate.lng} (${accuracy}) · obscured: false`,
    );
  } else {
    lines.push(`**Location:** no public coordinate · obscured: ${observation.obscured}`);
  }
  if (observation.place_guess) {
    lines.push('**Observer’s locality text:**');
    lines.push(...blockquote(observation.place_guess));
  }

  lines.push(
    `**Status:** ${observation.quality_grade} · captive: ${observation.captive} · geoprivacy ${inlineText(observation.geoprivacy ?? 'not set')} · taxon_geoprivacy ${inlineText(observation.taxon_geoprivacy ?? 'not set')} · ${licenceLabel(observation.license_code)}`,
  );
  lines.push(
    `**Identifications:** ${observation.identifications_count} agreeing or disagreeing with the community taxon (${observation.agreements} agree · ${observation.disagreements} disagree) — upstream’s tally, not the thread size · community_taxon_id ${observation.community_taxon_id ?? 'none yet'}`,
  );
  lines.push(
    `**Observer:** ${inlineText(observation.observer ?? 'login not published')} · ${observation.photo_count} photos · ${observation.sound_count} sounds`,
  );

  if (observation.photo) lines.push(...renderPhoto(observation.photo, 'Photo'));

  if (
    observation.community_taxon !== undefined ||
    observation.identification_disagreements_count !== undefined
  ) {
    const consensus = observation.community_taxon
      ? taxonLine(observation.community_taxon)
      : 'no consensus taxon yet';
    lines.push(
      `**Community consensus:** ${consensus} · ${observation.identification_disagreements_count ?? 0} disagreements`,
    );
  }

  if (observation.description !== undefined) {
    if (observation.description === null) lines.push('**Observer’s description:** no description');
    else if (observation.description === '') lines.push('**Observer’s description:** empty string');
    else {
      lines.push('**Observer’s description:**');
      lines.push(...blockquote(observation.description));
    }
  }

  if (observation.photos !== undefined) {
    lines.push('### Photos');
    if (observation.photos.length === 0) lines.push('_none_');
    for (const [index, photo] of observation.photos.entries()) {
      lines.push(...renderPhoto(photo, `Photo ${index + 1}`));
    }
  }

  if (observation.annotations !== undefined) {
    lines.push('### Annotations');
    if (observation.annotations.length === 0) lines.push('_none_');
    for (const annotation of observation.annotations) {
      lines.push(
        `- **${inlineText(annotation.attribute ?? 'undecoded attribute')}** = ${inlineText(annotation.value ?? 'undecoded value')} (term_id ${annotation.attribute_id}, term_value_id ${annotation.value_id}) — by ${inlineText(annotation.by ?? 'unknown')}`,
      );
    }
  }

  if (
    observation.observation_fields !== undefined ||
    observation.observation_fields_shown !== undefined ||
    observation.observation_fields_total !== undefined
  ) {
    lines.push(
      cappedHeading(
        'Observation fields',
        observation.observation_fields_shown,
        observation.observation_fields_total,
      ),
    );
    if (observation.observation_fields?.length === 0) lines.push('_none_');
    for (const field of observation.observation_fields ?? []) {
      lines.push(`- **${inlineText(field.name ?? 'unnamed field')}:** ${inlineText(field.value)}`);
    }
  }

  if (observation.sounds !== undefined) {
    lines.push('### Sounds');
    if (observation.sounds.length === 0) lines.push('_none_');
    for (const sound of observation.sounds) {
      lines.push(
        `- ${sound.url === null ? 'no audio URL published' : urlText(sound.url)} — ${licenceLabel(sound.license_code)}`,
      );
      if (sound.attribution) lines.push(...blockquote(sound.attribution));
    }
  }

  const { identifications, comments } = observation;
  if (
    identifications &&
    (identifications.length > 0 || observation.identifications_total !== undefined)
  ) {
    lines.push(
      cappedHeading(
        'Identification thread',
        observation.identifications_shown,
        observation.identifications_total,
      ),
    );
    for (const identification of identifications) {
      const taxon = identification.taxon
        ? taxonLine(identification.taxon)
        : 'no taxon on this identification';
      const flags = [
        inlineText(identification.category ?? 'category not recorded'),
        `disagreement: ${identification.disagreement ?? 'not recorded'}`,
        `from image classifier: ${identification.from_vision}`,
        `current: ${identification.current}`,
        `id ${identification.id}`,
        inlineText(identification.created_at ?? 'no timestamp'),
      ];
      lines.push(
        `- **${inlineText(identification.by ?? 'unknown identifier')}** → ${taxon} — ${flags.join(' · ')}`,
      );
      if (identification.body) lines.push(...blockquote(identification.body));
    }
  }

  if (comments && (comments.length > 0 || observation.comments_total !== undefined)) {
    lines.push(cappedHeading('Comments', observation.comments_shown, observation.comments_total));
    for (const comment of comments) {
      lines.push(
        `- **${inlineText(comment.by ?? 'unknown')}** · id ${comment.id} · ${inlineText(comment.created_at ?? 'no timestamp')}`,
      );
      if (comment.body) lines.push(...blockquote(comment.body));
    }
  }

  return lines;
}
