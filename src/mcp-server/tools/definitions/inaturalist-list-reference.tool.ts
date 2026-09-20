/**
 * @fileoverview Decodes the controlled vocabularies the other iNaturalist tools
 * take as filter input.
 * @module mcp-server/tools/definitions/inaturalist-list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inlineText } from '@/mcp-server/tools/observation-record.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';
import { STATIC_VOCABULARIES } from '@/services/inaturalist/vocabularies.js';

const TOPICS = [
  'controlled_terms',
  'quality_grades',
  'licenses',
  'ranks',
  'iconic_taxa',
  'conservation_status_codes',
] as const;

const EntrySchema = z
  .object({
    id: z
      .number()
      .optional()
      .describe('Numeric attribute id, on the controlled_terms topic. Pass it as term_id.'),
    code: z
      .string()
      .optional()
      .describe(
        'The literal filter value to pass, on the static topics — e.g. "needs_id", "cc0", "Aves".',
      ),
    label: z.string().nullable().describe('Human-readable name for the entry.'),
    notes: z
      .string()
      .optional()
      .describe('What the entry means, or how it is used, when it needs saying.'),
    multivalued: z
      .boolean()
      .optional()
      .describe('True when one observation may carry several values of this attribute.'),
    values: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe('Value id. Pass it as term_value_id alongside the attribute id.'),
            label: z.string().nullable().describe('Human-readable value name, e.g. "Larva".'),
            blocking: z
              .boolean()
              .describe('True when this value blocks other values of the same attribute.'),
          })
          .describe('One value of an annotation attribute.'),
      )
      .optional()
      .describe('Values this annotation attribute accepts, on the controlled_terms topic.'),
  })
  .describe('One vocabulary entry — an annotation attribute, or a static filter code.');

export const inaturalistListReference = tool('inaturalist_list_reference', {
  description:
    'Decode the vocabularies the other iNaturalist tools take as input: annotation attributes and values, quality grades, license codes, taxonomic ranks, iconic taxa, and IUCN conservation-status codes. An unrecognized filter value is not rejected upstream — it silently returns nothing — so read the codes here before filtering. Note that the conservation codes are the normalised csi search filter; a taxon record’s own conservation_statuses[].status is authority-specific free text and reads differently. With topic controlled_terms and a taxon_id, the response also carries which annotations identifiers have actually recorded for that taxon, with counts.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Which vocabulary to decode. controlled_terms is fetched live and cached; the rest are spec-derived static tables.',
      ),
    taxon_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Add observed annotation usage for this taxon, ranked by how often each attribute/value pair has been recorded. Valid only with topic controlled_terms. Resolve a name to an id with inaturalist_resolve_name.',
      ),
  }),

  output: z.object({
    topic: z.enum(TOPICS).describe('The vocabulary that was decoded.'),
    source: z
      .enum(['upstream', 'static'])
      .describe(
        '"upstream" when the table was fetched from iNaturalist, "static" when spec-derived.',
      ),
    entries: z.array(EntrySchema).describe('The vocabulary, one entry per code or attribute.'),
    observed_usage: z
      .array(
        z
          .object({
            attribute: z.string().nullable().describe('Annotation attribute label.'),
            value: z.string().nullable().describe('Annotation value label.'),
            count: z.number().describe('How many observations of this taxon carry the pair.'),
          })
          .describe('One attribute/value pair and how often it has been recorded.'),
      )
      .optional()
      .describe(
        'Observed annotation usage for taxon_id, most-used first. Present only when taxon_id was given.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the requested taxon has no recorded annotations yet.'),
  },

  errors: [
    {
      reason: 'taxon_id_not_applicable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'taxon_id was supplied with a topic other than controlled_terms.',
      recovery:
        'Drop taxon_id, or set topic to controlled_terms where taxon-scoped annotation usage applies.',
    },
    {
      reason: 'unknown_taxon_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'iNaturalist answered 422 because the taxon_id does not exist.',
      recovery:
        'Resolve the organism name with inaturalist_resolve_name and pass the taxon id it returns.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.taxon_id !== undefined && input.topic !== 'controlled_terms') {
      throw ctx.fail(
        'taxon_id_not_applicable',
        `taxon_id does not apply to topic "${input.topic}".`,
        { ...ctx.recoveryFor('taxon_id_not_applicable') },
      );
    }

    if (input.topic !== 'controlled_terms') {
      ctx.log.info('Serving a static vocabulary', { topic: input.topic });
      return {
        topic: input.topic,
        source: 'static' as const,
        entries: (STATIC_VOCABULARIES[input.topic] ?? []).map((entry) => ({
          code: entry.code,
          label: entry.label,
          ...(entry.notes ? { notes: entry.notes } : {}),
        })),
      };
    }

    const service = getINaturalistService();
    const terms = await service.getControlledTerms(ctx);
    const entries = terms.map((term) => ({
      id: term.id,
      label: term.label,
      multivalued: term.multivalued,
      values: term.values,
    }));

    if (input.taxon_id === undefined) {
      return { topic: input.topic, source: 'upstream' as const, entries };
    }

    const observedUsage = await service.getObservedUsage(input.taxon_id, ctx);
    if (observedUsage.length === 0) {
      ctx.enrich.notice(
        'No annotations have been recorded for this taxon yet; the full vocabulary above still applies.',
      );
    }
    return {
      topic: input.topic,
      source: 'upstream' as const,
      entries,
      observed_usage: observedUsage,
    };
  },

  format: (result) => {
    const lines: string[] = [`**${result.topic}** — source: ${result.source}`];

    for (const entry of result.entries) {
      const parts: string[] = [`**${inlineText(entry.label ?? 'label not published')}**`];
      if (entry.code !== undefined) parts.push(`code \`${inlineText(entry.code)}\``);
      if (entry.id !== undefined) parts.push(`id ${entry.id}`);
      if (entry.multivalued !== undefined) parts.push(`multivalued: ${entry.multivalued}`);
      lines.push(`- ${parts.join(' · ')}`);
      if (entry.notes) lines.push(`  ${inlineText(entry.notes)}`);
      for (const value of entry.values ?? []) {
        lines.push(
          `  - ${inlineText(value.label ?? 'label not published')} (id ${value.id}, blocking: ${value.blocking})`,
        );
      }
    }

    if (result.observed_usage) {
      lines.push('', '### Observed usage');
      for (const usage of result.observed_usage) {
        lines.push(
          `- ${inlineText(usage.attribute ?? 'undecoded attribute')} = ${inlineText(usage.value ?? 'undecoded value')} — ${usage.count} observations`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
