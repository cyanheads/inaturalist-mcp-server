/**
 * @fileoverview The projected taxon profile — its output schema, its section
 * vocabulary, and its markdown block — shared by `inaturalist_get_taxon` and the
 * `inaturalist://taxa/{taxon_id}` resource so the two surfaces cannot drift apart.
 *
 * The document is the one fat record on this surface, so its sections are named
 * here once: the flat scalars are measured as a single `summary` group for
 * overflow accounting, and the five keys below them are what an agent can ask
 * for by name after an outline.
 *
 * @module mcp-server/tools/taxon-document
 */

import { z } from '@cyanheads/mcp-ts-core';
import { blockquote, PhotoSchema, renderPhoto } from '@/mcp-server/tools/observation-record.js';

/** Heading stand-in for a taxon whose name and common name are both absent. */
const UNNAMED_TAXON = '*(taxon name not recorded)*';

export const TaxonPhotoSchema = PhotoSchema.extend({
  large_url: z
    .string()
    .optional()
    .describe(
      'Large variant, as the taxon endpoint publishes it. Absent when upstream carried none; never derived here.',
    ),
}).describe('A taxon gallery photo with the attribution and licence that must travel with it.');

export const TaxonLineageSchema = z
  .object({
    id: z.number().describe('Taxon id of this ancestor — usable as taxon_id on any tool.'),
    name: z.string().nullable().describe('Scientific name.'),
    rank: z.string().nullable().describe('Taxonomic rank, e.g. "family".'),
    common_name: z.string().nullable().describe('Preferred common name, when one is recorded.'),
  })
  .describe('One rung of the taxonomic path, outermost first.');

export const TaxonChildSchema = TaxonLineageSchema.extend({
  observations_count: z
    .number()
    .nullable()
    .describe('How many observations this child taxon has. Null when upstream published none.'),
}).describe('One immediate child taxon.');

export const ConservationStatusSchema = z
  .object({
    status: z
      .string()
      .nullable()
      .describe(
        'The authority’s own status text — "Special Concern", "G4", "Sujeta a protección especial" are all real values. Not the normalised csi filter vocabulary.',
      ),
    authority: z.string().nullable().describe('The body that published this listing.'),
    iucn: z
      .number()
      .nullable()
      .describe('IUCN-normalised level upstream assigns this listing, on its own numeric scale.'),
    place: z
      .string()
      .nullable()
      .describe('Place the listing applies to. Null for a listing with global scope.'),
    url: z.string().nullable().describe('Source page for the listing, when published.'),
  })
  .describe('One conservation listing, by authority and place.');

export const EncyclopediaSchema = z
  .object({
    wikipedia_summary: z
      .string()
      .nullable()
      .describe(
        'Encyclopedia summary, verbatim and containing inline HTML tags. Third-party free text.',
      ),
    wikipedia_url: z.string().nullable().describe('Wikipedia page for the taxon.'),
  })
  .describe('The encyclopedia text and link upstream carries for the taxon.');

export const ConservationSchema = z
  .object({
    statuses: z
      .array(ConservationStatusSchema)
      .describe('Every listing upstream records, one per authority and place.'),
    global_status: ConservationStatusSchema.nullable().describe(
      'The listing upstream marks as the taxon’s global status. Null when it records none.',
    ),
  })
  .describe('Conservation listings for the taxon.');

/**
 * The projected taxon profile. `listed_taxa` — 26 KB of per-country checklist
 * membership — is dropped for `listed_taxa_count`, and the taxon record
 * duplicated inside every gallery photo goes with it.
 */
export const TaxonDocumentSchema = z.object({
  id: z.number().describe('Taxon id.'),
  name: z.string().nullable().describe('Scientific name.'),
  rank: z.string().nullable().describe('Taxonomic rank, e.g. "species".'),
  rank_level: z
    .number()
    .nullable()
    .describe('Numeric rank level — 70 kingdom, 30 family, 10 species, 5 subspecies.'),
  common_name: z.string().nullable().describe('Preferred common name, when one is recorded.'),
  iconic_taxon_name: z
    .string()
    .nullable()
    .describe('Broad organism group, e.g. "Insecta". Usable as an iconic_taxa filter value.'),
  is_active: z
    .boolean()
    .describe('False for a taxon superseded by a taxonomic change; its id still resolves.'),
  extinct: z.boolean().describe('True when the taxon is recorded as extinct.'),
  observations_count: z
    .number()
    .nullable()
    .describe('How many observations carry this taxon or a descendant of it.'),
  listed_taxa_count: z
    .number()
    .nullable()
    .describe(
      'How many place checklists include this taxon. The checklist entries themselves are not relayed.',
    ),
  vision: z.boolean().describe('True when the taxon is covered by the upstream image classifier.'),
  taxonomy: z
    .array(TaxonLineageSchema)
    .describe('Ancestors from the root of the tree down to the taxon’s parent.'),
  children: z.array(TaxonChildSchema).describe('Immediate children of this taxon.'),
  conservation: ConservationSchema,
  photos: z.array(TaxonPhotoSchema).describe('Gallery photos, each with its own licence.'),
  encyclopedia: EncyclopediaSchema,
});

export type TaxonDocumentOutput = z.infer<typeof TaxonDocumentSchema>;

/**
 * A document that may carry only some of its sections — what a `sections`
 * selection returns, and what the outline arm returns none of.
 */
export type PartialTaxonDocument = {
  [K in keyof TaxonDocumentOutput]?: TaxonDocumentOutput[K] | undefined;
};

/**
 * Sections an agent may name in a `sections` re-call. `summary` is virtual — it
 * covers the flat scalars at the document root rather than a nested key.
 */
export const TAXON_SECTIONS = [
  'summary',
  'taxonomy',
  'children',
  'conservation',
  'photos',
  'encyclopedia',
] as const;

/** The document-root scalars the virtual `summary` section stands for. */
export const TAXON_SUMMARY_KEYS = [
  'id',
  'name',
  'rank',
  'rank_level',
  'common_name',
  'iconic_taxon_name',
  'is_active',
  'extinct',
  'observations_count',
  'listed_taxa_count',
  'vision',
] as const;

/** Kept on every selection so a sliced document still identifies itself. */
export const TAXON_ALWAYS_KEEP = ['id', 'name', 'rank'] as const;

function conservationLine(status: z.infer<typeof ConservationStatusSchema>): string {
  return [
    `status ${status.status ?? 'not published'}`,
    `authority ${status.authority ?? 'not published'}`,
    `iucn ${status.iucn ?? 'not published'}`,
    `place ${status.place ?? 'global'}`,
    `url ${status.url ?? 'none published'}`,
  ].join(' · ');
}

/**
 * The taxon document's markdown block. Every arm renders on field presence and
 * independently, never by branching on the caller's `kind`: a sliced document
 * carries only the sections that were asked for, and the outline arm carries
 * none of them.
 */
export function renderTaxonDocument(doc: PartialTaxonDocument): string[] {
  const lines: string[] = [];

  if (doc.id !== undefined) {
    const common = doc.common_name ?? 'no common name';
    const scientific = doc.name ?? 'name not recorded';
    lines.push(
      `## ${doc.common_name || doc.name ? `${common} (${scientific})` : UNNAMED_TAXON}`,
      [
        `id ${doc.id}`,
        `name ${scientific}`,
        `common_name ${common}`,
        `rank ${doc.rank ?? 'not recorded'}`,
        `rank_level ${doc.rank_level ?? 'not published'}`,
        `iconic_taxon_name ${doc.iconic_taxon_name ?? 'none assigned'}`,
        `is_active ${doc.is_active ?? 'not published'}`,
        `extinct ${doc.extinct ?? 'not published'}`,
        `observations_count ${doc.observations_count ?? 'not published'}`,
        `listed_taxa_count ${doc.listed_taxa_count ?? 'not published'}`,
        `vision ${doc.vision ?? 'not published'}`,
      ].join(' · '),
    );
  }

  if (doc.taxonomy) {
    lines.push('### Taxonomy');
    lines.push(
      doc.taxonomy.length === 0
        ? '_No ancestors published._'
        : doc.taxonomy
            .map(
              (rung) =>
                `${rung.rank ?? 'rank not recorded'} ${rung.name ?? 'name not recorded'} (${rung.common_name ?? 'no common name'}, id ${rung.id})`,
            )
            .join(' › '),
    );
  }

  if (doc.children) {
    lines.push('### Children');
    if (doc.children.length === 0) lines.push('_No child taxa published._');
    for (const child of doc.children) {
      lines.push(
        `- **${child.common_name ?? 'no common name'}** (${child.name ?? 'name not recorded'}) — ${child.rank ?? 'rank not recorded'} · taxon_id ${child.id} · ${child.observations_count ?? 'observation count not published'} observations`,
      );
    }
  }

  if (doc.conservation) {
    lines.push('### Conservation');
    lines.push(
      `**Global status:** ${doc.conservation.global_status ? conservationLine(doc.conservation.global_status) : 'none recorded'}`,
    );
    if (doc.conservation.statuses.length === 0) lines.push('_No listings published._');
    for (const status of doc.conservation.statuses) {
      lines.push(`- ${conservationLine(status)}`);
    }
  }

  if (doc.photos) {
    lines.push('### Photos');
    if (doc.photos.length === 0) lines.push('_No gallery photos published._');
    for (const [index, photo] of doc.photos.entries()) {
      lines.push(...renderPhoto(photo, `Photo ${index + 1}`));
      lines.push(`large_url ${photo.large_url ?? 'not published'}`);
    }
  }

  if (doc.encyclopedia) {
    lines.push('### Encyclopedia');
    if (doc.encyclopedia.wikipedia_summary) {
      lines.push(...blockquote(doc.encyclopedia.wikipedia_summary));
    } else {
      lines.push('_No encyclopedia summary published._');
    }
    lines.push(`**wikipedia_url:** ${doc.encyclopedia.wikipedia_url ?? 'none published'}`);
  }

  return lines;
}
