import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterOptions, Message, UsageRecord } from "./index";

/**
 * Codex stores sessions as JSONL files at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each line is JSON with structure:
 *   { "timestamp": "...", "type": "response_item", "payload": { "type": "message", "role": "user", "content": [...] } }
 *
 * User messages have payload.role === "user" and content is an array of
 *   { "type": "input_text", "text": "..." }
 *
 * We skip messages that are just environment context injections.
 */

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

export function codexAdapter(): Adapter {
  return {
    name: "codex",
    async *messages(options?: AdapterOptions): AsyncGenerator<Message> {
      for await (const file of discoverCodexSessionFiles(CODEX_SESSIONS_DIR)) {
        yield* parseCodexJsonl(file.filePath, { session: file.session, since: options?.since });
      }
    },
    async *usage(options?: AdapterOptions): AsyncGenerator<UsageRecord> {
      for await (const file of discoverCodexSessionFiles(CODEX_SESSIONS_DIR)) {
        yield* parseCodexUsageJsonl(file.filePath, {
          session: file.session,
          since: options?.since,
        });
      }
    },
  };
}

async function* discoverCodexSessionFiles(
  dir: string,
): AsyncGenerator<{ filePath: string; session: string }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const entryStat = await stat(fullPath);

    if (entryStat.isDirectory()) {
      yield* discoverCodexSessionFiles(fullPath);
    } else if (entry.endsWith(".jsonl")) {
      yield { filePath: fullPath, session: entry.replace(".jsonl", "") };
    }
  }
}

async function* parseCodexJsonl(
  filePath: string,
  context: { session: string; since?: Date },
): AsyncGenerator<Message> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as CodexEntry;

      // Only care about response_item entries with user messages
      if (entry.type !== "response_item") {
        continue;
      }

      const payload = entry.payload;
      if (!payload || payload.role !== "user") {
        continue;
      }

      const text = extractText(payload.content);
      if (!text) {
        continue;
      }

      // Skip environment context injections (they start with <environment_context>)
      if (text.startsWith("<environment_context>")) {
        continue;
      }
      // Skip permission/sandbox instructions
      if (text.startsWith("<permissions instructions>")) {
        continue;
      }

      if (context.since && entry.timestamp) {
        const ts = new Date(entry.timestamp);
        if (ts < context.since) {
          continue;
        }
      }

      yield {
        text,
        timestamp: entry.timestamp,
        session: context.session,
      };
    } catch {
      // Skip malformed lines
    }
  }
}

function extractText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .filter(
      (p): p is { type: string; text: string } =>
        typeof p === "object" &&
        p !== null &&
        p.type === "input_text" &&
        typeof p.text === "string",
    )
    .map((p) => p.text);

  return parts.length > 0 ? parts.join(" ") : null;
}

interface CodexEntry {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
  };
}

interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/** Codex token_count events are cumulative; per-request records come from positive deltas. */
async function* parseCodexUsageJsonl(
  filePath: string,
  context: { session: string; since?: Date },
): AsyncGenerator<UsageRecord> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let model: string | undefined;
  let previousTotal: CodexTokenUsage | null = null;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const payload = asRecord(entry["payload"]);

      if (entry["type"] === "turn_context") {
        model = stringValue(payload?.["model"]) ?? model;
        continue;
      }

      if (entry["type"] !== "event_msg" || payload?.["type"] !== "token_count") {
        continue;
      }

      const info = asRecord(payload["info"]);
      const total = parseCodexTokenUsage(info?.["total_token_usage"]);
      if (!total) {
        continue;
      }

      const delta = previousTotal ? subtractCodexUsage(total, previousTotal) : total;
      previousTotal = total;
      if (!hasPositiveUsage(delta)) {
        continue;
      }

      const timestamp = stringValue(entry["timestamp"]);
      if (context.since && timestamp) {
        const ts = new Date(timestamp);
        if (ts < context.since) {
          continue;
        }
      }

      const reasoningTokens = Math.min(delta.reasoningOutputTokens, delta.outputTokens);
      yield {
        agent: "codex",
        provider: "openai",
        model,
        timestamp,
        session: context.session,
        inputTokens: Math.max(delta.inputTokens - delta.cachedInputTokens, 0),
        outputTokens: Math.max(delta.outputTokens - reasoningTokens, 0),
        reasoningTokens,
        cacheReadTokens: delta.cachedInputTokens,
        cacheWriteTokens: 0,
      };
    } catch {
      // Skip malformed lines
    }
  }
}

function parseCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  const usage = asRecord(value);
  if (!usage) {
    return null;
  }

  const parsed = {
    inputTokens: numberValue(usage["input_tokens"]),
    cachedInputTokens: numberValue(usage["cached_input_tokens"]),
    outputTokens: numberValue(usage["output_tokens"]),
    reasoningOutputTokens: numberValue(usage["reasoning_output_tokens"]),
    totalTokens: numberValue(usage["total_tokens"]),
  };

  return hasPositiveUsage(parsed) ? parsed : null;
}

function subtractCodexUsage(current: CodexTokenUsage, previous: CodexTokenUsage): CodexTokenUsage {
  return {
    inputTokens: Math.max(current.inputTokens - previous.inputTokens, 0),
    cachedInputTokens: Math.max(current.cachedInputTokens - previous.cachedInputTokens, 0),
    outputTokens: Math.max(current.outputTokens - previous.outputTokens, 0),
    reasoningOutputTokens: Math.max(
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
      0,
    ),
    totalTokens: Math.max(current.totalTokens - previous.totalTokens, 0),
  };
}

function hasPositiveUsage(usage: CodexTokenUsage): boolean {
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.totalTokens > 0;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
