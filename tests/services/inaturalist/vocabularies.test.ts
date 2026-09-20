/**
 * @fileoverview Tests for the spec-derived static vocabularies and the
 * upstream quality-grade narrowing helper.
 * @module tests/services/inaturalist/vocabularies.test
 */

import { describe, expect, it } from 'vitest';
import { STATIC_VOCABULARIES, toQualityGrade } from '@/services/inaturalist/vocabularies.js';

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

  it('lists all 25 spec ranks, noting rank_level only on the 8 documented rungs', () => {
    const ranks = STATIC_VOCABULARIES.ranks ?? [];
    expect(ranks).toHaveLength(25);
    const withLevels = ranks.filter((entry) => entry.notes?.includes('rank_level'));
    expect(withLevels).toHaveLength(8);
    expect(ranks.find((entry) => entry.code === 'species')?.notes).toBe('rank_level 10.');
    expect(ranks.find((entry) => entry.code === 'genushybrid')?.notes).toBeUndefined();
  });

  it('lists the 7 IUCN-normalised conservation status codes', () => {
    expect(STATIC_VOCABULARIES.conservation_status_codes).toHaveLength(7);
  });

  it('includes the null-license entry meaning all rights reserved', () => {
    const entry = STATIC_VOCABULARIES.licenses?.find((e) => e.code === 'null');
    expect(entry?.label).toBe('All rights reserved');
  });
});
