/**
 * @fileoverview Fetches a taxon profile — taxonomy, conservation listings,
 * photos, encyclopedia summary, and children — with an outline arm for a taxon
 * whose projected document still overflows the response budget.
 * @module mcp-server/tools/definitions/inaturalist-get-taxon.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  formatOutline,
  OUTLINE_VARIANT,
  outlineOnOverflow,
  type SectionMeta,
  selectSections,
} from '@cyanheads/mcp-ts-core/utils';
import {
  renderTaxonDocument,
  TAXON_ALWAYS_KEEP,
  TAXON_SECTIONS,
  TAXON_SUMMARY_KEYS,
  TaxonDocumentSchema,
} from '@/mcp-server/tools/taxon-document.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import type { ProjectedTaxonDocument } from '@/services/inaturalist/types.js';

/** How many rejected section names the failure message repeats back, and how much of each. */
const ECHOED_UNKNOWN_SECTIONS = 3;
const ECHOED_SECTION_CHARS = 40;

/**
 * Names the rejected sections without mirroring the request back.
 *
 * `sections` is an unbounded array of unbounded strings, so echoing every
 * unknown entry lets one call inflate its own failure into an arbitrarily large
 * message — and that message is rendered into `content[]` and
 * `structuredContent.error` alike, straight into the agent's context. A handful
 * of names is all a caller needs to spot the typo; the valid list follows it
 * either way.
 */
function describeUnknownSections(unknown: readonly string[]): string {
  const shown = unknown
    .slice(0, ECHOED_UNKNOWN_SECTIONS)
    .map((section) =>
      section.length > ECHOED_SECTION_CHARS
        ? `${section.slice(0, ECHOED_SECTION_CHARS)}…`
        : section,
    )
    .join(', ');
  const rest = unknown.length - ECHOED_UNKNOWN_SECTIONS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Measures the document as the six named sections rather than as one section
 * per top-level key: the eleven root scalars are one thing an agent asks for,
 * and outlining them individually would list eleven sections of a few bytes
 * each alongside the ones that actually carry the weight.
 */
function taxonSections(doc: ProjectedTaxonDocument): SectionMeta[] {
  const summary = Object.fromEntries(TAXON_SUMMARY_KEYS.map((key) => [key, doc[key]]));
  return [
    { name: 'summary', bytes: JSON.stringify(summary).length },
    { name: 'taxonomy', bytes: JSON.stringify(doc.taxonomy).length },
    { name: 'children', bytes: JSON.stringify(doc.children).length },
    { name: 'conservation', bytes: JSON.stringify(doc.conservation).length },
    { name: 'photos', bytes: JSON.stringify(doc.photos).length },
    { name: 'encyclopedia', bytes: JSON.stringify(doc.encyclopedia).length },
  ];
}

export const inaturalistGetTaxon = tool('inaturalist_get_taxon', {
  description:
    'Fetch a taxon profile: the taxonomic path, per-authority conservation listings, the encyclopedia summary, the photo gallery, immediate children, and observation counts. Resolve a name to a taxon id with inaturalist_resolve_name first. The upstream record is 95 KB for a common species, so it is projected before anything else happens; a taxon that still overflows comes back as an outline of its sections with their byte sizes, and naming those sections in a re-call returns only those. The valid section names are summary, taxonomy, children, conservation, photos, and encyclopedia.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    taxon_id: z
      .number()
      .int()
      .min(1)
      .describe(
        'Numeric taxon id. A non-numeric value answers HTTP 422 with an empty message upstream, so the integer is enforced here. Resolve a name to an id with inaturalist_resolve_name.',
      ),
    sections: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Sections to return: summary, taxonomy, children, conservation, photos, encyclopedia. Omit for the whole profile, or an outline of it when it overflows. A selection returns whatever it names, at whatever size, so sum the byte sizes from the outline before asking for several.',
      ),
  }),

  output: z.object({
    kind: z
      .enum(['full', 'outline'])
      .describe(
        '"full" when the profile itself is returned, "outline" when it overflowed and only the section list came back.',
      ),
    ...TaxonDocumentSchema.partial().shape,
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'One section that can be named in a re-call, and what it costs.',
        ),
      )
      .optional()
      .describe('Available sections and their byte sizes, largest first. Present on the outline.'),
    notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe('How to re-call for specific sections. Present on the outline.'),
  }),

  enrichment: {
    sections_applied: z
      .array(z.string())
      .describe(
        'Sections this response carries. Empty when the whole profile came back, so an absent section means the taxon has none rather than that it was never asked for.',
      ),
  },

  enrichmentTrailer: {
    sections_applied: {
      render: (sections) =>
        sections.length === 0
          ? '**Sections applied:** none — the whole profile'
          : `**Sections applied:** ${sections.join(', ')}`,
    },
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'iNaturalist answered with an empty results array for that taxon id.',
      recovery:
        'Resolve the organism name with inaturalist_resolve_name and retry with the taxon id it returns.',
    },
    {
      reason: 'unknown_section',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sections named a key the projected document does not carry.',
      recovery:
        'Call inaturalist_get_taxon without sections to see the section outline, then name sections from that list.',
    },
  ],

  async handler(input, ctx) {
    const requested = input.sections ?? [];
    const unknown = requested.filter(
      (section) => !(TAXON_SECTIONS as readonly string[]).includes(section),
    );
    if (unknown.length > 0) {
      throw ctx.fail(
        'unknown_section',
        `This profile carries no section named ${describeUnknownSections(unknown)}. The sections are ${TAXON_SECTIONS.join(', ')}.`,
        { ...ctx.recoveryFor('unknown_section') },
      );
    }

    ctx.log.info('Fetching a taxon profile', {
      taxonId: input.taxon_id,
      sections: requested.length,
    });

    // The selection call re-fetches rather than remembering: the upstream query
    // is deterministic from taxon_id and the service caches it for six hours,
    // so the outline and the selection share one request within that window.
    const doc = await getINaturalistService().getTaxon(input.taxon_id, ctx);
    if (!doc) {
      throw ctx.fail('not_found', `iNaturalist holds no taxon with id ${input.taxon_id}.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    ctx.enrich({ sections_applied: requested });

    if (requested.length > 0) {
      const keys = requested.flatMap((section) =>
        section === 'summary' ? [...TAXON_SUMMARY_KEYS] : [section],
      );
      return {
        ...selectSections(doc, keys, { alwaysKeep: [...TAXON_ALWAYS_KEEP] }),
        kind: 'full' as const,
      };
    }

    return outlineOnOverflow(doc, { extract: taxonSections });
  },

  // Each arm renders on field presence, independently — a selection carries only
  // the sections it named, and the outline carries none of them.
  format: (result) => [
    { type: 'text' as const, text: `**kind:** ${result.kind}` },
    ...(result.id === undefined
      ? []
      : [{ type: 'text' as const, text: renderTaxonDocument(result).join('\n') }]),
    ...(result.sections
      ? formatOutline({
          kind: 'outline',
          sections: result.sections,
          notice: result.notice ?? '',
        })
      : []),
  ],
});
