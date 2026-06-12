import {
  allAdapters,
  createAdapter,
  type CostDaySummary,
  type CostModelSummary,
  type CostSummary,
  type PricingSource,
} from "../adapters/index";
import { detect } from "../detector/index";
import { loadPricingCatalog, summarizeUsage } from "../pricing/index";

// ANSI color helpers — no dependencies needed
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

const SPINNER_MESSAGES = [
  "Tallying the damage",
  "Reviewing your outbursts",
  "Judging your vocabulary",
  "Computing your shame",
  "Cataloging the profanity",
  "Measuring your frustration",
  "Assessing the verbal carnage",
  "Quantifying your displeasure",
  "Auditing your language",
  "Tabulating regrets",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function createSpinner(messages = SPINNER_MESSAGES) {
  let messageIdx = 0;
  let dotCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      messageIdx = Math.floor(Math.random() * messages.length);
      timer = setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        const msg = messages[messageIdx % messages.length];
        const dots = ".".repeat(dotCount || 1);
        process.stdout.write(`\r  ${c.dim}${msg}${dots}${c.reset}   `);
      }, 300);
    },
    update() {
      messageIdx++;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r" + " ".repeat(60) + "\r");
    },
  };
}

interface ScanOptions {
  agent?: string;
  cost?: boolean;
  costOnly?: boolean;
  refreshPrices?: boolean;
  since?: Date;
  rangeLabel?: string;
}

interface CostTotals {
  entries: [string, CostSummary][];
  totalCost: number;
  totalBilled: number;
  totalRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
}

function parseArgs(args: string[]): ScanOptions {
  const options: ScanOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a") {
      options.agent = args[++i];
    } else if (arg === "--cost") {
      options.cost = true;
    } else if (arg === "--refresh-prices") {
      options.refreshPrices = true;
    } else if (arg === "--since" || arg === "-s") {
      const val = args[++i];
      if (val) {
        setAbsoluteSince(options, val);
      }
    } else if (arg === "--day" || arg === "--days") {
      const parsed = readOptionalDaysArg(args, i);
      setRelativeRange(options, parsed.days);
      if (parsed.consumed) {
        i++;
      }
    } else if (arg === "--week") {
      setRelativeRange(options, 7);
    } else if (arg === "--month") {
      setRelativeRange(options, 30);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`devrage scan — scan sessions for profanity

Options:
  --agent, -a <name>   Scan only a specific agent (claude, codex, cursor, opencode, amp, cline, pi, zed)
  --cost               Estimate API-equivalent cost from token usage when available
  --refresh-prices     Refresh models.dev pricing before estimating cost
  --since, -s <date>   Only scan messages after this date (ISO 8601)
  --day, --days [n]    Only scan the last n days (default: 1)
  --week               Only scan the last 7 days
  --month              Only scan the last 30 days
  --help, -h           Show this help`);
      process.exit(0);
    }
  }

  return options;
}

function parseCostArgs(args: string[]): ScanOptions {
  const options: ScanOptions = { cost: true, costOnly: true };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a") {
      options.agent = args[++i];
    } else if (arg === "--refresh-prices") {
      options.refreshPrices = true;
    } else if (arg === "--since" || arg === "-s") {
      const val = args[++i];
      if (val) {
        setAbsoluteSince(options, val);
      }
    } else if (arg === "--day" || arg === "--days") {
      const parsed = readOptionalDaysArg(args, i);
      setRelativeRange(options, parsed.days);
      if (parsed.consumed) {
        i++;
      }
    } else if (arg === "--week") {
      setRelativeRange(options, 7);
    } else if (arg === "--month") {
      setRelativeRange(options, 30);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`devrage cost — show API-equivalent coding agent cost

Usage:
  devrage cost [options]

Options:
  --agent, -a <name>   Show only a specific agent (claude, codex, opencode, amp)
  --refresh-prices     Refresh models.dev pricing before estimating cost
  --since, -s <date>   Only include usage after this date (ISO 8601)
  --day, --days [n]    Only include the last n days (default: 1)
  --week               Only include the last 7 days
  --month              Only include the last 30 days
  --help, -h           Show this help`);
      process.exit(0);
    }
  }

  return options;
}

function setAbsoluteSince(options: ScanOptions, value: string): void {
  options.since = parseDateArg(value);
  options.rangeLabel = undefined;
}

function setRelativeRange(options: ScanOptions, days: number): void {
  options.since = new Date(Date.now() - days * DAY_MS);
  options.rangeLabel = `last ${days} ${days === 1 ? "day" : "days"}`;
}

function readOptionalDaysArg(args: string[], index: number): { days: number; consumed: boolean } {
  const value = args[index + 1];
  if (!value || (value.startsWith("-") && !/^-\d+$/.test(value))) {
    return { days: 1, consumed: false };
  }

  return { days: parseDaysArg(value), consumed: true };
}

function parseDaysArg(value: string | undefined): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`invalid days: ${value ?? ""}`);
    process.exit(1);
  }

  return days;
}

function parseDateArg(value: string): Date {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    console.error(`invalid date: ${value}`);
    process.exit(1);
  }

  return date;
}

export async function scan(args: string[]): Promise<void> {
  const options = parseArgs(args);

  const adapters = options.agent ? [createAdapter(options.agent)] : allAdapters();
  const pricing = options.cost
    ? await loadPricingCatalog({ refresh: options.refreshPrices })
    : null;

  const spinner = createSpinner();
  spinner.start();

  const groupTally: Record<string, number> = {};
  const variantTally: Record<string, Record<string, number>> = {};

  let totalMessages = 0;
  let totalSwears = 0;
  const perAgent: Record<string, { messages: number; swears: number }> = {};
  const costByAgent: Record<string, CostSummary> = {};
  const costUnavailableAgents = new Set<string>();

  for (const adapter of adapters) {
    let agentMessages = 0;
    let agentSwears = 0;
    spinner.update();

    for await (const message of adapter.messages({ since: options.since })) {
      totalMessages++;
      agentMessages++;

      const result = detect(message.text);
      if (result.count > 0) {
        totalSwears += result.count;
        agentSwears += result.count;

        for (const match of result.matches) {
          groupTally[match.group] = (groupTally[match.group] ?? 0) + 1;

          const variants = (variantTally[match.group] ??= {});
          variants[match.word] = (variants[match.word] ?? 0) + 1;
        }
      }
    }

    if (options.cost && adapter.usage && pricing) {
      const summary = await summarizeUsage(adapter.usage({ since: options.since }), pricing);
      if (summary && summary.requests > 0) {
        costByAgent[adapter.name] = summary;
      }
    } else if (options.cost && agentMessages > 0) {
      costUnavailableAgents.add(adapter.name);
    }

    if (agentMessages > 0) {
      perAgent[adapter.name] = { messages: agentMessages, swears: agentSwears };
    }
  }

  spinner.stop();

  const activeAgents = Object.entries(perAgent);
  const costTotals = options.cost ? getCostTotals(costByAgent) : null;

  console.log("");
  printReportHeader(options);

  if (options.cost) {
    if (!costTotals || costTotals.entries.length === 0) {
      printBasicOverview(totalMessages, totalSwears);
      console.log(`  ${c.dim}cost estimate${c.reset}     ${c.gray}unavailable${c.reset}`);
      if (costUnavailableAgents.size > 0) {
        console.log(
          `  ${c.dim}cost unavailable${c.reset} ${Array.from(costUnavailableAgents).sort().join(", ")}`,
        );
      }
    } else {
      printCostOverview(costTotals, totalMessages, totalSwears, costUnavailableAgents);
    }
  } else {
    printBasicOverview(totalMessages, totalSwears);
  }

  if (costTotals && costTotals.entries.length > 0) {
    printCostDashboard(costTotals);
  }

  if (activeAgents.length > 1) {
    console.log("");
    console.log(`  ${sectionTitle("agent language")}`);
    for (const [name, stats] of activeAgents) {
      const rate = ((stats.swears / stats.messages) * 100).toFixed(1);
      console.log(
        `    ${colorText(name.padEnd(10), agentColor(name))} ${c.bold}${String(stats.swears).padStart(4)}${c.reset} ${c.dim}in ${stats.messages} messages (${rate}%)${c.reset}`,
      );
    }
  }

  if (totalSwears > 0) {
    const sorted = Object.entries(groupTally).sort(([, a], [, b]) => b - a);
    console.log("");
    console.log(`  ${sectionTitle("top words")}`);
    for (const [group, count] of sorted.slice(0, 10)) {
      const variants = variantTally[group] ?? {};
      const variantList = Object.entries(variants)
        .sort(([, a], [, b]) => b - a)
        .filter(([v]) => v !== group)
        .slice(0, 15)
        .map(([v, cnt]) => `${c.dim}${v}${c.reset} ${cnt}`)
        .join(`${c.dim},${c.reset} `);
      const suffix = variantList ? ` ${c.dim}(${c.reset}${variantList}${c.dim})${c.reset}` : "";
      console.log(
        `    ${c.yellow}${group.padEnd(12)}${c.reset} ${c.bold}${String(count).padStart(4)}${c.reset}${suffix}`,
      );
    }
  }

  console.log("");
  if (totalSwears === 0) {
    console.log(`  ${c.green}squeaky clean! not a single swear found.${c.reset}`);
    console.log("");
  }
}

export async function cost(args: string[]): Promise<void> {
  const options = parseCostArgs(args);
  const adapters = options.agent ? [createAdapter(options.agent)] : allAdapters();
  const costByAgent: Record<string, CostSummary> = {};

  const pricing = await loadPricingCatalog({ refresh: options.refreshPrices });
  for (const adapter of adapters) {
    if (!adapter.usage) {
      continue;
    }

    const summary = await summarizeUsage(adapter.usage({ since: options.since }), pricing);
    if (summary.requests > 0) {
      costByAgent[adapter.name] = summary;
    }
  }

  const totals = getCostTotals(costByAgent);

  console.log("");
  if (totals.entries.length === 0) {
    printCostCommandUnavailable(options);
    return;
  }

  printCostCommand(totals, options);
}

function printCostCommand(totals: CostTotals, options: ScanOptions): void {
  const modelTotals = aggregateModelCosts(totals.entries);
  const dailyTotals = aggregateDailyCosts(totals.entries);

  printCompactHeader(options);
  console.log(`  ${c.bold}${c.green}${formatCurrency(totals.totalCost)}${c.reset}`);
  console.log(`  ${compactMeta(totals)}`);

  printCompactAgents(totals.entries);
  printCompactModels(modelTotals, totals.totalCost);
  printCompactDaily(dailyTotals);
  console.log("");
}

function printCompactHeader(options: ScanOptions): void {
  const filters = [
    options.agent,
    options.rangeLabel ?? (options.since ? `since ${formatDate(options.since)}` : null),
  ].filter(Boolean);
  const suffix = filters.length > 0 ? ` ${c.dim}${filters.join(" · ")}${c.reset}` : "";
  console.log(`  ${c.bold}${c.red}devrage${c.reset} ${c.dim}cost${c.reset}${suffix}`);
  console.log("");
}

function compactMeta(totals: CostTotals): string {
  const parts = [formatRequests(totals.pricedRequests)];
  if (shouldShowBilledCost(totals.totalCost, totals.totalBilled)) {
    parts.push(`${formatCurrency(totals.totalBilled)} billed`);
  }
  if (totals.unpricedRequests > 0) {
    parts.push(`${formatNumber(totals.unpricedRequests)} unpriced`);
  }

  return `${c.dim}${parts.join(" · ")}${c.reset}`;
}

function printCompactModels(models: CostModelSummary[], totalCost: number): void {
  if (models.length === 0) {
    return;
  }

  const maxCost = models[0]?.estimatedCost ?? 0;
  console.log("");
  console.log(`  ${c.bold}models${c.reset}`);
  for (const model of models) {
    const share = totalCost > 0 ? model.estimatedCost / totalCost : 0;
    const color = modelColor(model);
    console.log(
      `    ${colorText(clip(model.model, 27).padEnd(27), color)} ${formatCurrency(model.estimatedCost).padStart(9)} ${c.dim}${formatPercent(share).padStart(6)}${c.reset}  ${renderBar(model.estimatedCost, maxCost, 16, color)}`,
    );
  }
}

function printCompactDaily(days: CostDaySummary[]): void {
  const visibleDays = days.filter((day) => day.estimatedCost > 0).slice(-10);
  if (visibleDays.length === 0) {
    return;
  }

  const maxCost = Math.max(...visibleDays.map((day) => day.estimatedCost));
  console.log("");
  console.log(`  ${c.bold}daily${c.reset}`);
  for (const day of visibleDays) {
    const color = day.models[0] ? modelColor(day.models[0]) : c.cyan;
    console.log(
      `    ${formatShortDate(day.day).padEnd(6)} ${formatCurrency(day.estimatedCost).padStart(9)}  ${renderBar(day.estimatedCost, maxCost, 16, color)}`,
    );
  }
}

function printCompactAgents(entries: [string, CostSummary][]): void {
  console.log("");
  console.log(`  ${c.bold}agents${c.reset}`);
  for (const [name, stats] of entries.sort(
    ([, left], [, right]) => right.estimatedCost - left.estimatedCost,
  )) {
    const color = agentColor(name);
    console.log(
      `    ${colorText(name.padEnd(10), color)} ${colorText(formatCurrency(stats.estimatedCost).padStart(9), color)} ${c.dim}${formatRequests(stats.requests).padStart(12)}${c.reset}`,
    );
  }
}

function printCostCommandUnavailable(options: ScanOptions): void {
  printCompactHeader(options);
  console.log(`  ${c.gray}no local usage found${c.reset}`);
  console.log("");
}

function printReportHeader(options: ScanOptions): void {
  const scope =
    options.rangeLabel ??
    (options.since ? `since ${formatDate(options.since)}` : "all local history");
  const agent = options.agent ? ` · ${options.agent}` : "";
  const title = options.costOnly ? "cost" : options.cost ? "cost report" : "report";
  console.log(`  ${c.bold}${c.red}devrage${c.reset} ${c.dim}${title}${c.reset}`);
  console.log(`  ${c.dim}${scope}${agent}${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(54)}${c.reset}`);
}

function printBasicOverview(totalMessages: number, totalSwears: number): void {
  console.log(
    `  ${c.dim}messages scanned${c.reset}   ${c.bold}${formatNumber(totalMessages)}${c.reset}`,
  );
  console.log(
    `  ${c.dim}total swears${c.reset}       ${c.bold}${c.red}${formatNumber(totalSwears)}${c.reset}`,
  );
}

function printCostOverview(
  totals: CostTotals,
  totalMessages: number,
  totalSwears: number,
  costUnavailableAgents: Set<string>,
): void {
  console.log(
    `  ${c.bold}${c.green}${formatCurrency(totals.totalCost)}${c.reset} ${c.dim}estimated API-equivalent cost${c.reset}`,
  );
  console.log("");

  const billedLabel =
    totals.entries.length === 1 ? `${totals.entries[0]?.[0]} billed` : "stored billed";
  console.log(`  ${overviewCell("messages scanned", formatNumber(totalMessages))}`);
  console.log(`  ${overviewCell("total swears", formatNumber(totalSwears), c.red)}`);
  console.log(`  ${overviewCell("priced requests", formatNumber(totals.pricedRequests))}`);
  if (shouldShowBilledCost(totals.totalCost, totals.totalBilled)) {
    console.log(`  ${overviewCell(billedLabel, formatCurrency(totals.totalBilled))}`);
  }
  if (totals.unpricedRequests > 0) {
    console.log(`  ${overviewCell("unpriced requests", formatNumber(totals.unpricedRequests))}`);
  }
  if (costUnavailableAgents.size > 0) {
    console.log(
      `  ${c.dim}${"cost unavailable".padEnd(18)}${c.reset}${Array.from(costUnavailableAgents).sort().join(", ")}`,
    );
  }
}

function overviewCell(label: string, value: string, valueColor = c.bold): string {
  return `${c.dim}${label.padEnd(18)}${c.reset}${valueColor}${value}${c.reset}`;
}

function getCostTotals(costByAgent: Record<string, CostSummary>): CostTotals {
  const entries = Object.entries(costByAgent);
  const totalCost = entries.reduce((sum, [, stats]) => sum + stats.estimatedCost, 0);
  const totalBilled = entries.reduce((sum, [, stats]) => sum + stats.billedCost, 0);
  const totalRequests = entries.reduce((sum, [, stats]) => sum + stats.requests, 0);
  const unpricedRequests = entries.reduce((sum, [, stats]) => sum + stats.unpricedRequests, 0);

  return {
    entries,
    totalCost,
    totalBilled,
    totalRequests,
    pricedRequests: totalRequests - unpricedRequests,
    unpricedRequests,
  };
}

function printCostDashboard(totals: CostTotals): void {
  const modelTotals = aggregateModelCosts(totals.entries);
  const dailyTotals = aggregateDailyCosts(totals.entries);

  console.log("");
  console.log(`  ${sectionTitle("cost dashboard")}`);
  printModelMix(modelTotals, totals.totalCost);
  printDailySpend(dailyTotals);

  console.log("");
  console.log(`  ${sectionTitle("agent cost")}`);
  for (const [name, stats] of totals.entries) {
    const color = agentColor(name);
    console.log(
      `    ${colorText(name.padEnd(10), color)} ${c.bold}${formatCurrency(stats.estimatedCost).padStart(8)}${c.reset} ${c.dim}in ${formatNumber(stats.requests)} requests${c.reset}`,
    );
    if (stats.pricing.source !== "catalog") {
      const source =
        stats.pricing.source === "stale-catalog" ? "stale models.dev cache" : "fallback rates";
      console.log(`      ${c.dim}pricing:${c.reset} ${source}`);
    }

    for (const model of stats.models) {
      const source = pricingSourceLabel(model.pricingSource);
      const billed = shouldShowBilledCost(model.estimatedCost, model.billedCost)
        ? ` ${c.dim}billed ${formatCurrency(model.billedCost)}${c.reset}`
        : "";
      console.log(
        `      ${colorText(model.model.padEnd(22), modelColor(model))} ${formatCurrency(model.estimatedCost).padStart(8)} ${c.dim}${formatNumber(model.requests)} requests${source}${c.reset}${billed}`,
      );
    }

    const unpriced = stats.models.filter((model) => model.unpricedRequests > 0);
    if (unpriced.length > 0) {
      const unpricedList = unpriced
        .slice(0, 3)
        .map((model) => `${model.model} ${formatNumber(model.unpricedRequests)}`)
        .join(`${c.dim},${c.reset} `);
      console.log(`      ${c.dim}unpriced:${c.reset} ${unpricedList}`);
    }
  }
}

function printModelMix(models: CostModelSummary[], totalCost: number): void {
  if (models.length === 0) {
    return;
  }

  const maxCost = models[0]?.estimatedCost ?? 0;
  console.log(`    ${c.bold}model mix${c.reset}`);
  console.log(
    `      ${c.dim}${"model".padEnd(26)} ${"cost".padStart(9)} ${"share".padStart(6)} ${"requests".padStart(10)}  spend${c.reset}`,
  );
  for (const model of models) {
    const share = totalCost > 0 ? model.estimatedCost / totalCost : 0;
    const color = modelColor(model);
    console.log(
      `      ${colorText(clip(model.model, 26).padEnd(26), color)} ${formatCurrency(model.estimatedCost).padStart(9)} ${c.dim}${formatPercent(share).padStart(6)} ${formatNumber(model.requests).padStart(10)}${c.reset}  ${renderBar(model.estimatedCost, maxCost, 18, color)}`,
    );
  }
}

function printDailySpend(days: CostDaySummary[]): void {
  const pricedDays = days.filter((day) => day.estimatedCost > 0);
  if (pricedDays.length === 0) {
    return;
  }

  const visibleDays = pricedDays.slice(-14);
  const maxCost = Math.max(...visibleDays.map((day) => day.estimatedCost));
  console.log("");
  console.log(
    `    ${c.bold}daily spend${c.reset} ${c.dim}(last ${visibleDays.length} active days)${c.reset}`,
  );
  console.log(
    `      ${c.dim}${"date".padEnd(10)} ${"cost".padStart(9)}  spend${"".padEnd(15)} top model${c.reset}`,
  );
  for (const day of visibleDays) {
    const topModel = day.models[0];
    const color = topModel ? modelColor(topModel) : c.cyan;
    const topModelText = topModel
      ? `${topModel.model} ${formatCurrency(topModel.estimatedCost)}`
      : `${formatNumber(day.requests)} reqs`;
    console.log(
      `      ${day.day} ${formatCurrency(day.estimatedCost).padStart(9)}  ${renderBar(day.estimatedCost, maxCost, 18, color)} ${c.dim}${clip(topModelText, 34)}${c.reset}`,
    );
  }
}

function aggregateModelCosts(entries: [string, CostSummary][]): CostModelSummary[] {
  const models = new Map<string, CostModelSummary>();

  for (const [, stats] of entries) {
    for (const model of stats.models) {
      mergeModelSummary(models, model);
    }
  }

  return sortedCostModels(models);
}

interface DailyCostAccumulator {
  day: string;
  requests: number;
  estimatedCost: number;
  billedCost: number;
  unpricedRequests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  models: Map<string, CostModelSummary>;
}

function aggregateDailyCosts(entries: [string, CostSummary][]): CostDaySummary[] {
  const days = new Map<string, DailyCostAccumulator>();

  for (const [, stats] of entries) {
    for (const day of stats.days) {
      let bucket = days.get(day.day);
      if (!bucket) {
        bucket = {
          day: day.day,
          requests: 0,
          estimatedCost: 0,
          billedCost: 0,
          unpricedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          models: new Map(),
        };
        days.set(day.day, bucket);
      }

      bucket.requests += day.requests;
      bucket.estimatedCost += day.estimatedCost;
      bucket.billedCost += day.billedCost;
      bucket.unpricedRequests += day.unpricedRequests;
      bucket.inputTokens += day.inputTokens;
      bucket.outputTokens += day.outputTokens;
      bucket.reasoningTokens += day.reasoningTokens;
      bucket.cacheReadTokens += day.cacheReadTokens;
      bucket.cacheWriteTokens += day.cacheWriteTokens;

      for (const model of day.models) {
        mergeModelSummary(bucket.models, model);
      }
    }
  }

  return Array.from(days.values())
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((day) => ({
      day: day.day,
      requests: day.requests,
      estimatedCost: day.estimatedCost,
      billedCost: day.billedCost,
      unpricedRequests: day.unpricedRequests,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      reasoningTokens: day.reasoningTokens,
      cacheReadTokens: day.cacheReadTokens,
      cacheWriteTokens: day.cacheWriteTokens,
      models: sortedCostModels(day.models),
    }));
}

function mergeModelSummary(
  models: Map<string, CostModelSummary>,
  incoming: CostModelSummary,
): void {
  const key = incoming.model;
  let model = models.get(key);

  if (!model) {
    models.set(key, { ...incoming });
    return;
  }

  model.requests += incoming.requests;
  model.estimatedCost += incoming.estimatedCost;
  model.billedCost += incoming.billedCost;
  model.pricingSource = mergeDisplayPricingSource(model.pricingSource, incoming.pricingSource);
  model.unpricedRequests += incoming.unpricedRequests;
  model.inputTokens += incoming.inputTokens;
  model.outputTokens += incoming.outputTokens;
  model.reasoningTokens += incoming.reasoningTokens;
  model.cacheReadTokens += incoming.cacheReadTokens;
  model.cacheWriteTokens += incoming.cacheWriteTokens;
}

function sortedCostModels(models: Map<string, CostModelSummary>): CostModelSummary[] {
  return Array.from(models.values()).sort(
    (left, right) => right.estimatedCost - left.estimatedCost || right.requests - left.requests,
  );
}

function mergeDisplayPricingSource(left: PricingSource, right: PricingSource): PricingSource {
  return left === right ? left : "mixed";
}

function sectionTitle(label: string): string {
  const width = 54;
  const lineLength = Math.max(4, width - label.length - 1);
  return `${c.bold}${label}${c.reset} ${c.dim}${"─".repeat(lineLength)}${c.reset}`;
}

function colorText(value: string, color: string): string {
  return `${color}${value}${c.reset}`;
}

function agentColor(agent: string): string {
  switch (agent) {
    case "claude":
      return c.magenta;
    case "codex":
      return c.green;
    case "opencode":
      return c.cyan;
    case "amp":
      return c.yellow;
    case "cursor":
      return c.blue;
    default:
      return c.white;
  }
}

function modelColor(model: CostModelSummary): string {
  const provider = model.provider?.toLowerCase();
  const modelName = model.model.toLowerCase();

  if (provider === "anthropic" || modelName.startsWith("claude-")) {
    return c.magenta;
  }
  if (provider === "openai" || modelName.startsWith("gpt-") || /^o\d/.test(modelName)) {
    return c.green;
  }
  if (provider === "google" || modelName.startsWith("gemini-")) {
    return c.blue;
  }
  if (modelName.startsWith("kimi-") || modelName.startsWith("glm-")) {
    return c.yellow;
  }

  return c.cyan;
}

function renderBar(value: number, max: number, width: number, color = c.cyan): string {
  const filled = max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * width)) : 0;
  const empty = width - filled;
  return `${color}${"━".repeat(filled)}${c.gray}${"─".repeat(empty)}${c.reset}`;
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function formatCurrency(value: number): string {
  const cents = Math.floor(Math.max(0, value) * 100 + 1e-9);
  return `$${(cents / 100).toFixed(2)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatRequests(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "req" : "reqs"}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatShortDate(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (isNaN(date.getTime())) {
    return day;
  }

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function shouldShowBilledCost(estimatedCost: number, billedCost: number): boolean {
  return formatCurrency(estimatedCost) !== formatCurrency(billedCost);
}

function pricingSourceLabel(source: string): string {
  switch (source) {
    case "catalog":
      return " catalog";
    case "stale-catalog":
      return " stale";
    case "fallback":
      return " fallback";
    case "stored":
      return " billed only";
    case "unknown":
      return " unpriced";
    case "mixed":
      return " mixed";
    default:
      return "";
  }
}
