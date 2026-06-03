import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  allAdapters,
  createAdapter,
  type CostModelSummary,
  type CostSummary,
  type PricingSource,
} from "../adapters/index";
import { detect } from "../detector/index";
import { getPricingCachePath, loadPricingCatalog, summarizeUsage } from "../pricing/index";

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

const MAX_TERMINAL_MODELS = 10;

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

const COST_SPINNER_MESSAGES = [
  "Loading price catalog",
  "Reading local usage",
  "Scanning transcript stores",
  "Crunching token counts",
  "Still working through local history",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTOGRAM_HEIGHT = 10;
const HISTOGRAM_INDENT = "    ";
const DEFAULT_TERMINAL_WIDTH = 80;
const YEAR_GRID_DAYS = 365;
const YEAR_GRID_ROWS = 7;
const YEAR_GRID_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const YEAR_GRID_DAY_LABEL_WIDTH = 3;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const RAGE_COLORS = ["\x1b[38;5;52m", "\x1b[38;5;88m", "\x1b[38;5;160m", "\x1b[38;5;196m"];

function createSpinner(messages = SPINNER_MESSAGES) {
  let messageIdx = 0;
  let dotCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let messageOverride: string | null = null;

  function render() {
    dotCount = (dotCount + 1) % 4;
    const msg = messageOverride ?? messages[messageIdx % messages.length];
    const dots = ".".repeat(dotCount || 1);
    process.stdout.write(`\r  ${c.dim}${msg}${dots}${c.reset}   `);
  }

  return {
    start(message?: string) {
      messageIdx = Math.floor(Math.random() * messages.length);
      messageOverride = message ?? null;
      render();
      timer = setInterval(() => {
        render();
      }, 300);
    },
    update(message?: string) {
      if (message) {
        messageOverride = message;
      } else {
        messageOverride = null;
        messageIdx++;
      }
      render();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r" + " ".repeat(80) + "\r");
    },
  };
}

interface ScanOptions {
  agent?: string;
  refreshPrices?: boolean;
  since?: Date;
  rangeLabel?: string;
}

interface CostTotals {
  entries: [string, CostSummary][];
  totalCost: number;
  totalRequests: number;
  pricedRequests: number;
  unpricedRequests: number;
}

interface CostReportModel {
  model: string;
  provider?: string;
  estimatedCost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface CostReportDay {
  day: string;
  estimatedCost: number;
  requests: number;
  models: CostReportModel[];
}

interface CostReportAgent {
  name: string;
  estimatedCost: number;
  requests: number;
  models: CostReportModel[];
  days: CostReportDay[];
}

interface CostReportData {
  generatedAt: string;
  scope: string;
  totalCost: number;
  pricedRequests: number;
  unpricedRequests: number;
  agents: CostReportAgent[];
}

interface HistogramData {
  buckets: HistogramBucket[];
  barPositions: number[];
  chartWidth: number;
  xLabels: HistogramLabel[];
  totalBuckets: number;
  visibleBuckets: number;
  max: number;
  unit: string;
}

interface HistogramBucket {
  messages: number;
  rageMessages: number;
}

interface HistogramLabel {
  label: string;
  position: number;
}

interface DayStats {
  messages: number;
  rageMessages: number;
  swears: number;
}

interface YearGridData {
  rows: string[];
  monthLabels: string;
  visibleDays: number;
  totalDays: number;
  startLabel: string;
  endLabel: string;
  maxSwears: number;
}

function parseArgs(args: string[]): ScanOptions {
  const options: ScanOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" || arg === "-a") {
      options.agent = args[++i];
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
  --agent, -a <name>   Scan only a specific agent (claude, codex, cursor, grok, opencode, amp, cline, pi, t3code, zed)
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
  const options: ScanOptions = {};

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
  --agent, -a <name>   Show only a specific agent (claude, codex, cursor, opencode, amp, pi, t3code)
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

  const spinner = createSpinner();
  spinner.start();

  const groupTally: Record<string, number> = {};
  const variantTally: Record<string, Record<string, number>> = {};
  const dayStats = new Map<string, DayStats>();

  let totalMessages = 0;
  let totalSwears = 0;
  const perAgent: Record<string, { messages: number; swears: number }> = {};

  for (const adapter of adapters) {
    let agentMessages = 0;
    let agentSwears = 0;
    spinner.update();

    for await (const message of adapter.messages({ since: options.since })) {
      totalMessages++;
      agentMessages++;

      const result = detect(message.text);
      addDayStats(message.timestamp, result.count, dayStats);
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

    if (agentMessages > 0) {
      perAgent[adapter.name] = { messages: agentMessages, swears: agentSwears };
    }
  }

  spinner.stop();

  const activeAgents = Object.entries(perAgent);

  console.log("");
  printReportHeader(options);
  printBasicOverview(totalMessages, totalSwears);

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

    printTimeCharts(dayStats);
  }

  console.log("");
  if (totalSwears === 0) {
    console.log(`  ${c.green}squeaky clean! not a single swear found.${c.reset}`);
    console.log("");
  }
}

function addDayStats(
  timestamp: string | undefined,
  swearCount: number,
  dayStats: Map<string, DayStats>,
): void {
  const date = parseTimestamp(timestamp);
  if (!date) {
    return;
  }

  const day = dayKey(date);
  const stats = dayStats.get(day) ?? {
    messages: 0,
    rageMessages: 0,
    swears: 0,
  };
  stats.messages++;

  if (swearCount > 0) {
    stats.rageMessages++;
    stats.swears += swearCount;
  }

  dayStats.set(day, stats);
}

function printTimeCharts(dayStats: Map<string, DayStats>): void {
  const width = terminalWidth();
  const day = buildDayHistogram(dayStats, width);
  const year = buildYearGrid(dayStats, width);

  if (day) {
    printHistogram("by day", day);
  }

  if (year) {
    printYearGrid(year);
  }
}

function printHistogram(title: string, histogram: HistogramData): void {
  const bucketLabel =
    histogram.totalBuckets > histogram.visibleBuckets
      ? `last ${histogram.visibleBuckets} of ${histogram.totalBuckets} ${pluralize(histogram.unit, histogram.totalBuckets)}`
      : `${histogram.visibleBuckets} ${pluralize(histogram.unit, histogram.visibleBuckets)}`;
  const yAxisWidth = yAxisLabelWidth(histogram.max);

  console.log("");
  console.log(`  ${sectionTitle(title)}`);
  for (let row = 0; row < HISTOGRAM_HEIGHT; row++) {
    const yLabel = yAxisLabel(row, histogram.max).padStart(yAxisWidth);
    const bars = histogramRow(histogram, row);
    console.log(`${HISTOGRAM_INDENT}${c.dim}${yLabel}${c.reset} ${c.dim}│${c.reset}${bars}`);
  }
  console.log(
    `${HISTOGRAM_INDENT}${c.dim}${"0".padStart(yAxisWidth)} └${"─".repeat(histogram.chartWidth)}${c.reset}`,
  );
  console.log(
    `${HISTOGRAM_INDENT}${" ".repeat(yAxisWidth + 2)}${c.dim}${formatXAxisLabels(histogram.chartWidth, histogram.xLabels)}${c.reset}`,
  );
  console.log(
    `${HISTOGRAM_INDENT}${c.dim}${bucketLabel}; max ${histogram.max} messages/${histogram.unit}; red rage, gray other${c.reset}`,
  );
}

function buildDayHistogram(statsByDay: Map<string, DayStats>, width: number): HistogramData | null {
  const keys = [...statsByDay.keys()].sort();
  const firstKey = keys[0];
  const lastKey = keys.at(-1);
  if (!firstKey || !lastKey) {
    return null;
  }

  const first = dateFromDayKey(firstKey);
  const last = dateFromDayKey(lastKey);
  const totalBuckets = daysBetween(first, last) + 1;
  const max = Math.max(...[...statsByDay.values()].map((stats) => stats.messages));
  const chartWidth = maxHistogramWidth(width, yAxisLabelWidth(max));
  const visibleBuckets = Math.min(totalBuckets, chartWidth);
  const start = totalBuckets > visibleBuckets ? addDays(last, -(visibleBuckets - 1)) : first;
  const dates = Array.from({ length: visibleBuckets }, (_, index) => addDays(start, index));
  const buckets = dates.map((date) => statsByDay.get(dayKey(date)) ?? emptyDayStats());
  const labels = dates.map(formatShortDate);

  return buildHistogramData(labels, buckets, totalBuckets, "day", chartWidth);
}

function buildHistogramData(
  labels: string[],
  buckets: HistogramBucket[],
  totalBuckets: number,
  unit: string,
  maxWidth: number,
): HistogramData {
  const max = Math.max(...buckets.map((bucket) => bucket.messages));
  const chartWidth = Math.min(maxWidth, Math.max(buckets.length, minimumLabelWidth(labels)));
  const barPositions = spreadPositions(buckets.length, chartWidth);

  return {
    buckets,
    barPositions,
    chartWidth,
    xLabels: xAxisLabels(labels, barPositions),
    totalBuckets,
    visibleBuckets: buckets.length,
    max,
    unit,
  };
}

function histogramRow(histogram: HistogramData, row: number): string {
  const cells = Array.from({ length: histogram.chartWidth }, () => " ");

  for (let index = 0; index < histogram.buckets.length; index++) {
    const bucket = histogram.buckets[index] ?? emptyDayStats();
    const position = histogram.barPositions[index] ?? index;
    cells[position] = histogramCell(bucket, histogram.max, row);
  }

  return cells.join("");
}

function histogramCell(bucket: HistogramBucket, max: number, row: number): string {
  if (bucket.messages <= 0 || max <= 0) {
    return " ";
  }

  const barHeight = Math.ceil((bucket.messages / max) * HISTOGRAM_HEIGHT);
  const rageHeight = Math.ceil((bucket.rageMessages / max) * HISTOGRAM_HEIGHT);
  const threshold = HISTOGRAM_HEIGHT - row;
  if (barHeight < threshold) {
    return " ";
  }

  return rageHeight >= threshold ? `${c.red}█${c.reset}` : `${c.gray}█${c.reset}`;
}

function buildYearGrid(statsByDay: Map<string, DayStats>, width: number): YearGridData | null {
  if (statsByDay.size === 0) {
    return null;
  }

  const today = startOfDay(new Date());
  const fullStart = addDays(today, -(YEAR_GRID_DAYS - 1));
  const alignedStart = startOfWeek(fullStart);
  const totalColumns = Math.floor(daysBetween(alignedStart, today) / YEAR_GRID_ROWS) + 1;
  const visibleColumns = Math.min(totalColumns, maxYearGridColumns(width));
  const start = addDays(alignedStart, (totalColumns - visibleColumns) * YEAR_GRID_ROWS);
  const firstVisibleDay = maxDate(start, fullStart);
  const visibleDays = daysBetween(firstVisibleDay, today) + 1;
  const maxSwears = maxVisibleSwears(statsByDay, firstVisibleDay, visibleDays);

  const rows = Array.from({ length: YEAR_GRID_ROWS }, (_, row) => {
    const cells = Array.from({ length: visibleColumns }, (_, column) => {
      const date = addDays(start, column * YEAR_GRID_ROWS + row);
      if (date < fullStart || date > today) {
        return " ";
      }

      const stats = statsByDay.get(dayKey(date));
      return yearGridCell(stats?.swears ?? 0, maxSwears);
    });

    return cells.join("");
  });

  return {
    rows,
    monthLabels: buildYearGridMonthLabels(start, visibleColumns, fullStart, today),
    visibleDays,
    totalDays: YEAR_GRID_DAYS,
    startLabel: formatShortDate(firstVisibleDay),
    endLabel: formatShortDate(today),
    maxSwears,
  };
}

function printYearGrid(grid: YearGridData): void {
  const rangeLabel =
    grid.visibleDays < grid.totalDays
      ? `last ${grid.visibleDays} of ${grid.totalDays} days`
      : `${grid.totalDays} days`;

  console.log("");
  console.log(`  ${sectionTitle("past year")}`);
  console.log(
    `${HISTOGRAM_INDENT}${" ".repeat(YEAR_GRID_DAY_LABEL_WIDTH + 1)}${c.dim}${grid.monthLabels}${c.reset}`,
  );
  for (let index = 0; index < grid.rows.length; index++) {
    const dayLabel = YEAR_GRID_DAY_LABELS[index] ?? "";
    console.log(
      `${HISTOGRAM_INDENT}${c.dim}${dayLabel.padEnd(YEAR_GRID_DAY_LABEL_WIDTH)}${c.reset} ${grid.rows[index] ?? ""}`,
    );
  }
  console.log(
    `${HISTOGRAM_INDENT}${" ".repeat(YEAR_GRID_DAY_LABEL_WIDTH + 1)}${c.dim}${grid.startLabel} - ${grid.endLabel}; ${rangeLabel}; max ${grid.maxSwears} swears/day${c.reset}`,
  );
}

function buildYearGridMonthLabels(
  start: Date,
  columns: number,
  fullStart: Date,
  today: Date,
): string {
  const chars = Array.from({ length: columns }, () => " ");
  let previousMonth: number | null = null;

  for (let column = 0; column < columns; column++) {
    const firstDate = firstVisibleDateInWeek(
      addDays(start, column * YEAR_GRID_ROWS),
      fullStart,
      today,
    );
    if (!firstDate) {
      continue;
    }

    const month = firstDate.getMonth();
    if (month === previousMonth) {
      continue;
    }
    previousMonth = month;

    const label = MONTH_LABELS[month] ?? "";
    if (!label || column + label.length > columns) {
      continue;
    }

    if (overlapsLabel(chars, column, label.length)) {
      continue;
    }

    for (let index = 0; index < label.length; index++) {
      chars[column + index] = label.charAt(index);
    }
  }

  return chars.join("").trimEnd();
}

function firstVisibleDateInWeek(weekStart: Date, fullStart: Date, today: Date): Date | null {
  for (let offset = 0; offset < YEAR_GRID_ROWS; offset++) {
    const date = addDays(weekStart, offset);
    if (date >= fullStart && date <= today) {
      return date;
    }
  }

  return null;
}

function maxVisibleSwears(
  statsByDay: Map<string, DayStats>,
  start: Date,
  visibleDays: number,
): number {
  let max = 0;
  for (let index = 0; index < visibleDays; index++) {
    const stats = statsByDay.get(dayKey(addDays(start, index)));
    max = Math.max(max, stats?.swears ?? 0);
  }

  return max;
}

function yearGridCell(swears: number, maxSwears: number): string {
  if (swears <= 0 || maxSwears <= 0) {
    return `${c.gray}■${c.reset}`;
  }

  const index = Math.ceil((swears / maxSwears) * RAGE_COLORS.length) - 1;
  return `${RAGE_COLORS[index] ?? c.red}■${c.reset}`;
}

function maxYearGridColumns(width: number): number {
  return Math.max(1, width - HISTOGRAM_INDENT.length - YEAR_GRID_DAY_LABEL_WIDTH - 1);
}

function maxHistogramWidth(width: number, yAxisWidth: number): number {
  const reserved = HISTOGRAM_INDENT.length + yAxisWidth + 2;
  return Math.max(1, width - reserved);
}

function yAxisLabel(row: number, max: number): string {
  if (row === 0) {
    return String(max);
  }

  const midpoint = Math.floor(HISTOGRAM_HEIGHT / 2);
  if (row === midpoint) {
    const value = Math.ceil(max / 2);
    return value === max ? "" : String(value);
  }

  return "";
}

function yAxisLabelWidth(max: number): number {
  return Math.max(1, String(max).length);
}

function xAxisLabels(labels: string[], positions: number[]): HistogramLabel[] {
  if (labels.length === 0) {
    return [];
  }
  if (labels.length === 1) {
    return [{ label: labels[0]!, position: positions[0] ?? 0 }];
  }

  const lastIndex = labels.length - 1;
  const result: HistogramLabel[] = [
    { label: labels[0]!, position: positions[0] ?? 0 },
    { label: labels[lastIndex]!, position: positions[lastIndex] ?? lastIndex },
  ];

  if (labels.length >= 15) {
    const middleIndex = Math.floor(lastIndex / 2);
    result.push({
      label: labels[middleIndex]!,
      position: positions[middleIndex] ?? middleIndex,
    });
  }

  return result;
}

function spreadPositions(count: number, width: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [Math.floor(width / 2)];
  }

  return Array.from({ length: count }, (_, index) =>
    Math.round((index * (width - 1)) / (count - 1)),
  );
}

function minimumLabelWidth(labels: string[]): number {
  if (labels.length === 0) {
    return 1;
  }
  if (labels.length === 1) {
    return labels[0]!.length;
  }

  const first = labels[0]!;
  const last = labels[labels.length - 1]!;
  if (labels.length < 15) {
    return first.length + 1 + last.length;
  }

  const middle = labels[Math.floor((labels.length - 1) / 2)]!;
  return first.length + middle.length + last.length + 2;
}

function formatXAxisLabels(width: number, labels: HistogramLabel[]): string {
  const chars = Array.from({ length: width }, () => " ");
  let placed = 0;

  for (const label of labels) {
    if (label.label.length > width) {
      continue;
    }

    const start = Math.max(
      0,
      Math.min(width - label.label.length, label.position - Math.floor(label.label.length / 2)),
    );
    if (start < 0 || overlapsLabel(chars, start, label.label.length)) {
      continue;
    }

    for (let index = 0; index < label.label.length; index++) {
      chars[start + index] = label.label.charAt(index);
    }
    placed++;
  }

  if (placed < Math.min(2, labels.length)) {
    return labels.map((label) => label.label).join(" ");
  }

  return chars.join("").trimEnd();
}

function overlapsLabel(chars: string[], start: number, length: number): boolean {
  const end = Math.min(chars.length, start + length);
  for (let index = Math.max(0, start - 1); index < end + 1; index++) {
    if (chars[index] && chars[index] !== " ") {
      return true;
    }
  }

  return false;
}

function emptyDayStats(): DayStats {
  return {
    messages: 0,
    rageMessages: 0,
    swears: 0,
  };
}

function terminalWidth(): number {
  const columns = process.stdout.columns;
  if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) {
    return Math.floor(columns);
  }

  return DEFAULT_TERMINAL_WIDTH;
}

function parseTimestamp(timestamp: string | undefined): Date | null {
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function dayKey(date: Date): string {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatShortDate(date: Date): string {
  return [
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("/");
}

function dateFromDayKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

function daysBetween(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / DAY_MS);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  return addDays(date, -date.getDay());
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function pluralize(unit: string, count: number): string {
  return count === 1 ? unit : `${unit}s`;
}

export async function cost(args: string[]): Promise<void> {
  const options = parseCostArgs(args);
  const adapters = options.agent ? [createAdapter(options.agent)] : allAdapters();
  const costByAgent: Record<string, CostSummary> = {};
  const spinner = createSpinner(COST_SPINNER_MESSAGES);
  let totals: CostTotals | null = null;

  spinner.start("Loading price catalog");
  try {
    const pricing = await loadPricingCatalog({ refresh: options.refreshPrices });
    for (const adapter of adapters) {
      if (!adapter.usage) {
        continue;
      }

      spinner.update(`Reading ${adapter.name} usage`);
      const summary = await summarizeUsage(adapter.usage({ since: options.since }), pricing);
      if (summary.requests > 0) {
        costByAgent[adapter.name] = summary;
      }
    }

    totals = getCostTotals(costByAgent);
  } finally {
    spinner.stop();
  }

  if (!totals || totals.entries.length === 0) {
    console.log("");
    printCostCommandUnavailable(options);
    return;
  }

  spinner.start("Writing cost report");
  let reportUrl: string;
  try {
    reportUrl = await writeCostHtmlReport(totals, options);
  } finally {
    spinner.stop();
  }

  console.log("");
  printCostCommand(totals, options, reportUrl);
}

function printCostCommand(totals: CostTotals, options: ScanOptions, reportUrl: string): void {
  const modelTotals = aggregateModelCosts(totals.entries);

  printCompactHeader(options);
  printCompactTotal(totals);
  printCompactAgents(totals.entries);
  printCompactModels(modelTotals, totals.totalCost);
  console.log("");
  console.log(`  ${c.dim}Report:${c.reset} ${reportUrl}`);
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
  if (totals.unpricedRequests > 0) {
    parts.push(`${formatNumber(totals.unpricedRequests)} unpriced`);
  }

  return `${c.dim}${parts.join(" · ")}${c.reset}`;
}

function printCompactTotal(totals: CostTotals): void {
  console.log(`  ${c.bold}total${c.reset}`);
  console.log(
    `    ${c.bold}${c.green}${formatCurrency(totals.totalCost)}${c.reset}  ${compactMeta(totals)}`,
  );
}

function printCompactModels(models: CostModelSummary[], totalCost: number): void {
  if (models.length === 0) {
    return;
  }

  const visibleModels = models.slice(0, MAX_TERMINAL_MODELS);
  const maxCost = visibleModels[0]?.estimatedCost ?? 0;
  console.log("");
  console.log(`  ${c.bold}models${c.reset}`);
  for (const model of visibleModels) {
    const share = totalCost > 0 ? model.estimatedCost / totalCost : 0;
    const color = modelColor(model);
    console.log(
      `    ${colorText(clip(model.model, 27).padEnd(27), color)} ${formatCurrency(model.estimatedCost).padStart(9)} ${c.dim}${formatPercent(share).padStart(6)}${c.reset}  ${renderBar(model.estimatedCost, maxCost, 16, color)}`,
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

async function writeCostHtmlReport(totals: CostTotals, options: ScanOptions): Promise<string> {
  const generatedAt = new Date().toISOString();
  const reportPath = join(
    dirname(getPricingCachePath()),
    `cost-report-${safeTimestamp(generatedAt)}.html`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderCostHtmlReport(costReportData(totals, options, generatedAt)),
    "utf-8",
  );
  return pathToFileURL(reportPath).href;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function costReportData(
  totals: CostTotals,
  options: ScanOptions,
  generatedAt: string,
): CostReportData {
  return {
    generatedAt,
    scope:
      options.rangeLabel ??
      (options.since ? `since ${formatDate(options.since)}` : "all local history"),
    totalCost: totals.totalCost,
    pricedRequests: totals.pricedRequests,
    unpricedRequests: totals.unpricedRequests,
    agents: totals.entries
      .map(([name, summary]) => ({
        name,
        estimatedCost: summary.estimatedCost,
        requests: summary.requests - summary.unpricedRequests,
        models: summary.models.map(costReportModel),
        days: summary.days.map((day) => ({
          day: day.day,
          estimatedCost: day.estimatedCost,
          requests: day.requests - day.unpricedRequests,
          models: day.models.map(costReportModel),
        })),
      }))
      .sort((left, right) => right.estimatedCost - left.estimatedCost),
  };
}

function costReportModel(model: CostModelSummary): CostReportModel {
  return {
    model: model.model,
    provider: model.provider,
    estimatedCost: model.estimatedCost,
    requests: model.requests - model.unpricedRequests,
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    reasoningTokens: model.reasoningTokens,
    cacheReadTokens: model.cacheReadTokens,
    cacheWriteTokens: model.cacheWriteTokens,
  };
}

function renderCostHtmlReport(data: CostReportData): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>devrage cost report</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1117;
      --panel: #151923;
      --panel-2: #10141c;
      --border: #283040;
      --text: #edf1f7;
      --muted: #99a3b5;
      --faint: #677184;
      --green: #55c98f;
      --purple: #b18cff;
      --blue: #75a7ff;
      --yellow: #e5b75f;
      --cyan: #62c7df;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    header { display: flex; justify-content: space-between; gap: 20px; align-items: end; margin-bottom: 22px; }
    h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    .scope { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .generated { color: var(--faint); font-size: 12px; text-align: right; }
    .summary { display: grid; grid-template-columns: 1.4fr repeat(3, 1fr); gap: 12px; margin-bottom: 18px; }
    .card, .panel { border: 1px solid var(--border); background: var(--panel); }
    .card { padding: 16px; min-height: 92px; }
    .label { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
    .value { margin-top: 8px; font-size: 26px; font-weight: 800; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
    .primary .value { color: var(--green); font-size: 42px; }
    .controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    select { width: 100%; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); padding: 10px 12px; font: inherit; border-radius: 0; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }
    .panel { min-width: 0; }
    .panel h2 { margin: 0; padding: 13px 14px; border-bottom: 1px solid var(--border); font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
    .panel-body { padding: 14px; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #202838; text-align: left; white-space: nowrap; }
    th { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    td:not(:first-child), th:not(:first-child) { text-align: right; }
    tr:last-child td { border-bottom: 0; }
    .name { color: var(--text); font-weight: 650; }
    .muted { color: var(--muted); }
    .chart-wrap { min-width: 0; }
    .chart { width: 100%; min-width: 0; height: 190px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: clamp(1px, 0.55vw, 8px); align-items: end; overflow: hidden; }
    .bar-column { display: flex; align-items: end; min-width: 0; height: 190px; overflow: hidden; font-variant-numeric: tabular-nums; }
    .chart-empty { align-self: center; }
    .axis { position: relative; height: 24px; margin-top: 8px; border-top: 1px solid #202838; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; overflow: hidden; }
    .axis-tick { position: absolute; top: 6px; transform: translateX(-50%); white-space: nowrap; }
    .axis-tick.edge-start { transform: translateX(0); }
    .axis-tick.edge-end { transform: translateX(-100%); }
    .column-track { width: 100%; min-width: 0; height: 190px; display: flex; align-items: end; background: #202838; overflow: hidden; }
    .column-fill { width: 100%; min-height: 2px; background: var(--cyan); }
    .legend { display: flex; flex-wrap: wrap; gap: 10px 14px; color: var(--muted); font-size: 12px; margin-top: 12px; }
    .dot { display: inline-block; width: 9px; height: 9px; margin-right: 5px; background: var(--cyan); }
    .tooltip { position: fixed; z-index: 20; display: none; pointer-events: none; border: 1px solid var(--border); background: #0b0e14; color: var(--text); padding: 7px 9px; font-size: 12px; font-variant-numeric: tabular-nums; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35); }
    .tooltip .sub { color: var(--muted); margin-top: 2px; }
    .green { color: var(--green); } .purple { color: var(--purple); } .blue { color: var(--blue); } .yellow { color: var(--yellow); } .cyan { color: var(--cyan); }
    .bg-green { background: var(--green); } .bg-purple { background: var(--purple); } .bg-blue { background: var(--blue); } .bg-yellow { background: var(--yellow); } .bg-cyan { background: var(--cyan); }
    @media (max-width: 900px) { header, .grid { display: block; } .summary, .controls { grid-template-columns: 1fr; } .panel { margin-top: 14px; } .generated { text-align: left; margin-top: 8px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>devrage cost report</h1>
        <div class="scope" id="scope"></div>
      </div>
      <div class="generated" id="generated"></div>
    </header>
    <section class="summary">
      <div class="card primary"><div class="label">total</div><div class="value" id="totalCost"></div></div>
      <div class="card"><div class="label">requests</div><div class="value" id="requestCount"></div></div>
      <div class="card"><div class="label">models</div><div class="value" id="modelCount"></div></div>
      <div class="card"><div class="label">agents</div><div class="value" id="agentCount"></div></div>
    </section>
    <section class="controls">
      <label>Agent<select id="agentFilter"></select></label>
      <label>Model<select id="modelFilter"></select></label>
      <label>Range<select id="rangeFilter"><option value="all">All included data</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>
    </section>
    <section class="grid">
      <div class="panel"><h2>Agents</h2><div class="panel-body"><table><thead><tr><th>Agent</th><th>Cost</th><th>Reqs</th></tr></thead><tbody id="agentRows"></tbody></table></div></div>
      <div class="panel"><h2>Models</h2><div class="panel-body"><table><thead><tr><th>Model</th><th>Cost</th><th>Share</th><th>Reqs</th><th>Input</th><th>Output</th><th>Cache</th></tr></thead><tbody id="modelRows"></tbody></table><div class="legend"><span><i class="dot bg-purple"></i>Claude/Anthropic</span><span><i class="dot bg-green"></i>OpenAI</span><span><i class="dot bg-blue"></i>Google</span><span><i class="dot bg-yellow"></i>Kimi/GLM</span></div></div></div>
      <div class="panel"><h2>Daily</h2><div class="panel-body"><div class="chart-wrap"><div class="chart" id="dailyChart"></div><div class="axis" id="dailyAxis"></div></div></div></div>
    </section>
    <div class="tooltip" id="tooltip"></div>
  </main>
  <script>
    const DATA = ${jsonForScript(data)};
    const $ = (id) => document.getElementById(id);
    const money = (value) => '$' + (Math.floor(Math.max(0, value) * 100 + 1e-9) / 100).toFixed(2);
    const number = (value) => Math.round(value).toLocaleString('en-US');
    const pct = (value) => (value * 100).toFixed(1) + '%';
    const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const modelClass = (name, provider) => {
      const model = String(name || '').toLowerCase();
      const p = String(provider || '').toLowerCase();
      if (p === 'anthropic' || model.startsWith('claude-')) return 'purple';
      if (p === 'openai' || model.startsWith('gpt-') || /^o\\d/.test(model)) return 'green';
      if (p === 'google' || model.startsWith('gemini-')) return 'blue';
      if (model.startsWith('kimi-') || model.startsWith('glm-')) return 'yellow';
      return 'cyan';
    };
    const shortDate = (day) => new Date(day + 'T00:00:00.000Z').toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone:'UTC'});
    function dailyTicks(days) {
      const count = days.length;
      if (count === 0) return [];
      const maxTicks = count <= 7 ? count : count <= 31 ? 6 : count <= 90 ? 7 : 9;
      if (maxTicks <= 1) return [{index: 0, day: days[0].day}];
      const ticks = [];
      const seen = new Set();
      for (let tick = 0; tick < maxTicks; tick++) {
        const index = Math.round(((count - 1) * tick) / (maxTicks - 1));
        if (seen.has(index)) continue;
        seen.add(index);
        ticks.push({index, day: days[index].day});
      }
      return ticks;
    }
    function addModel(map, incoming) {
      const key = incoming.model;
      const row = map.get(key) || {model: incoming.model, provider: incoming.provider, estimatedCost: 0, requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0};
      row.estimatedCost += incoming.estimatedCost; row.requests += incoming.requests;
      row.inputTokens += incoming.inputTokens; row.outputTokens += incoming.outputTokens; row.reasoningTokens += incoming.reasoningTokens;
      row.cacheReadTokens += incoming.cacheReadTokens; row.cacheWriteTokens += incoming.cacheWriteTokens;
      map.set(key, row);
    }
    function filteredAgents() {
      const selected = $('agentFilter').value;
      return DATA.agents.filter((agent) => selected === 'all' || agent.name === selected);
    }
    function dayAllowed(day) {
      const range = $('rangeFilter').value;
      if (range === 'all') return true;
      const cutoff = new Date(DATA.generatedAt).getTime() - Number(range) * 24 * 60 * 60 * 1000;
      return new Date(day + 'T23:59:59.999Z').getTime() >= cutoff;
    }
    function selectedModelRows(models) {
      const selected = $('modelFilter').value;
      return models.filter((model) => selected === 'all' || model.model === selected);
    }
    function compute() {
      const agents = filteredAgents();
      const modelMap = new Map();
      const dayMap = new Map();
      let totalCost = 0, requests = 0;
      for (const agent of agents) {
        const models = selectedModelRows(agent.models);
        for (const model of models) { addModel(modelMap, model); totalCost += model.estimatedCost; requests += model.requests; }
        for (const day of agent.days) {
          if (!dayAllowed(day.day)) continue;
          const dayModels = selectedModelRows(day.models);
          const cost = dayModels.reduce((sum, model) => sum + model.estimatedCost, 0);
          const reqs = dayModels.reduce((sum, model) => sum + model.requests, 0);
          if (cost <= 0 && reqs <= 0) continue;
          const row = dayMap.get(day.day) || {day: day.day, estimatedCost: 0, requests: 0};
          row.estimatedCost += cost; row.requests += reqs; dayMap.set(day.day, row);
        }
      }
      return {agents, models: Array.from(modelMap.values()).sort((a,b) => b.estimatedCost - a.estimatedCost), days: Array.from(dayMap.values()).sort((a,b) => a.day.localeCompare(b.day)), totalCost, requests};
    }
    function render() {
      const view = compute();
      $('totalCost').textContent = money(view.totalCost);
      $('requestCount').textContent = number(view.requests);
      $('modelCount').textContent = number(view.models.length);
      $('agentCount').textContent = number(view.agents.length);
      const agentRows = view.agents.map((agent) => '<tr><td class="name">' + esc(agent.name) + '</td><td>' + money(agent.estimatedCost) + '</td><td>' + number(agent.requests) + '</td></tr>').join('');
      $('agentRows').innerHTML = agentRows || '<tr><td colspan="3" class="muted">No data</td></tr>';
      const maxModel = Math.max(1, ...view.models.map((model) => model.estimatedCost));
      $('modelRows').innerHTML = view.models.map((model) => {
        const klass = modelClass(model.model, model.provider);
        const cache = model.cacheReadTokens + model.cacheWriteTokens;
        return '<tr><td class="name ' + klass + '">' + esc(model.model) + '</td><td>' + money(model.estimatedCost) + '</td><td>' + pct(view.totalCost > 0 ? model.estimatedCost / view.totalCost : 0) + '</td><td>' + number(model.requests) + '</td><td>' + number(model.inputTokens) + '</td><td>' + number(model.outputTokens + model.reasoningTokens) + '</td><td>' + number(cache) + '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="muted">No data</td></tr>';
      const maxDay = Math.max(1, ...view.days.map((day) => day.estimatedCost));
      $('dailyChart').innerHTML = view.days.length ? view.days.map((day) => {
        const tooltip = esc(shortDate(day.day) + '|' + money(day.estimatedCost) + '|' + number(day.requests) + ' reqs');
        return '<div class="bar-column" data-tooltip="' + tooltip + '"><div class="column-track"><div class="column-fill" style="height:' + Math.max(1, (day.estimatedCost / maxDay) * 100) + '%"></div></div></div>';
      }).join('') : '<div class="muted chart-empty">No data</div>';
      $('dailyAxis').innerHTML = dailyTicks(view.days).map((tick) => {
        const left = view.days.length === 1 ? 50 : ((tick.index + 0.5) / view.days.length) * 100;
        const edge = view.days.length === 1 ? '' : tick.index === 0 ? ' edge-start' : tick.index === view.days.length - 1 ? ' edge-end' : '';
        return '<span class="axis-tick' + edge + '" style="left:' + left.toFixed(4) + '%">' + esc(shortDate(tick.day)) + '</span>';
      }).join('');
    }
    function showTooltip(event) {
      const target = event.target.closest('[data-tooltip]');
      const tooltip = $('tooltip');
      if (!target) { tooltip.style.display = 'none'; return; }
      const [date, amount, requests] = target.dataset.tooltip.split('|');
      tooltip.innerHTML = '<div>' + esc(date) + '</div><div class="sub">' + esc(amount) + ' · ' + esc(requests) + '</div>';
      tooltip.style.display = 'block';
      moveTooltip(event);
    }
    function moveTooltip(event) {
      const tooltip = $('tooltip');
      if (tooltip.style.display !== 'block') return;
      const offset = 12;
      const nextLeft = Math.min(window.innerWidth - tooltip.offsetWidth - 8, event.clientX + offset);
      const nextTop = Math.min(window.innerHeight - tooltip.offsetHeight - 8, event.clientY + offset);
      tooltip.style.left = Math.max(8, nextLeft) + 'px';
      tooltip.style.top = Math.max(8, nextTop) + 'px';
    }
    function init() {
      $('scope').textContent = DATA.scope;
      $('generated').textContent = 'Generated ' + new Date(DATA.generatedAt).toLocaleString();
      $('agentFilter').innerHTML = '<option value="all">All agents</option>' + DATA.agents.map((agent) => '<option value="' + esc(agent.name) + '">' + esc(agent.name) + '</option>').join('');
      const models = Array.from(new Set(DATA.agents.flatMap((agent) => agent.models.map((model) => model.model)))).sort();
      $('modelFilter').innerHTML = '<option value="all">All models</option>' + models.map((model) => '<option value="' + esc(model) + '">' + esc(model) + '</option>').join('');
      ['agentFilter', 'modelFilter', 'rangeFilter'].forEach((id) => $(id).addEventListener('change', render));
      $('dailyChart').addEventListener('mouseover', showTooltip);
      $('dailyChart').addEventListener('mousemove', moveTooltip);
      $('dailyChart').addEventListener('mouseleave', () => { $('tooltip').style.display = 'none'; });
      render();
    }
    init();
  </script>
</body>
</html>`;
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function printReportHeader(options: ScanOptions): void {
  const scope =
    options.rangeLabel ??
    (options.since ? `since ${formatDate(options.since)}` : "all local history");
  const agent = options.agent ? ` · ${options.agent}` : "";
  console.log(`  ${c.bold}${c.red}devrage${c.reset} ${c.dim}report${c.reset}`);
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

function getCostTotals(costByAgent: Record<string, CostSummary>): CostTotals {
  const entries = Object.entries(costByAgent);
  const totalCost = entries.reduce((sum, [, stats]) => sum + stats.estimatedCost, 0);
  const totalRequests = entries.reduce((sum, [, stats]) => sum + stats.requests, 0);
  const unpricedRequests = entries.reduce((sum, [, stats]) => sum + stats.unpricedRequests, 0);

  return {
    entries,
    totalCost,
    totalRequests,
    pricedRequests: totalRequests - unpricedRequests,
    unpricedRequests,
  };
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
    case "pi":
      return c.blue;
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
