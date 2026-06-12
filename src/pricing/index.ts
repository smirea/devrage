import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CostDaySummary,
  CostModelSummary,
  CostSummary,
  PricingMetadata,
  PricingSource,
  UsageRecord,
} from "../adapters/index";

/**
 * Owns API-equivalent token pricing. The models.dev cache is local-only, and
 * adapter-reported billed cost stays separate from estimated token-price cost.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2_000;

interface PricingOptions {
  refresh?: boolean;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
}

interface PricingCatalog extends PricingMetadata {
  cachePath: string;
  catalog?: unknown;
}

interface PricingCacheFile {
  source: "models.dev";
  fetchedAt: string;
  schemaVersion: 1;
  catalog: unknown;
}

interface RateTable {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: unknown[];
  context_over_200k?: RateTable;
}

interface ResolvedRates {
  provider?: string;
  model: string;
  rates: RateTable;
  source: Exclude<PricingSource, "stored" | "unknown" | "mixed">;
}

interface PricedUsage {
  provider?: string;
  model: string;
  estimatedCost: number;
  source: PricingSource;
}

interface CostAccumulator {
  requests: number;
  estimatedCost: number;
  billedCost: number;
  unpricedRequests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  byModel: Map<string, CostModelSummary>;
}

const FALLBACK_COSTS: Record<string, Record<string, RateTable>> = {
  openai: {
    "gpt-5.5": {
      input: 5,
      output: 30,
      cache_read: 0.5,
      context_over_200k: { input: 10, output: 45, cache_read: 1 },
    },
    "gpt-5.5-pro": { input: 30, output: 180 },
    "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
    "gpt-5.4-nano": { input: 0.2, output: 1.25, cache_read: 0.02 },
    "gpt-5.4-pro": { input: 30, output: 180 },
    "gpt-5.3-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  },
  anthropic: {
    "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
};

const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
};

/** Load models.dev pricing from cache, refresh, stale cache, or embedded fallbacks. */
export async function loadPricingCatalog(options: PricingOptions = {}): Promise<PricingCatalog> {
  const cachePath = getPricingCachePath();
  const cache = await readPricingCache(cachePath);
  const ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;

  if (!options.refresh && cache && isFresh(cache.fetchedAt, ttlMs)) {
    return {
      source: "catalog",
      fetchedAt: cache.fetchedAt,
      cachePath,
      catalog: cache.catalog,
    };
  }

  try {
    const catalog = await fetchModelsDevCatalog(options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
    const fetchedAt = new Date().toISOString();
    await writePricingCache(cachePath, {
      source: "models.dev",
      fetchedAt,
      schemaVersion: 1,
      catalog,
    });

    return { source: "catalog", fetchedAt, cachePath, catalog };
  } catch {
    if (cache) {
      return {
        source: "stale-catalog",
        fetchedAt: cache.fetchedAt,
        cachePath,
        catalog: cache.catalog,
      };
    }

    return { source: "fallback", cachePath };
  }
}

/** Price usage rows individually, then aggregate by model for report output. */
export async function summarizeUsage(
  records: AsyncIterable<UsageRecord>,
  pricing: PricingCatalog,
): Promise<CostSummary> {
  const total = createCostAccumulator();
  const byDay = new Map<string, CostAccumulator>();

  for await (const record of records) {
    const priced = priceUsageRecord(record, pricing);
    const billedCost = record.billedCost ?? 0;
    const isUnpriced = priced.source === "stored" || priced.source === "unknown";
    addUsageToAccumulator(total, record, priced, billedCost, isUnpriced);

    const day = timestampDay(record.timestamp);
    if (day) {
      let dayAccumulator = byDay.get(day);
      if (!dayAccumulator) {
        dayAccumulator = createCostAccumulator();
        byDay.set(day, dayAccumulator);
      }
      addUsageToAccumulator(dayAccumulator, record, priced, billedCost, isUnpriced);
    }
  }

  return {
    requests: total.requests,
    estimatedCost: total.estimatedCost,
    billedCost: total.billedCost,
    unpricedRequests: total.unpricedRequests,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    models: sortedModels(total.byModel),
    days: Array.from(byDay.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, bucket]) => costDaySummary(day, bucket)),
    pricing: {
      source: pricing.source,
      fetchedAt: pricing.fetchedAt,
    },
  };
}

/** Resolve the devrage-owned cache path for the models.dev catalog. */
export function getPricingCachePath(): string {
  if (process.env["XDG_CACHE_HOME"]) {
    return join(process.env["XDG_CACHE_HOME"], "devrage", "models.dev.json");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "devrage", "models.dev.json");
  }

  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "devrage", "models.dev.json");
  }

  return join(homedir(), ".cache", "devrage", "models.dev.json");
}

function createCostAccumulator(): CostAccumulator {
  return {
    requests: 0,
    estimatedCost: 0,
    billedCost: 0,
    unpricedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    byModel: new Map(),
  };
}

function addUsageToAccumulator(
  bucket: CostAccumulator,
  record: UsageRecord,
  priced: PricedUsage,
  billedCost: number,
  isUnpriced: boolean,
): void {
  const key = `${priced.provider ?? ""}:${priced.model}`;
  let model = bucket.byModel.get(key);

  if (!model) {
    model = {
      model: priced.model,
      provider: priced.provider,
      requests: 0,
      estimatedCost: 0,
      billedCost: 0,
      pricingSource: priced.source,
      unpricedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    bucket.byModel.set(key, model);
  }

  model.requests += 1;
  model.estimatedCost += priced.estimatedCost;
  model.billedCost += billedCost;
  model.pricingSource = mergePricingSource(model.pricingSource, priced.source);
  model.inputTokens += record.inputTokens;
  model.outputTokens += record.outputTokens;
  model.reasoningTokens += record.reasoningTokens;
  model.cacheReadTokens += record.cacheReadTokens;
  model.cacheWriteTokens += record.cacheWriteTokens;

  bucket.requests += 1;
  bucket.estimatedCost += priced.estimatedCost;
  bucket.billedCost += billedCost;
  bucket.inputTokens += record.inputTokens;
  bucket.outputTokens += record.outputTokens;
  bucket.reasoningTokens += record.reasoningTokens;
  bucket.cacheReadTokens += record.cacheReadTokens;
  bucket.cacheWriteTokens += record.cacheWriteTokens;

  if (isUnpriced) {
    model.unpricedRequests += 1;
    bucket.unpricedRequests += 1;
  }
}

function costDaySummary(day: string, bucket: CostAccumulator): CostDaySummary {
  return {
    day,
    requests: bucket.requests,
    estimatedCost: bucket.estimatedCost,
    billedCost: bucket.billedCost,
    unpricedRequests: bucket.unpricedRequests,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    reasoningTokens: bucket.reasoningTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    models: sortedModels(bucket.byModel),
  };
}

function sortedModels(byModel: Map<string, CostModelSummary>): CostModelSummary[] {
  return Array.from(byModel.values()).sort(
    (a, b) => b.estimatedCost - a.estimatedCost || b.requests - a.requests,
  );
}

function timestampDay(timestamp: string | undefined): string | null {
  if (!timestamp) {
    return null;
  }

  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return null;
  }

  return new Date(time).toISOString().slice(0, 10);
}

async function fetchModelsDevCatalog(timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`models.dev returned ${response.status}`);
    }

    const catalog = await response.json();
    if (!isModelsDevCatalog(catalog)) {
      throw new Error("models.dev response did not match expected shape");
    }

    return catalog;
  } finally {
    clearTimeout(timeout);
  }
}

async function readPricingCache(cachePath: string): Promise<PricingCacheFile | null> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const cache = asRecord(parsed);

    if (
      cache?.["source"] !== "models.dev" ||
      cache["schemaVersion"] !== 1 ||
      typeof cache["fetchedAt"] !== "string" ||
      !isModelsDevCatalog(cache["catalog"])
    ) {
      return null;
    }

    return {
      source: "models.dev",
      fetchedAt: cache["fetchedAt"],
      schemaVersion: 1,
      catalog: cache["catalog"],
    };
  } catch {
    return null;
  }
}

async function writePricingCache(cachePath: string, cache: PricingCacheFile): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf-8");
  } catch {
    // Cost estimation can still use the freshly fetched catalog when cache writes fail.
  }
}

function priceUsageRecord(record: UsageRecord, catalog: PricingCatalog): PricedUsage {
  const resolved = resolveRates(record, catalog);
  if (!resolved) {
    return {
      provider: normalizeProvider(record.provider),
      model: normalizeModel(record.model) ?? "unknown",
      estimatedCost: 0,
      source: (record.billedCost ?? 0) > 0 ? "stored" : "unknown",
    };
  }

  const rates = selectContextRates(resolved.rates, record);
  const inputRate = rates.input ?? 0;
  const outputRate = rates.output ?? 0;
  const cacheReadRate = rates.cache_read ?? inputRate;
  const cacheWriteRate = rates.cache_write ?? inputRate;
  const outputTokens = record.outputTokens + record.reasoningTokens;

  return {
    provider: resolved.provider,
    model: resolved.model,
    estimatedCost:
      (record.inputTokens * inputRate +
        record.cacheReadTokens * cacheReadRate +
        record.cacheWriteTokens * cacheWriteRate +
        outputTokens * outputRate) /
      1_000_000,
    source: resolved.source,
  };
}

function resolveRates(record: UsageRecord, pricing: PricingCatalog): ResolvedRates | null {
  const candidates = modelCandidates(record.provider, record.model);

  for (const candidate of candidates) {
    if (!candidate.provider || !pricing.catalog) {
      continue;
    }

    const rates = getCatalogRates(pricing.catalog, candidate.provider, candidate.model);
    if (rates) {
      return {
        provider: candidate.provider,
        model: candidate.model,
        rates,
        source: pricing.source === "stale-catalog" ? "stale-catalog" : "catalog",
      };
    }
  }

  for (const candidate of candidates) {
    if (!candidate.provider) {
      continue;
    }

    const providerRates = FALLBACK_COSTS[candidate.provider];
    const rates = providerRates?.[candidate.model];
    if (rates) {
      return { provider: candidate.provider, model: candidate.model, rates, source: "fallback" };
    }
  }

  return null;
}

function modelCandidates(
  providerInput: string | undefined,
  modelInput: string | undefined,
): { provider?: string; model: string }[] {
  const candidates: { provider?: string; model: string }[] = [];
  let provider = normalizeProvider(providerInput);
  let model = normalizeModel(modelInput);

  if (!model) {
    return candidates;
  }

  const prefixed = splitProviderModel(model);
  if (prefixed) {
    provider = provider ?? prefixed.provider;
    model = prefixed.model;
  }

  addCandidate(candidates, provider, model);
  addCandidate(candidates, provider, MODEL_ALIASES[model]);

  const inferred = provider ?? inferProvider(model);
  addCandidate(candidates, inferred, model);
  addCandidate(candidates, inferred, MODEL_ALIASES[model]);

  for (const fallbackProvider of Object.keys(FALLBACK_COSTS)) {
    addCandidate(candidates, fallbackProvider, model);
    addCandidate(candidates, fallbackProvider, MODEL_ALIASES[model]);
  }

  return candidates;
}

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.5-chat-latest": "gpt-5.5",
};

function addCandidate(
  candidates: { provider?: string; model: string }[],
  provider: string | undefined,
  model: string | undefined,
): void {
  if (!model) {
    return;
  }

  if (
    candidates.some((candidate) => candidate.provider === provider && candidate.model === model)
  ) {
    return;
  }

  candidates.push({ provider, model });
}

function splitProviderModel(model: string): { provider: string; model: string } | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return null;
  }

  const provider = normalizeProvider(model.slice(0, slash));
  const bareModel = normalizeModel(model.slice(slash + 1));
  if (!provider || !bareModel) {
    return null;
  }

  return { provider, model: bareModel };
}

function normalizeProvider(provider: string | undefined): string | undefined {
  if (!provider) {
    return undefined;
  }

  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

function normalizeModel(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  return normalized || undefined;
}

function inferProvider(model: string): string | undefined {
  if (model.startsWith("gpt-") || /^o\d/.test(model)) {
    return "openai";
  }

  if (model.startsWith("claude-")) {
    return "anthropic";
  }

  return undefined;
}

function getCatalogRates(catalog: unknown, provider: string, model: string): RateTable | null {
  const root = asRecord(catalog);
  const providerEntry = asRecord(root?.[provider]);
  const models = asRecord(providerEntry?.["models"]);
  const modelEntry = asRecord(models?.[model]);
  return toRateTable(modelEntry?.["cost"]);
}

function selectContextRates(rates: RateTable, record: UsageRecord): RateTable {
  const contextTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  let selected = rates;
  let selectedSize = 0;

  for (const tier of rates.tiers ?? []) {
    const tierRecord = asRecord(tier);
    const tierInfo = asRecord(tierRecord?.["tier"]);
    const size = typeof tierInfo?.["size"] === "number" ? tierInfo["size"] : 0;
    if (tierInfo?.["type"] !== "context" || contextTokens < size || size < selectedSize) {
      continue;
    }

    const tierRates = toRateTable(tierRecord);
    if (tierRates) {
      selected = { ...rates, ...tierRates };
      selectedSize = size;
    }
  }

  if (selected === rates && rates.context_over_200k && contextTokens > 200_000) {
    selected = { ...rates, ...rates.context_over_200k };
  }

  return selected;
}

function toRateTable(value: unknown): RateTable | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rates: RateTable = {};
  const input = numberValue(record["input"]);
  const output = numberValue(record["output"]);
  const cacheRead = numberValue(record["cache_read"]);
  const cacheWrite = numberValue(record["cache_write"]);
  const contextOver200k = toRateTable(record["context_over_200k"]);

  if (input !== undefined) {
    rates.input = input;
  }
  if (output !== undefined) {
    rates.output = output;
  }
  if (cacheRead !== undefined) {
    rates.cache_read = cacheRead;
  }
  if (cacheWrite !== undefined) {
    rates.cache_write = cacheWrite;
  }
  if (Array.isArray(record["tiers"])) {
    rates.tiers = record["tiers"];
  }
  if (contextOver200k) {
    rates.context_over_200k = contextOver200k;
  }

  return rates.input !== undefined || rates.output !== undefined ? rates : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isModelsDevCatalog(value: unknown): boolean {
  const catalog = asRecord(value);
  const openai = asRecord(catalog?.["openai"]);
  const anthropic = asRecord(catalog?.["anthropic"]);
  return Boolean(asRecord(openai?.["models"]) || asRecord(anthropic?.["models"]));
}

function isFresh(fetchedAt: string, ttlMs: number): boolean {
  const fetchedTime = new Date(fetchedAt).getTime();
  return Number.isFinite(fetchedTime) && Date.now() - fetchedTime <= ttlMs;
}

function mergePricingSource(left: PricingSource, right: PricingSource): PricingSource {
  return left === right ? left : "mixed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
