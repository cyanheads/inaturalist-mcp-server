/**
 * @fileoverview Tests for the spec-derived static vocabularies and the
 * upstream quality-grade narrowing helper.
 * @module tests/services/inaturalist/vocabularies.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { taxonStatusInputShape } from '@/mcp-server/tools/observation-filters.js';
import {
  CONSERVATION_STATUS_CODES,
  iucnCode,
  LICENSE_CODES,
  STATIC_VOCABULARIES,
  toQualityGrade,
} from '@/services/inaturalist/vocabularies.js';

describe('toQualityGrade', () => {
  it('passes through each documented grade unchanged', () => {
    expect(toQualityGrade('research')).toBe('research');
    expect(toQualityGrade('needs_id')).toBe('needs_id');
    expect(toQualityGrade('casual')).toBe('casual');
  });

  it('narrows an unrecognized or missing grade to casual rather than failing the record', () => {
    expect(toQualityGrade('bogus')).toBe('casual');
    expect(toQualityGrade(null)).toBe('casual');
    expect(toQualityGrade(undefined)).toBe('casual');
  });
});

describe('STATIC_VOCABULARIES', () => {
  it('carries entries for every static topic', () => {
    for (const topic of [
      'quality_grades',
      'licenses',
      'ranks',
      'iconic_taxa',
      'conservation_status_codes',
    ] as const) {
      expect(STATIC_VOCABULARIES[topic]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('lists all 14 spec iconic taxa', () => {
    expect(STATIC_VOCABULARIES.iconic_taxa).toHaveLength(14);
    expect(STATIC_VOCABULARIES.iconic_taxa?.map((entry) => entry.code)).toContain('unknown');
  });

  it('lists all 35 usable ranks, noting levels on documented and supplemental rungs', () => {
    const ranks = STATIC_VOCABULARIES.ranks ?? [];
    expect(ranks).toHaveLength(35);
    const withLevels = ranks.filter((entry) => entry.notes?.includes('rank_level'));
    expect(withLevels).toHaveLength(18);
    expect(ranks.find((entry) => entry.code === 'species')?.notes).toBe('rank_level 10.');
    expect(ranks.find((entry) => entry.code === 'genushybrid')?.notes).toBeUndefined();
  });

  it('lists the 7 csi codes with their levels, then NE and DD as listing-only levels', () => {
    expect(
      (STATIC_VOCABULARIES.conservation_status_codes ?? []).map(({ code, notes }) => [
        code,
        notes?.split(' ').slice(0, 2).join(' '),
      ]),
    ).toEqual([
      ['LC', 'iucn 10.'],
      ['NT', 'iucn 20.'],
      ['VU', 'iucn 30.'],
      ['EN', 'iucn 40.'],
      ['CR', 'iucn 50.'],
      ['EW', 'iucn 60.'],
      ['EX', 'iucn 70.'],
      ['NE', 'iucn 0.'],
      ['DD', 'iucn 5.'],
    ]);
    for (const entry of STATIC_VOCABULARIES.conservation_status_codes ?? []) {
      expect(entry.notes?.includes('not a csi value')).toBe(['NE', 'DD'].includes(entry.code));
    }
    expect(STATIC_VOCABULARIES.conservation_status_codes?.slice(0, 3)).toEqual([
      { code: 'LC', label: 'Least concern', notes: 'iucn 10.' },
      { code: 'NT', label: 'Near threatened', notes: 'iucn 20.' },
      { code: 'VU', label: 'Vulnerable', notes: 'iucn 30.' },
    ]);
  });

  it('includes the null-license entry meaning all rights reserved', () => {
    const entry = STATIC_VOCABULARIES.licenses?.find((e) => e.code === 'null');
    expect(entry?.label).toBe('All rights reserved');
  });
});

describe('iucnCode', () => {
  it.each([
    [0, 'NE'],
    [5, 'DD'],
    [10, 'LC'],
    [20, 'NT'],
    [30, 'VU'],
    [40, 'EN'],
    [50, 'CR'],
    [60, 'EW'],
    [70, 'EX'],
  ] as const)('decodes the published level %i to %s', (level, code) => {
    expect(iucnCode(level)).toBe(code);
  });

  it.each([35, -10, 75, 10.5, null])(
    'returns null for %s, which is off the published scale or absent',
    (level) => {
      expect(iucnCode(level)).toBeNull();
    },
  );
});

describe('csi filter codes', () => {
  const csi = z.object(taxonStatusInputShape).shape.csi;

  it('still accepts exactly LC, NT, VU, EN, CR, EW, and EX', () => {
    expect(CONSERVATION_STATUS_CODES).toEqual(['LC', 'NT', 'VU', 'EN', 'CR', 'EW', 'EX']);
    expect(csi.safeParse([...CONSERVATION_STATUS_CODES]).success).toBe(true);
  });

  it.each(['NE', 'DD'])('rejects the listing-only level %s', (code) => {
    expect(csi.safeParse([code]).success).toBe(false);
  });
});

describe('LICENSE_CODES', () => {
  it('is exactly the licenses topic codes minus null — the values the licence filters accept', () => {
    const topicCodes = (STATIC_VOCABULARIES.licenses ?? [])
      .map((entry) => entry.code)
      .filter((code) => code !== 'null');

    expect([...LICENSE_CODES].sort()).toEqual([...topicCodes].sort());
    expect(LICENSE_CODES).toHaveLength(7);
  });
});
