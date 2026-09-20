/**
 * @fileoverview Resolves a place name to a place id, or lists the places
 * covering a map area, with the bounding box an area search needs.
 * @module mcp-server/tools/definitions/inaturalist-find-places.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getINaturalistService } from '@/services/inaturalist/inaturalist-service.js';

const PlaceSchema = z
  .object({
    id: z.number().describe('Place id — pass it as place_id to any area-scoped tool.'),
    name: z.string().nullable().describe('Place name as iNaturalist records it.'),
    display_name: z
      .string()
      .nullable()
      .describe('Place name with its administrative context, e.g. "Seattle CCD, US, WA".'),
    place_type: z
      .number()
      .nullable()
      .describe(
        'Raw place-type integer. iNaturalist publishes no code table for it, so no label is invented — display_name carries the meaning.',
      ),
    admin_level: z
      .number()
      .nullable()
      .describe('Raw administrative-level integer. No published code table; often null.'),
    bbox: z
      .object({
        swlat: z.number().describe('South-west corner latitude.'),
        swlng: z.number().describe('South-west corner longitude.'),
        nelat: z.number().describe('North-east corner latitude.'),
        nelng: z.number().describe('North-east corner longitude.'),
      })
      .nullable()
      .describe(
        'Corner pair computed from the place’s bounding polygon, ready to pass as a bounding box. Relayed as computed: a place crossing the antimeridian genuinely has a degenerate box upstream and it is not repaired here.',
      ),
    ancestor_place_ids: z
      .array(z.number())
      .describe('Containment chain, outermost first. Empty when upstream records none.'),
    location: z
      .object({
        lat: z.number().describe('Centre latitude.'),
        lng: z.number().describe('Centre longitude.'),
      })
      .nullable()
      .describe('Centre point of the place.'),
    slug: z.string().nullable().describe('URL slug. The place record publishes no URL of its own.'),
  })
  .describe('One place, with the bounding box and containment chain an area search needs.');

type PlaceOutput = z.infer<typeof PlaceSchema>;

export const inaturalistFindPlaces = tool('inaturalist_find_places', {
  description:
    'Resolve a place name to a place id, or list the places containing a map area. Pass q to match a place-name PREFIX, or all four of nelat, nelng, swlat and swlng to list every place covering that box — exactly one of the two, never both. Each result carries the bounding box, place type, and containment chain an area search needs. Place geometry is stripped: a single nearby response carries 247 KB of boundary polygons upstream, none of which reaches the caller.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    q: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Place-name prefix to search. Matches the start of a name, not words inside it. Mutually exclusive with the bounding box.',
      ),
    nelat: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('North-east corner latitude of the map area. All four corners or none.'),
    nelng: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('North-east corner longitude of the map area. All four corners or none.'),
    swlat: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('South-west corner latitude of the map area. All four corners or none.'),
    swlng: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe('South-west corner longitude of the map area. All four corners or none.'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe(
        'Maximum places to return. Honoured on the bounding-box arm only — the name-prefix endpoint publishes no page size and returns a fixed page.',
      ),
  }),

  output: z.object({
    places: z.array(PlaceSchema).optional().describe('Name-prefix matches. Present on the q arm.'),
    standard: z
      .array(PlaceSchema)
      .optional()
      .describe(
        'Curated administrative places covering the area. Present on the bounding-box arm.',
      ),
    community: z
      .array(PlaceSchema)
      .optional()
      .describe('Member-created places covering the area. Present on the bounding-box arm.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total places upstream matched, before any page limit.'),
    truncated: z.boolean().describe('True when more places matched than were returned.'),
    shown: z.number().describe('How many places this response carries.'),
    cap: z
      .number()
      .describe(
        'The page size that bounded this response — per_page on the bounding-box arm, the fixed page upstream served on the name-prefix arm.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched, or when the page capped the result set.'),
  },

  errors: [
    {
      reason: 'invalid_geography',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither q nor a complete bounding box was given, or both were.',
      recovery:
        'Pass q to search place names, or all four of nelat, nelng, swlat and swlng to list the places covering a map area.',
    },
  ],

  async handler(input, ctx) {
    const { q, nelat, nelng, swlat, swlng } = input;
    const supplied = [nelat, nelng, swlat, swlng].filter((corner) => corner !== undefined).length;
    const service = getINaturalistService();

    if (q !== undefined) {
      if (supplied > 0) {
        throw ctx.fail(
          'invalid_geography',
          'A place-name query and a bounding box cannot be combined.',
          { ...ctx.recoveryFor('invalid_geography') },
        );
      }
      ctx.log.info('Resolving a place name');
      const { total, places } = await service.autocompletePlaces(q, ctx);
      ctx.enrich.total(total);
      // The baseline disclosure rides every path — the enrichment block declares
      // these three as required, and `ctx.enrich.truncated` below overwrites them
      // when the fixed upstream page left matches unreachable.
      ctx.enrich({ truncated: false, shown: places.length, cap: places.length });
      if (places.length === 0) {
        ctx.enrich.notice(
          'No place name starts with that text — place search matches a name prefix. Try a shorter prefix or the official name, or pass a bounding box to list the places covering a map area.',
        );
      } else if (total > places.length) {
        ctx.enrich.truncated({
          shown: places.length,
          cap: places.length,
          guidance: `The place-name endpoint returns a fixed page of ${places.length} and publishes no pagination, so ${total - places.length} further matches are unreachable. Narrow the prefix, or pass a bounding box to list the places covering a map area.`,
        });
      }
      return { places };
    }

    if (nelat === undefined || nelng === undefined || swlat === undefined || swlng === undefined) {
      throw ctx.fail(
        'invalid_geography',
        `The bounding box is incomplete — ${supplied} of four corners were supplied, and no q was given.`,
        { ...ctx.recoveryFor('invalid_geography') },
      );
    }

    ctx.log.info('Listing places covering a map area');
    const { total, standard, community } = await service.nearbyPlaces(
      { nelat, nelng, swlat, swlng },
      input.per_page,
      ctx,
    );
    const shown = standard.length + community.length;
    ctx.enrich.total(total);
    ctx.enrich({ truncated: false, shown, cap: input.per_page });
    if (shown === 0) {
      ctx.enrich.notice(
        'No place covers that box. Widen the corners, or resolve a named area with q instead.',
      );
    } else if (shown >= input.per_page) {
      ctx.enrich.truncated({
        shown,
        cap: input.per_page,
        guidance: 'Raise per_page (max 30) to list more of the places covering this area.',
      });
    }
    return { standard, community };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.places) lines.push(...renderPlaces(result.places));
    if (result.standard) {
      lines.push('### Standard places');
      lines.push(...renderPlaces(result.standard));
    }
    if (result.community) {
      lines.push('### Community places');
      lines.push(...renderPlaces(result.community));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function renderPlaces(places: readonly PlaceOutput[]): string[] {
  const lines: string[] = [];
  for (const place of places) {
    lines.push('', `## ${place.display_name ?? place.name ?? '*(name not published)*'}`);
    lines.push(
      [
        `name ${place.name ?? 'not published'}`,
        `id ${place.id}`,
        `slug ${place.slug ?? 'none'}`,
        `place_type ${place.place_type ?? 'none'}`,
        `admin_level ${place.admin_level ?? 'none'}`,
      ].join(' · '),
    );
    lines.push(
      place.bbox
        ? `**Bounding box:** SW ${place.bbox.swlat}, ${place.bbox.swlng} → NE ${place.bbox.nelat}, ${place.bbox.nelng}`
        : '**Bounding box:** not published',
    );
    lines.push(
      place.location
        ? `**Centre:** ${place.location.lat}, ${place.location.lng}`
        : '**Centre:** not published',
    );
    lines.push(
      `**Contained by:** ${place.ancestor_place_ids.length ? place.ancestor_place_ids.join(' › ') : 'no containment chain recorded'}`,
    );
  }
  return lines;
}
