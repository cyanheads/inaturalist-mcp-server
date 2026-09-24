/**
 * @fileoverview Tests for the shared area/annotation filter validation and the
 * result-window boundary check every area-scoped tool relies on.
 * @module tests/mcp-server/tools/observation-filters.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  areaInputShape,
  dateRangeInputShape,
  emptyPageNotice,
  exceedsWindow,
  observerProjectInputShape,
  resolveAnnotation,
  resolveArea,
  resolveDateRange,
  resolveObserver,
  resolveRankRange,
  wideningGuidance,
} from '@/mcp-server/tools/observation-filters.js';

describe('dateRangeInputShape', () => {
  const schema = z.object(dateRangeInputShape);

  it('keeps a well-formed date', () => {
    expect(schema.parse({ d1: '2024-03-01', d2: '2024-03-31' })).toEqual({
      d1: '2024-03-01',
      d2: '2024-03-31',
    });
  });

  it('treats a blank string from a form client as unset, not as a malformed date', () => {
    expect(schema.parse({ d1: '', d2: '' })).toEqual({});
  });

  it('rejects anything else that is not YYYY-MM-DD', () => {
    expect(() => schema.parse({ d1: 'notadate' })).toThrow();
    expect(() => schema.parse({ d2: '2024-3-1' })).toThrow();
  });

  it('reports a malformed date once, as a pattern failure, without a calendar complaint on top', () => {
    const result = schema.safeParse({ d1: 'notadate' });
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe('invalid_format');
  });

  it('rejects a well-shaped date that does not exist on the calendar, on either bound', () => {
    expect(schema.safeParse({ d1: '2026-02-30' }).success).toBe(false);
    expect(schema.safeParse({ d2: '2026-02-30' }).success).toBe(false);
    expect(schema.safeParse({ d1: '2025-13-01' }).success).toBe(false);
    expect(schema.safeParse({ d2: '2025-00-10' }).success).toBe(false);
    expect(schema.safeParse({ d1: '2025-04-31' }).success).toBe(false);
    expect(schema.safeParse({ d1: '2025-02-29' }).success).toBe(false);
  });

  it('keeps the valid neighbours of an impossible date, leap days included', () => {
    expect(schema.safeParse({ d1: '2026-02-28', d2: '2026-03-05' }).success).toBe(true);
    expect(schema.safeParse({ d1: '2024-02-29' }).success).toBe(true);
    expect(schema.safeParse({ d1: '2000-02-29' }).success).toBe(true);
    expect(schema.safeParse({ d2: '2025-12-31' }).success).toBe(true);
  });

  it('rejects a calendar-invalid date with a message naming the problem', () => {
    const result = schema.safeParse({ d1: '2026-02-30' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('not a real calendar date');
  });

  /**
   * Verified 2026-09-22: upstream narrows d2=0000-02-29 to zero results (a real
   * day — year 0 is a leap year) and drops d2=0100-02-29 and d2=1900-02-29.
   * JavaScript's Date.UTC reads years 0–99 as 1900–1999, so it must not decide.
   */
  it('follows the proleptic Gregorian calendar for years 0–99', () => {
    expect(schema.safeParse({ d2: '0000-02-29' }).success).toBe(true);
    expect(schema.safeParse({ d2: '0004-02-29' }).success).toBe(true);
    expect(schema.safeParse({ d2: '0000-02-30' }).success).toBe(false);
    expect(schema.safeParse({ d2: '0100-02-29' }).success).toBe(false);
    expect(schema.safeParse({ d2: '1900-02-29' }).success).toBe(false);
  });

  it('rejects month 00 and day 00', () => {
    expect(schema.safeParse({ d2: '2020-00-10' }).success).toBe(false);
    expect(schema.safeParse({ d2: '2020-01-00' }).success).toBe(false);
  });

  it('still advertises the date pattern in JSON Schema', () => {
    const json = z.toJSONSchema(schema) as { properties: Record<string, { pattern?: string }> };
    expect(json.properties.d1?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(json.properties.d2?.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
  });
});

describe('resolveArea', () => {
  it('resolves to an empty fragment when no area is given — a valid global search', () => {
    expect(resolveArea({})).toEqual({ ok: true, value: {} });
  });

  it('resolves place_id alone', () => {
    expect(resolveArea({ place_id: 1 })).toEqual({ ok: true, value: { place_id: 1 } });
  });

  it('resolves the full lat/lng/radius triple', () => {
    expect(resolveArea({ lat: 47.6, lng: -122.3, radius: 10 })).toEqual({
      ok: true,
      value: { lat: 47.6, lng: -122.3, radius: 10 },
    });
  });

  it('resolves the full four-corner bounding box', () => {
    expect(resolveArea({ nelat: 47.7, nelng: -122.2, swlat: 47.5, swlng: -122.4 })).toEqual({
      ok: true,
      value: { nelat: 47.7, nelng: -122.2, swlat: 47.5, swlng: -122.4 },
    });
  });

  it('rejects an incomplete coordinate triple, naming how many of the three were given', () => {
    const result = resolveArea({ lat: 47.6 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('coordinate triple is incomplete');
    expect(!result.ok && result.message).toContain('1 of lat, lng and radius');
  });

  it('rejects an incomplete bounding box, naming how many of the four corners were given', () => {
    const result = resolveArea({ nelat: 47.7, nelng: -122.2 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('bounding box is incomplete');
    expect(!result.ok && result.message).toContain('2 of nelat, nelng, swlat and swlng');
  });

  it('rejects two forms supplied at once, even when each form is itself complete', () => {
    const result = resolveArea({
      place_id: 1,
      lat: 47.6,
      lng: -122.3,
      radius: 10,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('more than one form');
  });

  it('rejects radius alone (a lone radius still counts as a partial triple)', () => {
    const result = resolveArea({ radius: 10 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('coordinate triple is incomplete');
  });
});

describe('areaInputShape radius', () => {
  const schema = z.object(areaInputShape);

  it('leaves the lower bound to resolveArea, so 0 and negatives reach invalid_geography with its hint', () => {
    expect(schema.safeParse({ lat: 37, lng: -120, radius: 0 }).success).toBe(true);
    expect(schema.safeParse({ lat: 37, lng: -120, radius: -5 }).success).toBe(true);
    expect(schema.safeParse({ lat: 37, lng: -120, radius: 501 }).success).toBe(false);
  });

  it('advertises only the 500 km ceiling in JSON Schema', () => {
    const json = z.toJSONSchema(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.radius).toMatchObject({ type: 'number', maximum: 500 });
    expect(json.properties.radius).not.toHaveProperty('minimum');
    expect(json.properties.radius).not.toHaveProperty('exclusiveMinimum');
  });
});

describe('resolveArea — values upstream answers with HTTP 500', () => {
  it('rejects a zero radius', () => {
    const result = resolveArea({ lat: 37, lng: -120, radius: 0 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('radius must be greater than 0');
  });

  it('rejects a negative radius the same way', () => {
    const result = resolveArea({ lat: 37, lng: -120, radius: -5 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('radius must be greater than 0');
  });

  it('accepts a small positive radius', () => {
    expect(resolveArea({ lat: 37, lng: -120, radius: 0.001 })).toEqual({
      ok: true,
      value: { lat: 37, lng: -120, radius: 0.001 },
    });
  });

  it('rejects a bounding box whose nelat is south of swlat', () => {
    const result = resolveArea({ nelat: 37, nelng: -120, swlat: 38, swlng: -121 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('nelat 37 is south of swlat 38');
  });

  it('accepts a box whose corners share a latitude', () => {
    expect(resolveArea({ nelat: 37, nelng: -120, swlat: 37, swlng: -121 }).ok).toBe(true);
  });

  it('accepts an antimeridian-crossing box, where nelng is west of swlng', () => {
    expect(resolveArea({ nelat: 66, nelng: -170, swlat: 52, swlng: 170 })).toEqual({
      ok: true,
      value: { nelat: 66, nelng: -170, swlat: 52, swlng: 170 },
    });
  });

  it('still names an incomplete triple before judging the radius value', () => {
    const result = resolveArea({ radius: 0 });
    expect(!result.ok && result.message).toContain('coordinate triple is incomplete');
  });
});

describe('resolveDateRange', () => {
  it('resolves to an empty fragment when neither bound is given', () => {
    expect(resolveDateRange({})).toEqual({ ok: true, value: {} });
  });

  it('resolves either bound alone', () => {
    expect(resolveDateRange({ d1: '2025-01-01' })).toEqual({
      ok: true,
      value: { d1: '2025-01-01' },
    });
    expect(resolveDateRange({ d2: '2025-01-01' })).toEqual({
      ok: true,
      value: { d2: '2025-01-01' },
    });
  });

  it('resolves an ordered range', () => {
    expect(resolveDateRange({ d1: '2025-01-01', d2: '2026-01-01' })).toEqual({
      ok: true,
      value: { d1: '2025-01-01', d2: '2026-01-01' },
    });
  });

  it('keeps equal bounds valid — a single-day range', () => {
    expect(resolveDateRange({ d1: '2025-06-15', d2: '2025-06-15' }).ok).toBe(true);
  });

  it('rejects d1 after d2, naming both values', () => {
    const result = resolveDateRange({ d1: '2026-01-01', d2: '2025-01-01' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('d1 2026-01-01 is after d2 2025-01-01');
  });

  it('compares the whole date, not just the year', () => {
    expect(resolveDateRange({ d1: '2025-03-02', d2: '2025-03-01' }).ok).toBe(false);
    expect(resolveDateRange({ d1: '2025-02-28', d2: '2025-03-01' }).ok).toBe(true);
  });
});

describe('resolveRankRange', () => {
  it('resolves to an empty fragment when neither rank is given', () => {
    expect(resolveRankRange({})).toEqual({ ok: true, value: {} });
  });

  it('resolves either rank alone', () => {
    expect(resolveRankRange({ hrank: 'family' })).toEqual({ ok: true, value: { hrank: 'family' } });
    expect(resolveRankRange({ lrank: 'species' })).toEqual({
      ok: true,
      value: { lrank: 'species' },
    });
  });

  it('resolves a coarse hrank with a finer lrank', () => {
    expect(resolveRankRange({ hrank: 'order', lrank: 'family' })).toEqual({
      ok: true,
      value: { hrank: 'order', lrank: 'family' },
    });
  });

  it('keeps an equal pair valid — an exact-rank match', () => {
    expect(resolveRankRange({ hrank: 'family', lrank: 'family' }).ok).toBe(true);
  });

  it('rejects hrank finer than lrank, naming both ranks', () => {
    const result = resolveRankRange({ hrank: 'family', lrank: 'order' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('hrank "family" is finer than lrank "order"');
  });

  /**
   * Upstream compares rank_level, not list position: species and hybrid share
   * level 10, and subspecies, variety and form share level 5, so either order
   * of those pairs is an equal-level range.
   */
  it('treats ranks sharing a rank_level as equal, in either order', () => {
    expect(resolveRankRange({ hrank: 'hybrid', lrank: 'species' }).ok).toBe(true);
    expect(resolveRankRange({ hrank: 'species', lrank: 'hybrid' }).ok).toBe(true);
    expect(resolveRankRange({ hrank: 'variety', lrank: 'subspecies' }).ok).toBe(true);
    expect(resolveRankRange({ hrank: 'form', lrank: 'variety' }).ok).toBe(true);
    expect(resolveRankRange({ hrank: 'genushybrid', lrank: 'genus' }).ok).toBe(true);
  });

  it('rejects across the whole scale, from the finest hrank to the coarsest lrank', () => {
    expect(resolveRankRange({ hrank: 'form', lrank: 'stateofmatter' }).ok).toBe(false);
    expect(resolveRankRange({ hrank: 'subspecies', lrank: 'hybrid' }).ok).toBe(false);
  });
});

describe('resolveAnnotation', () => {
  it('resolves to an empty fragment when neither is given', () => {
    expect(resolveAnnotation({})).toEqual({ ok: true, value: {} });
  });

  it('resolves term_id alone', () => {
    expect(resolveAnnotation({ term_id: [1] })).toEqual({ ok: true, value: { term_id: [1] } });
  });

  it('resolves the paired term_id and term_value_id', () => {
    expect(resolveAnnotation({ term_id: [1], term_value_id: [6] })).toEqual({
      ok: true,
      value: { term_id: [1], term_value_id: [6] },
    });
  });

  it('rejects term_value_id supplied without term_id', () => {
    const result = resolveAnnotation({ term_value_id: [6] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('term_value_id was supplied without term_id');
  });

  it('treats an empty term_id array the same as absent — still rejects a lone term_value_id', () => {
    const result = resolveAnnotation({ term_id: [], term_value_id: [6] });
    expect(result.ok).toBe(false);
  });
});

describe('observerProjectInputShape', () => {
  const schema = z.object(observerProjectInputShape);

  it('keeps each filter as given', () => {
    expect(schema.parse({ user_id: 1, project_id: 227779 })).toEqual({
      user_id: 1,
      project_id: 227779,
    });
    expect(schema.parse({ user_login: 'kueda' })).toEqual({ user_login: 'kueda' });
  });

  it('treats a blank user_login as unset — sent blank, upstream returns the whole index', () => {
    expect(schema.parse({ user_login: '' })).toEqual({});
  });

  it('refuses a non-positive or fractional id', () => {
    expect(schema.safeParse({ user_id: 0 }).success).toBe(false);
    expect(schema.safeParse({ project_id: 1.5 }).success).toBe(false);
  });
});

describe('resolveObserver', () => {
  it('resolves to an empty fragment when no observer or project is given', () => {
    expect(resolveObserver({})).toEqual({ ok: true, value: {} });
  });

  it('resolves each observer form and the project on its own', () => {
    expect(resolveObserver({ user_id: 1 })).toEqual({ ok: true, value: { user_id: 1 } });
    expect(resolveObserver({ user_login: 'kueda', project_id: 5 })).toEqual({
      ok: true,
      value: { user_login: 'kueda', project_id: 5 },
    });
  });

  it('rejects user_id with user_login, even when they name the same person', () => {
    const result = resolveObserver({ user_id: 1, user_login: 'kueda' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('user_id and user_login');
  });
});

describe('emptyPageNotice', () => {
  it('names the last page when the page is past the end', () => {
    expect(emptyPageNotice({ page: 40, perPage: 25, total: 93, noun: 'records' })).toBe(
      'Page 40 is past the end: 93 records match, so the last page holding results at per_page 25 is 4. Request page 4 or lower — the filters are not what emptied this page.',
    );
  });

  it('counts an exactly full last page as the last page', () => {
    expect(emptyPageNotice({ page: 3, perPage: 25, total: 50, noun: 'species' })).toContain(
      'the last page holding results at per_page 25 is 2.',
    );
  });

  it('does not call a page inside the reported range past the end', () => {
    expect(emptyPageNotice({ page: 2, perPage: 25, total: 50, noun: 'people' })).toBe(
      'Page 2 came back empty although 50 people match — upstream’s count runs ahead of the rows it serves. Request an earlier page; the filters are not what emptied this page.',
    );
  });
});

describe('wideningGuidance', () => {
  it('names the observer and project options only when each was supplied', () => {
    expect(
      wideningGuidance({ quality_grade: ['research', 'needs_id'], user_login: 'kueda' }, false),
    ).toBe('Drop user_login or confirm the observer with inaturalist_resolve_name.');
    expect(
      wideningGuidance({ quality_grade: ['research', 'needs_id'], project_id: 227779 }, false),
    ).toBe('Drop project_id or confirm it with inaturalist_resolve_name.');
    expect(wideningGuidance({ quality_grade: ['research', 'needs_id'] }, false)).toBeUndefined();
  });
});

describe('exceedsWindow', () => {
  it('is false when the product sits inside the window', () => {
    expect(exceedsWindow(1, 20, 10_000)).toBe(false);
    expect(exceedsWindow(500, 20, 10_000)).toBe(false);
  });

  it('is false exactly at the window boundary', () => {
    expect(exceedsWindow(500, 20, 10_000)).toBe(false);
    expect(exceedsWindow(1, 10_000, 10_000)).toBe(false);
  });

  it('is true one past the window boundary', () => {
    expect(exceedsWindow(501, 20, 10_000)).toBe(true);
    expect(exceedsWindow(1, 10_001, 10_000)).toBe(true);
  });
});
