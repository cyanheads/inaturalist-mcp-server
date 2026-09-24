/**
 * @fileoverview The projected observation record — the output schema fragment
 * and the markdown block — shared by the search and by-id observation tools so
 * the two surfaces cannot drift apart.
 *
 * Everything an observation carries from a third party — `place_guess`, photo
 * attributions, identification and comment bodies — renders inside a blockquote,
 * so a reading model sees it as quoted content rather than instruction. Upstream
 * text rendered inline instead of quoted — names, logins, URLs, timestamps —
 * goes through {@link inlineText} so it cannot end the line it was placed in.
 *
 * @module mcp-server/tools/observation-record
 */

import { z } from '@cyanheads/mcp-ts-core';
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
        'Medium variant. Supplied by upstream where it publishes every size, otherwise derived by substituting the size qualifier in the path. Absent when the path did not match the documented shape.',
      ),
    attribution: z
      .string()
      .nullable()
      .describe(
        'Attribution string, verbatim and never reformatted. Reproduce it with any use of the image.',
      ),
    license_code: z
      .string()
      .nullable()
      .describe('Photo licence code. Null means all rights reserved, independent of the record.'),
    open: z
      .boolean()
      .describe(
        'True when the photo is served from the host the upstream reserves for open licences. A photo can move hosts when its licence changes, so this reflects fetch time.',
      ),
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
      .describe(
        'Decoded attribute label, e.g. "Life Stage". Null when the id is not in the vocabulary.',
      ),
    value: z
      .string()
      .nullable()
      .describe('Decoded value label, e.g. "Larva". Null when the id is not in the vocabulary.'),
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
    name: z
      .string()
      .nullable()
      .describe('Field name, as its creator wrote it, e.g. "Habitat_Description".'),
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
      'Public positional accuracy radius in metres. On an obscured record this is tens of kilometres and the point is a locality, not a sighting position.',
    ),
});

/**
 * The projected observation. The expansion arms and the two by-id fields are
 * presence-based, so one schema serves both tools and `format()` renders each
 * arm on presence rather than by branching.
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
      .describe(
        'True when the true coordinate is withheld, typically for a threatened taxon. The point is never resolved or approximated.',
      ),
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
    photo_count: z
      .number()
      .describe('How many photos the record carries, so include "photos" can be spent knowingly.'),
    sound_count: z.number().describe('How many audio recordings the record carries.'),
    observer: z
      .string()
      .nullable()
      .describe('Login of the observer. The rest of the upstream profile is not relayed.'),
    identifications_count: z
      .number()
      .describe(
        'Upstream’s tally of identifications currently agreeing or disagreeing with the community taxon — agreements + disagreements. Not the thread size: it leaves out the observer’s own identification and any that neither agrees nor disagrees, such as a coarser or withdrawn one. The thread size is identifications_total, on inaturalist_get_observation.',
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
        'The identification thread, cut to its first entries in upstream order (roughly but not strictly chronological) when it exceeds the per-record share of a 40-entry budget. Present when "identifications" was included.',
      ),
    identifications_total: z
      .number()
      .optional()
      .describe(
        'How many identifications upstream holds on the record — the thread size. Present when "identifications" was included.',
      ),
    identifications_shown: z
      .number()
      .optional()
      .describe(
        'How many of them identifications carries. Below identifications_total when the thread was cut. Present when "identifications" was included.',
      ),
    comments: z
      .array(CommentSchema)
      .optional()
      .describe(
        'Discussion comments, cut to their first entries in upstream order (not strictly chronological) when they exceed the per-record share of a 40-entry budget. Present when "comments" was included.',
      ),
    comments_total: z
      .number()
      .optional()
      .describe(
        'How many comments upstream holds on the record. Present when "comments" was included.',
      ),
    comments_shown: z
      .number()
      .optional()
      .describe(
        'How many of them comments carries. Below comments_total when the thread was cut. Present when "comments" was included.',
      ),
    community_taxon: TaxonSummarySchema.nullable()
      .optional()
      .describe(
        'Consensus taxon, resolved. Present on the by-id tool; null when the thread has reached none.',
      ),
    identification_disagreements_count: z
      .number()
      .optional()
      .describe(
        'Count of disagreeing identifications as upstream tallies it. Present on the by-id tool.',
      ),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The observer’s own note on the sighting — host plant, behaviour, habitat, count. Third-party free text. Present on the by-id tool; null when the observer wrote none.',
      ),
    observation_fields: z
      .array(ObservationFieldSchema)
      .optional()
      .describe(
        'Observation-field values filled in on the record, usually by a project; fields left blank are dropped. Cut to the first filled fields in upstream order when they exceed the per-record share of a 40-entry budget. Present on the by-id tool.',
      ),
    observation_fields_total: z
      .number()
      .optional()
      .describe(
        'How many filled observation fields the record carries. Present on the by-id tool.',
      ),
    observation_fields_shown: z
      .number()
      .optional()
      .describe(
        'How many of them observation_fields carries. Below observation_fields_total when the list was cut. Present on the by-id tool.',
      ),
  })
  .describe('One projected observation record.');

export type ObservationOutput = z.infer<typeof ObservationSchema>;
type TaxonSummaryOutput = z.infer<typeof TaxonSummarySchema>;
type PhotoOutput = z.infer<typeof PhotoSchema>;

/**
 * Every separator a markdown reader treats as a line ending. CommonMark ends a
 * line on a bare carriage return as well as on a newline, so splitting on the
 * newline alone leaves the tail of a CR-separated string outside the structure
 * it was rendered into.
 */
const LINE_BREAK = /\r\n|[\n\r]/g;

/**
 * Flattens an upstream string so it cannot escape the line it is rendered into.
 *
 * Inline slots interpolate third-party text — member-created place and project
 * names, community-editable common names, logins, authority status text, media
 * URLs — into a single rendered line. A line break inside one of those values
 * ends that line early and lets the remainder read as markdown structure this
 * server never emitted, which is the injection the blockquote rule prevents for
 * the free-text fields. `structuredContent` keeps every value verbatim; only the
 * rendered twin is flattened.
 */
export function inlineText(text: string): string {
  return text.replace(LINE_BREAK, ' ');
}

/** A null licence is a fact about the record, so it renders in words rather than as a blank. */
export function licenceLabel(code: string | null): string {
  return inlineText(code ?? 'All rights reserved');
}

/** Quotes third-party text so a reading model treats it as content, not instruction. */
export function blockquote(text: string): string[] {
  return text.split(LINE_BREAK).map((line) => `> ${line}`);
}

function taxonLine(taxon: TaxonSummaryOutput): string {
  const common = inlineText(taxon.common_name ?? 'no common name');
  const scientific = inlineText(taxon.name ?? 'name not recorded');
  const rank = inlineText(taxon.rank ?? 'rank not recorded');
  const iconic = inlineText(taxon.iconic_taxon_name ?? 'no iconic group');
  return `${common} (${scientific}) · taxon_id ${taxon.id} · ${rank} · ${iconic}`;
}

export function renderPhoto(photo: PhotoOutput, label: string): string[] {
  const link = inlineText(photo.medium_url ?? photo.square_url ?? 'no image URL published');
  const lines = [
    `**${label}:** ${link}`,
    `square_url ${inlineText(photo.square_url ?? 'not published')} · ${licenceLabel(photo.license_code)} · ${photo.open ? 'open licence' : 'licence not open'}`,
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
  if (shown === undefined || total === undefined) return `### ${label}`;
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
    `**id** ${observation.id} · **uuid** ${inlineText(observation.uuid ?? 'not published')} · ${inlineText(observation.url ?? 'no page URL published')}`,
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

  if (observation.description) {
    lines.push('**Observer’s description:**');
    lines.push(...blockquote(observation.description));
  }

  if (observation.photos?.length) {
    lines.push('### Photos');
    for (const [index, photo] of observation.photos.entries()) {
      lines.push(...renderPhoto(photo, `Photo ${index + 1}`));
    }
  }

  if (observation.annotations?.length) {
    lines.push('### Annotations');
    for (const annotation of observation.annotations) {
      lines.push(
        `- **${inlineText(annotation.attribute ?? 'undecoded attribute')}** = ${inlineText(annotation.value ?? 'undecoded value')} (term_id ${annotation.attribute_id}, term_value_id ${annotation.value_id}) — by ${inlineText(annotation.by ?? 'unknown')}`,
      );
    }
  }

  // Unlike an opted-in thread arm, the fields ride every by-id record, so a record
  // with none renders no block — its zero counts stay in structuredContent.
  if (observation.observation_fields?.length) {
    lines.push(
      cappedHeading(
        'Observation fields',
        observation.observation_fields_shown,
        observation.observation_fields_total,
      ),
    );
    for (const field of observation.observation_fields) {
      lines.push(`- **${inlineText(field.name ?? 'unnamed field')}:** ${inlineText(field.value)}`);
    }
  }

  if (observation.sounds?.length) {
    lines.push('### Sounds');
    for (const sound of observation.sounds) {
      lines.push(
        `- ${inlineText(sound.url ?? 'no audio URL published')} — ${licenceLabel(sound.license_code)}`,
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
