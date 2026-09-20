/**
 * @fileoverview Tests for the shared area/annotation filter validation and the
 * result-window boundary check every area-scoped tool relies on.
 * @module tests/mcp-server/tools/observation-filters.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  dateRangeInputShape,
  exceedsWindow,
  resolveAnnotation,
  resolveArea,
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
