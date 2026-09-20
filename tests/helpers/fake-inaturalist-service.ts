/**
 * @fileoverview A fake INaturalistService for tool-level tests. Tool handlers
 * reach the network only through `getINaturalistService()`, so faking the
 * accessor's return value fakes the service boundary directly — the network
 * itself never enters a tool test, matching how the framework fakes an
 * upstream client at the seam the code under test actually calls.
 * @module tests/helpers/fake-inaturalist-service
 */

import { type Mock, vi } from 'vitest';
import type { INaturalistService } from '@/services/inaturalist/inaturalist-service.js';

type FakeMethod =
  | 'getControlledTerms'
  | 'getControlledTermIndex'
  | 'getObservedUsage'
  | 'autocompleteTaxa'
  | 'searchRecords'
  | 'autocompletePlaces'
  | 'nearbyPlaces'
  | 'searchObservations'
  | 'getObservations'
  | 'getSpeciesCounts'
  | 'getHistogram'
  | 'getLeaderboard'
  | 'getSimilarSpecies'
  | 'getTaxon';

/** One `vi.fn()` per public method `INaturalistService` exposes to tool handlers. */
export type FakeINaturalistService = {
  [K in FakeMethod]: Mock<INaturalistService[K]>;
};

export function createFakeService(): FakeINaturalistService {
  return {
    getControlledTerms: vi.fn(),
    getControlledTermIndex: vi.fn(),
    getObservedUsage: vi.fn(),
    autocompleteTaxa: vi.fn(),
    searchRecords: vi.fn(),
    autocompletePlaces: vi.fn(),
    nearbyPlaces: vi.fn(),
    searchObservations: vi.fn(),
    getObservations: vi.fn(),
    getSpeciesCounts: vi.fn(),
    getHistogram: vi.fn(),
    getLeaderboard: vi.fn(),
    getSimilarSpecies: vi.fn(),
    getTaxon: vi.fn(),
  } as unknown as FakeINaturalistService;
}

/** Narrows the fake back to the real service type for handing to a handler. */
export function asService(fake: FakeINaturalistService): INaturalistService {
  return fake as unknown as INaturalistService;
}

/** Resets every mocked method's calls and configured behavior between tests. */
export function resetFakeService(fake: FakeINaturalistService): void {
  for (const fn of Object.values(fake)) fn.mockReset();
}
