/**
 * @fileoverview Client for the keyless read subset of https://api.inaturalist.org/v1/.
 *
 * Two upstream properties drive everything here: responses are enormous and
 * cannot be trimmed at the source, and a query the API does not understand is
 * answered with HTTP 200 over a silently widened result set. So every request is
 * built from a per-endpoint parameter allowlist, and every response is projected
 * before it leaves this module.
 *
 * @module services/inaturalist/inaturalist-service
 */

import { Buffer } from 'node:buffer';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  internalError,
  McpError,
  rateLimited,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  buildControlledTermIndex,
  type ControlledTermIndex,
  histogramBuckets,
  projectControlledTerm,
  projectLeaderboardEntry,
  projectObservation,
  projectObservedUsage,
  projectPhoto,
  projectPlace,
  projectSimilarSpecies,
  projectSpeciesCount,
  projectTaxonDocument,
  projectTaxonRecord,
  threadCap,
} from './projections.js';
import type {
  CandidateKind,
  ControlledTerm,
  HistogramBucket,
  INaturalistEnvelope,
  LeaderboardEntry,
  LeaderboardKind,
  ObservationExpansion,
  ObservedUsage,
  ProjectedObservation,
  ProjectedPlace,
  ProjectedTaxonDocument,
  RawControlledTerm,
  RawHistogram,
  RawLeaderboardEntry,
  RawObservation,
  RawPlace,
  RawPopularFieldValue,
  RawSearchResult,
  RawTaxon,
  RawTaxonCount,
  RawTaxonDocument,
  ResolvedCandidate,
  SimilarSpecies,
  SpeciesCount,
} from './types.js';

const BASE_URL = 'https://api.inaturalist.org/v1';
const TIMEOUT_MS = 15_000;

/**
 * Backoff calibrated to the rate-limited / degraded band rather than the
 * ephemeral one — the upstream returns no `X-RateLimit-*` or `Retry-After`
 * header on any probed response, so there is nothing to react to and a short
 * retry would simply spend the daily budget faster.
 */
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Statuses that are an expected caller-input outcome rather than a fault, so a
 * bad `taxon_id` logs at debug instead of filling the error stream. The thrown
 * error is unchanged either way.
 */
const EXPECTED_STATUSES = [422] as const;

const HTML_BODY = /^\s*<(?:!DOCTYPE\s+html|html[\s>])/i;

/** Every upstream path this server is allowed to reach. */
export type Endpoint =
  | 'controlled_terms'
  | 'taxa/autocomplete'
  | 'taxa'
  | 'search'
  | 'observations'
  | 'observations/species_counts'
  | 'observations/histogram'
  | 'observations/observers'
  | 'observations/identifiers'
  | 'observations/popular_field_values'
  | 'identifications/similar_species'
  | 'places/autocomplete'
  | 'places/nearby';

const AREA_PARAMS = [
  'place_id',
  'lat',
  'lng',
  'radius',
  'nelat',
  'nelng',
  'swlat',
  'swlng',
] as const;

const OBSERVATION_FILTER_PARAMS = [
  'taxon_id',
  'd1',
  'd2',
  'quality_grade',
  'captive',
  'term_id',
  'term_value_id',
  'iconic_taxa',
] as const;

/** Observer and project scoping, probed on `/observations` and `/observations/species_counts` only. */
const OBSERVER_PROJECT_PARAMS = ['user_id', 'user_login', 'project_id'] as const;

const LEADERBOARD_PARAMS = [
  ...AREA_PARAMS,
  'taxon_id',
  'd1',
  'd2',
  'quality_grade',
  'captive',
  'page',
  'per_page',
] as const;

/**
 * Per-endpoint parameter allowlist, copied from the spec's own parameter list
 * for each path. An unknown parameter name is not an error upstream — it returns
 * HTTP 200 and the entire 387M-record index — so one typo anywhere in this
 * module would turn a scoped query into a global one with no signal at any
 * layer. A new filter needs a probe before it is added here.
 */
const PARAMETER_ALLOWLIST: Readonly<Record<Endpoint, ReadonlySet<string>>> = {
  controlled_terms: new Set(),
  'taxa/autocomplete': new Set(['q', 'rank', 'per_page']),
  taxa: new Set(),
  search: new Set(['q', 'sources', 'per_page']),
  observations: new Set([
    ...AREA_PARAMS,
    ...OBSERVATION_FILTER_PARAMS,
    ...OBSERVER_PROJECT_PARAMS,
    'hrank',
    'lrank',
    'csi',
    'threatened',
    'native',
    'introduced',
    'endemic',
    'licensed',
    'photo_licensed',
    'license',
    'photo_license',
    'q',
    'search_on',
    'order_by',
    'order',
    'page',
    'per_page',
    'id_below',
  ]),
  'observations/species_counts': new Set([
    ...AREA_PARAMS,
    ...OBSERVATION_FILTER_PARAMS,
    ...OBSERVER_PROJECT_PARAMS,
    'page',
    'per_page',
  ]),
  'observations/histogram': new Set([
    ...AREA_PARAMS,
    ...OBSERVATION_FILTER_PARAMS,
    'interval',
    'date_field',
  ]),
  'observations/observers': new Set(LEADERBOARD_PARAMS),
  'observations/identifiers': new Set(LEADERBOARD_PARAMS),
  'observations/popular_field_values': new Set(['taxon_id']),
  'identifications/similar_species': new Set([
    ...AREA_PARAMS,
    'taxon_id',
    'd1',
    'd2',
    'quality_grade',
    'captive',
  ]),
  'places/autocomplete': new Set(['q']),
  'places/nearby': new Set(['nelat', 'nelng', 'swlat', 'swlng', 'per_page']),
};

/**
 * TTLs, in seconds, for the surfaces whose content moves on the order of hours
 * to months and whose raw payloads are the largest here. Observation search,
 * species counts, leaderboards, and observation detail are deliberately absent —
 * freshness is what this server is for.
 */
const CACHE_TTL_SECONDS: Readonly<Partial<Record<Endpoint, number>>> = {
  controlled_terms: 86_400,
  taxa: 21_600,
  'places/autocomplete': 21_600,
  'places/nearby': 21_600,
  'observations/histogram': 3_600,
  'identifications/similar_species': 21_600,
};

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

type RequestSpec = {
  endpoint: Endpoint;
  /** Path segment appended to the endpoint — an id or comma-joined id list. */
  path?: string;
  params?: QueryParams;
};

/** `/search` labels each hit with its record kind; these are the four observed. */
const SEARCH_TYPE_TO_KIND: Readonly<Record<string, CandidateKind>> = {
  Taxon: 'taxon',
  Place: 'place',
  Project: 'project',
  User: 'user',
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class INaturalistService {
  private readonly userAgent: string;
  private readonly minRequestIntervalMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly dailyRequestBudget: number;

  /** Earliest wall-clock time the next outbound request may start. */
  private nextStartAt = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private budgetDate = '';
  private budgetUsed = 0;

  constructor(config: {
    userAgent: string;
    minRequestIntervalMs: number;
    maxConcurrentRequests: number;
    dailyRequestBudget: number;
  }) {
    this.userAgent = config.userAgent;
    this.minRequestIntervalMs = config.minRequestIntervalMs;
    this.maxConcurrentRequests = config.maxConcurrentRequests;
    this.dailyRequestBudget = config.dailyRequestBudget;
  }

  // ─── Traffic shaping ────────────────────────────────────────────────────────

  /**
   * Counts one outbound request against the per-UTC-day ceiling. The counter is
   * per process and resets on restart — a guard rail for a shared egress IP, not
   * an accounting system — and exhaustion fails loudly so the ceiling is never
   * mistaken for an upstream outage.
   */
  private consumeBudget(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.budgetDate) {
      this.budgetDate = today;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed >= this.dailyRequestBudget) {
      throw rateLimited(
        `This server has spent its daily iNaturalist request budget of ${this.dailyRequestBudget} for ${today} (UTC).`,
        {
          reason: 'rate_budget_exhausted',
          retryable: false,
          dailyRequestBudget: this.dailyRequestBudget,
          utcDate: today,
          recovery: {
            hint: 'The upstream daily request allowance is spent; retry after the next UTC midnight, or raise INATURALIST_DAILY_REQUEST_BUDGET only if this deployment does not share an egress IP.',
          },
        },
      );
    }
    this.budgetUsed += 1;
  }

  private async acquireSlot(): Promise<void> {
    // Re-check after waking: a slot freed for this waiter can be taken by a
    // caller that entered between the release and this continuation.
    while (this.active >= this.maxConcurrentRequests) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  /**
   * Holds the caller until the shared start-interval clock allows another
   * request to begin. Separate knob from the in-flight cap: start spacing bounds
   * the sustained rate, the cap bounds the burst.
   */
  private async awaitStartWindow(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.minRequestIntervalMs;
    if (startAt > now) await sleep(startAt - now, signal);
  }

  private async paced<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
    this.consumeBudget();
    await this.acquireSlot();
    try {
      await this.awaitStartWindow(ctx.signal);
      return await run();
    } finally {
      this.releaseSlot();
    }
  }

  // ─── Request pipeline ───────────────────────────────────────────────────────

  private buildUrl(spec: RequestSpec): string {
    const allowed = PARAMETER_ALLOWLIST[spec.endpoint];
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.params ?? {})) {
      if (value === undefined) continue;
      if (!allowed.has(key)) {
        throw internalError(`Parameter "${key}" is not on the allowlist for ${spec.endpoint}.`, {
          endpoint: spec.endpoint,
          parameter: key,
        });
      }
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        query.set(key, value.join(','));
        continue;
      }
      query.set(key, String(value));
    }
    query.sort();
    const path = spec.path ? `${spec.endpoint}/${spec.path}` : spec.endpoint;
    const qs = query.toString();
    return qs ? `${BASE_URL}/${path}?${qs}` : `${BASE_URL}/${path}`;
  }

  /**
   * `ctx.state` keys are restricted to `[a-zA-Z0-9_.\-/]`, so a URL cannot be a
   * key. base64url's alphabet is legal as-is.
   */
  private cacheKey(spec: RequestSpec): string {
    const url = this.buildUrl(spec);
    return `inat/${spec.endpoint}/${Buffer.from(url, 'utf8').toString('base64url')}`;
  }

  /** Best-effort read; a miss and a storage failure both fall through to a live fetch. */
  private async readCache<T>(key: string, ctx: Context): Promise<T | null> {
    try {
      return await ctx.state.get<T>(key);
    } catch (err) {
      ctx.log.debug('Cache read failed; falling through to a live fetch', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async writeCache(key: string, value: unknown, ttl: number, ctx: Context): Promise<void> {
    try {
      await ctx.state.set(key, value, { ttl });
    } catch (err) {
      ctx.log.debug('Cache write failed; the response is still returned', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The one place an outbound request happens. Retry wraps fetch plus parse, and
   * the pacing gate sits inside the retry so a retried attempt is spaced and
   * budgeted like any other.
   */
  private async request<T>(spec: RequestSpec, ctx: Context): Promise<T> {
    const ttl = CACHE_TTL_SECONDS[spec.endpoint];
    const key = ttl === undefined ? undefined : this.cacheKey(spec);
    if (key !== undefined) {
      const cached = await this.readCache<T>(key, ctx);
      if (cached !== null) {
        ctx.log.debug('Serving from the response cache', { endpoint: spec.endpoint });
        return cached;
      }
    }

    const url = this.buildUrl(spec);
    ctx.log.debug('Calling iNaturalist', { endpoint: spec.endpoint });

    const payload = await withRetry(
      () =>
        this.paced(ctx, async () => {
          const response = await this.fetchJson(url, spec.endpoint, ctx);
          return response as T;
        }),
      {
        operation: `INaturalist.${spec.endpoint}`,
        context: ctx,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        signal: ctx.signal,
      },
    );

    if (key !== undefined && ttl !== undefined) await this.writeCache(key, payload, ttl, ctx);
    return payload;
  }

  private async fetchJson(url: string, endpoint: Endpoint, ctx: Context): Promise<unknown> {
    let text: string;
    try {
      const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: ctx.signal,
        expectedStatuses: [...EXPECTED_STATUSES],
      });
      text = await response.text();
    } catch (err) {
      throw mapUpstreamError(err, ctx);
    }

    // An edge or maintenance page is upstream degradation, not malformed data,
    // so it is thrown as transient and the retry gets a chance to clear it.
    if (HTML_BODY.test(text)) {
      throw serviceUnavailable('iNaturalist returned an HTML page instead of JSON.', {
        endpoint,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw serializationError(
        'iNaturalist returned a body that is not valid JSON.',
        { endpoint },
        { cause: err },
      );
    }
  }

  // ─── Reference vocabulary ───────────────────────────────────────────────────

  /** The annotation vocabulary. Seven attributes, ~6.6 KB, cached 24 h. */
  async getControlledTerms(ctx: Context): Promise<ControlledTerm[]> {
    const payload = await this.request<INaturalistEnvelope<RawControlledTerm>>(
      { endpoint: 'controlled_terms' },
      ctx,
    );
    return (payload.results ?? []).map(projectControlledTerm);
  }

  /** The decoded vocabulary `projectObservation` reads when annotations are expanded. */
  async getControlledTermIndex(ctx: Context): Promise<ControlledTermIndex> {
    return buildControlledTermIndex(await this.getControlledTerms(ctx));
  }

  /**
   * Which annotations identifiers have actually recorded for a taxon, with
   * counts. `/controlled_terms/for_taxon` is not used: it tests exact
   * `taxon_ids` membership rather than ancestry and comes back empty for most
   * taxa, so observed usage answers the same question honestly.
   */
  async getObservedUsage(taxonId: number, ctx: Context): Promise<ObservedUsage[]> {
    const payload = await this.request<INaturalistEnvelope<RawPopularFieldValue>>(
      { endpoint: 'observations/popular_field_values', params: { taxon_id: taxonId } },
      ctx,
    );
    return (payload.results ?? []).map(projectObservedUsage).sort((a, b) => b.count - a.count);
  }

  // ─── Name resolution ────────────────────────────────────────────────────────

  /** Taxon name prefix match. `q` matches a name prefix or an exact id. */
  async autocompleteTaxa(
    params: { q: string; rank?: string | undefined; limit: number },
    ctx: Context,
  ): Promise<{ total: number; candidates: ResolvedCandidate[] }> {
    const payload = await this.request<INaturalistEnvelope<RawTaxon>>(
      {
        endpoint: 'taxa/autocomplete',
        params: { q: params.q, rank: params.rank, per_page: params.limit },
      },
      ctx,
    );
    const candidates: ResolvedCandidate[] = [];
    for (const raw of payload.results ?? []) {
      const record = projectTaxonRecord(raw);
      if (!record) continue;
      candidates.push({
        kind: 'taxon',
        id: record.id,
        name: record.name,
        ...(record.common_name ? { common_name: record.common_name } : {}),
        ...(record.rank ? { rank: record.rank } : {}),
        ...(raw.matched_term ? { matched_term: raw.matched_term } : {}),
        ...(record.observations_count === undefined
          ? {}
          : { observations_count: record.observations_count }),
        ...(record.photo ? { photo: record.photo } : {}),
      });
    }
    return { total: payload.total_results ?? candidates.length, candidates };
  }

  /**
   * The scored cross-kind search. Each raw record is 11.8–15.5 KB and is
   * projected to the candidate fields before anything is returned.
   */
  async searchRecords(
    params: { q: string; sources?: string | undefined; limit: number },
    ctx: Context,
  ): Promise<{ total: number; candidates: ResolvedCandidate[] }> {
    const payload = await this.request<INaturalistEnvelope<RawSearchResult>>(
      {
        endpoint: 'search',
        params: { q: params.q, sources: params.sources, per_page: params.limit },
      },
      ctx,
    );

    const candidates: ResolvedCandidate[] = [];
    for (const hit of payload.results ?? []) {
      const record = hit.record;
      const kind = SEARCH_TYPE_TO_KIND[hit.type ?? ''];
      if (!record || !kind || typeof record.id !== 'number') continue;
      const photo = projectPhoto(record.default_photo);
      const matched = hit.matches?.[0];
      candidates.push({
        kind,
        id: record.id,
        // `||`, not `??`: a member with no display name arrives as null or "".
        name: record.name || record.title || record.login || null,
        ...(kind === 'user' && record.login ? { login: record.login } : {}),
        ...(record.preferred_common_name ? { common_name: record.preferred_common_name } : {}),
        ...(record.rank ? { rank: record.rank } : {}),
        ...(record.display_name ? { display_name: record.display_name } : {}),
        ...(record.slug ? { slug: record.slug } : {}),
        ...(matched ? { matched_term: matched } : {}),
        ...(typeof hit.score === 'number' ? { score: hit.score } : {}),
        ...(typeof record.observations_count === 'number'
          ? { observations_count: record.observations_count }
          : {}),
        ...(photo ? { photo } : {}),
      });
    }
    return { total: payload.total_results ?? candidates.length, candidates };
  }

  // ─── Places ─────────────────────────────────────────────────────────────────

  /** Place name prefix match. The endpoint publishes no `per_page` and returns 10. */
  async autocompletePlaces(
    q: string,
    ctx: Context,
  ): Promise<{ total: number; places: ProjectedPlace[] }> {
    const payload = await this.request<INaturalistEnvelope<RawPlace>>(
      { endpoint: 'places/autocomplete', params: { q } },
      ctx,
    );
    const places = (payload.results ?? []).map(projectPlace);
    return { total: payload.total_results ?? places.length, places };
  }

  /** Places covering a map area. `results` here is an object, not an array. */
  async nearbyPlaces(
    bbox: { nelat: number; nelng: number; swlat: number; swlng: number },
    perPage: number,
    ctx: Context,
  ): Promise<{ total: number; standard: ProjectedPlace[]; community: ProjectedPlace[] }> {
    const payload = await this.request<{
      total_results?: number;
      results?: { standard?: RawPlace[]; community?: RawPlace[] };
    }>({ endpoint: 'places/nearby', params: { ...bbox, per_page: perPage } }, ctx);

    const standard = (payload.results?.standard ?? []).map(projectPlace);
    const community = (payload.results?.community ?? []).map(projectPlace);
    return {
      total: payload.total_results ?? standard.length + community.length,
      standard,
      community,
    };
  }

  // ─── Observations ───────────────────────────────────────────────────────────

  async searchObservations(
    params: QueryParams,
    include: ReadonlySet<ObservationExpansion>,
    ctx: Context,
  ): Promise<{ total: number; observations: ProjectedObservation[] }> {
    const [terms, payload] = await Promise.all([
      include.has('annotations') ? this.getControlledTermIndex(ctx) : undefined,
      this.request<INaturalistEnvelope<RawObservation>>({ endpoint: 'observations', params }, ctx),
    ]);
    const observations = (payload.results ?? []).map((raw) =>
      projectObservation(raw, { include, ...(terms ? { terms } : {}) }),
    );
    return { total: payload.total_results ?? observations.length, observations };
  }

  /**
   * Resolves a batch of observation ids in one upstream request. Unresolvable
   * ids are omitted from the response rather than reported, so the requested set
   * is reconciled against what came back and the misses are named per id.
   * A repeated id is requested and reported once. Upstream answers the batch
   * sorted by id as a string, so the records are put back in the order they
   * were asked for.
   *
   * The identification and comment threads and the filled observation fields
   * share one entry budget across the distinct records that came back —
   * `threadCap` of that count per array per record — so a heavily discussed
   * record cannot carry a reply many times the size of the rest of the batch.
   */
  async getObservations(
    ids: readonly number[],
    include: ReadonlySet<ObservationExpansion>,
    ctx: Context,
  ): Promise<{ observations: ProjectedObservation[]; unresolved: number[] }> {
    const requested = [...new Set(ids)];
    const [terms, payload] = await Promise.all([
      include.has('annotations') ? this.getControlledTermIndex(ctx) : undefined,
      this.request<INaturalistEnvelope<RawObservation>>(
        { endpoint: 'observations', path: requested.join(',') },
        ctx,
      ),
    ]);

    const byId = new Map((payload.results ?? []).map((raw) => [raw.id, raw]));
    const resolved = requested.flatMap((id) => byId.get(id) ?? []);
    const cap = threadCap(resolved.length);
    const observations = resolved.map((raw) =>
      projectObservation(raw, {
        include,
        detail: true,
        threadCap: cap,
        ...(terms ? { terms } : {}),
      }),
    );
    return { observations, unresolved: requested.filter((id) => !byId.has(id)) };
  }

  // ─── Aggregates ─────────────────────────────────────────────────────────────

  /**
   * Distinct species in an area, pre-aggregated upstream and ranked by count.
   * Positions are absolute, counted from the page offset against the raw row
   * index — so a row dropped for carrying no taxon leaves a gap rather than
   * renumbering the rows after it.
   */
  async getSpeciesCounts(
    params: QueryParams & { page: number; per_page: number },
    ctx: Context,
  ): Promise<{ total: number; species: SpeciesCount[] }> {
    const payload = await this.request<INaturalistEnvelope<RawTaxonCount>>(
      { endpoint: 'observations/species_counts', params },
      ctx,
    );
    const offset = (params.page - 1) * params.per_page;
    const species = (payload.results ?? [])
      .map((raw, index) => projectSpeciesCount(raw, offset + index + 1))
      .filter((row): row is SpeciesCount => row !== null);
    return { total: payload.total_results ?? species.length, species };
  }

  /**
   * Phenology buckets for one interval. Upstream nests the table under the
   * interval name, so the interval that was requested is what reads it back.
   */
  async getHistogram(
    params: QueryParams & { interval: string },
    ctx: Context,
  ): Promise<HistogramBucket[]> {
    const payload = await this.request<RawHistogram>(
      { endpoint: 'observations/histogram', params },
      ctx,
    );
    return histogramBuckets(payload, params.interval);
  }

  /**
   * One page of a leaderboard, normalised across the two endpoints' differing
   * result shapes. Ranks are absolute, counted from the page offset.
   */
  async getLeaderboard(
    kind: LeaderboardKind,
    params: QueryParams & { page: number; per_page: number },
    ctx: Context,
  ): Promise<{ total: number; entries: LeaderboardEntry[] }> {
    const payload = await this.request<INaturalistEnvelope<RawLeaderboardEntry>>(
      {
        endpoint: kind === 'observers' ? 'observations/observers' : 'observations/identifiers',
        params,
      },
      ctx,
    );
    const offset = (params.page - 1) * params.per_page;
    const entries = (payload.results ?? []).map((raw, index) =>
      projectLeaderboardEntry(raw, offset + index + 1, kind),
    );
    return { total: payload.total_results ?? entries.length, entries };
  }

  /**
   * The confusion graph. Each upstream result is a full 5.7–11.7 KB taxon
   * record and the endpoint publishes no page size, so the whole set arrives
   * and is projected before the caller's own limit is applied.
   */
  async getSimilarSpecies(
    params: QueryParams,
    ctx: Context,
  ): Promise<{ total: number; similar: SimilarSpecies[] }> {
    const payload = await this.request<INaturalistEnvelope<RawTaxonCount>>(
      { endpoint: 'identifications/similar_species', params },
      ctx,
    );
    const similar = (payload.results ?? [])
      .map(projectSimilarSpecies)
      .filter((row): row is SimilarSpecies => row !== null);
    return { total: payload.total_results ?? similar.length, similar };
  }

  /**
   * The taxon profile, projected. Returns `null` for the empty `results` array
   * upstream answers a missing id with — it never returns a 404.
   */
  async getTaxon(taxonId: number, ctx: Context): Promise<ProjectedTaxonDocument | null> {
    const payload = await this.request<INaturalistEnvelope<RawTaxonDocument>>(
      { endpoint: 'taxa', path: String(taxonId) },
      ctx,
    );
    return projectTaxonDocument(payload.results?.[0]);
  }
}

/**
 * Turns the upstream failures that carry meaning into typed ones. All are 422s
 * a caller can fix, told apart by the body: `Unknown taxon_id N` names an id
 * that does not exist, `Taxon N is not genus or finer` names a real taxon too
 * coarse for `/identifications/similar_species`, `Unknown user_id X` names an
 * observer that does not exist — upstream words an unknown `user_login` the
 * same way — and `Unknown project_id: [X]` a project. The reason each carries
 * is what routes the agent to its recovery.
 *
 * The upstream path stays out of the returned `data`: that object reaches the
 * caller on `structuredContent.error.data`, where the REST path names nothing
 * the caller can act on that the recovery hint does not already say. `request`
 * already logs the endpoint against this same request, which is where triage
 * reads it.
 */
function mapUpstreamError(err: unknown, ctx: Context): unknown {
  if (!(err instanceof McpError)) return err;
  const status = err.data?.status;
  const body = err.data?.body;
  if (status !== 422 || typeof body !== 'string') return err;
  if (body.includes('Unknown taxon_id')) {
    return validationError('iNaturalist does not recognize that taxon_id.', {
      reason: 'unknown_taxon_id',
      retryable: false,
      ...ctx.recoveryFor('unknown_taxon_id'),
    });
  }
  if (body.includes('is not genus or finer')) {
    return validationError(
      'iNaturalist lists look-alikes only for a genus or a finer rank, and that taxon_id is coarser.',
      {
        reason: 'taxon_rank_too_coarse',
        retryable: false,
        ...ctx.recoveryFor('taxon_rank_too_coarse'),
      },
    );
  }
  if (body.includes('Unknown user_id')) {
    return validationError('iNaturalist does not recognize that observer.', {
      reason: 'unknown_user',
      retryable: false,
      ...ctx.recoveryFor('unknown_user'),
    });
  }
  if (body.includes('Unknown project_id')) {
    return validationError('iNaturalist does not recognize that project_id.', {
      reason: 'unknown_project_id',
      retryable: false,
      ...ctx.recoveryFor('unknown_project_id'),
    });
  }
  return err;
}

// ─── Init / Accessor ──────────────────────────────────────────────────────────

let _service: INaturalistService | undefined;

export function initINaturalistService(): void {
  _service = new INaturalistService(getServerConfig());
}

export function getINaturalistService(): INaturalistService {
  if (!_service) {
    throw new Error(
      'INaturalistService not initialized — call initINaturalistService() in setup()',
    );
  }
  return _service;
}
