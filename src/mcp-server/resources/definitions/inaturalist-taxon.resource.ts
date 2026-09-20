/**
 * @fileoverview Taxon profile as injectable conversation context — the same
 * projected document `inaturalist_get_taxon` returns, minus the section-selection
 * arm a resource read has no way to ask for.
 * @module mcp-server/resources/definitions/inaturalist-taxon.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { TaxonDocumentSchema } from '@/mcp-server/tools/taxon-document.js';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';

export const inaturalistTaxonResource = resource('inaturalist://taxa/{taxon_id}', {
  name: 'inaturalist-taxon',
  description:
    'Taxon profile by numeric iNaturalist taxon id — taxonomic path, per-authority conservation listings, encyclopedia summary, photo gallery, immediate children, and observation counts. The whole projected document, whatever its size: a resource read has no way to name sections, so use inaturalist_get_taxon when the outline-and-sections path matters.',
  mimeType: 'application/json',
  // Matches the service's six-hour taxon TTL — a taxon profile changes on the
  // order of months.
  cacheHint: { ttlMs: 21_600_000, cacheScope: 'public' },

  params: z.object({
    taxon_id: z
      .string()
      .regex(/^[1-9]\d*$/)
      .describe(
        'Numeric iNaturalist taxon id, e.g. 48662. Resolve a name to an id with inaturalist_resolve_name.',
      ),
  }),

  output: TaxonDocumentSchema,

  async handler(params, ctx) {
    const taxonId = Number(params.taxon_id);
    ctx.log.info('Reading a taxon resource', { taxonId });

    const doc = await getINaturalistService().getTaxon(taxonId, ctx);
    if (!doc) {
      throw notFound(`iNaturalist holds no taxon with id ${taxonId}.`, {
        taxon_id: taxonId,
        recovery: {
          hint: 'Resolve the organism name with inaturalist_resolve_name and read the resource at the taxon id it returns.',
        },
      });
    }
    return doc;
  },
});
