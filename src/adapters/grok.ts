import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Adapter, AdapterOptions, Message } from "./index";

const GROK_SESSIONS_DIR = join(homedir(), ".grok", "sessions");

export function grokAdapter(): Adapter {
  return {
    name: "grok",
    async *messages(options?: AdapterOptions): AsyncGenerator<Message> {
      yield* walkGrokSessions(GROK_SESSIONS_DIR, options);
    },
  };
}

async function* walkGrokSessions(dir: string, options?: AdapterOptions): AsyncGenerator<Message> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(dir);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(dir, projectDir);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) {
      continue;
    }

    const project = decodeProject(projectDir);
    const promptSessions = new Set<string>();

    yield* parsePromptHistory(join(projectPath, "prompt_history.jsonl"), {
      project,
      promptSessions,
      since: options?.since,
    });

    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const session of sessionDirs) {
      if (promptSessions.has(session)) {
        continue;
      }

      const sessionPath = join(projectPath, session);
      const sessionStat = await stat(sessionPath).catch(() => null);
      if (!sessionStat?.isDirectory()) {
        continue;
      }

      const historyPath = join(sessionPath, "chat_history.jsonl");
      const historyStat = await stat(historyPath).catch(() => null);
      if (!historyStat?.isFile()) {
        continue;
      }
      if (options?.since && historyStat.mtime < options.since) {
        continue;
      }

      yield* parseChatHistory(historyPath, {
        project,
        session,
        since: options?.since,
      });
    }
  }
}

async function* parsePromptHistory(
  filePath: string,
  context: {
    project: string;
    promptSessions: Set<string>;
    since?: Date;
  },
): AsyncGenerator<Message> {
  if (!existsSync(filePath)) {
    return;
  }

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as GrokPromptEntry;
      if (entry.is_bash === true) {
        continue;
      }
      if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
        continue;
      }

      const session = typeof entry.session_id === "string" ? entry.session_id : undefined;
      if (session) {
        context.promptSessions.add(session);
      }

      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      if (context.since && timestamp) {
        const ts = new Date(timestamp);
        if (ts < context.since) {
          continue;
        }
      }

      yield {
        text: entry.prompt,
        timestamp,
        session,
        project: context.project,
      };
    } catch {}
  }
}

async function* parseChatHistory(
  filePath: string,
  context: { project: string; session: string; since?: Date },
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
      const entry = JSON.parse(line) as GrokChatEntry;
      if (entry.type !== "user") {
        continue;
      }
      if (typeof entry.synthetic_reason === "string") {
        continue;
      }

      const text = extractText(entry.content);
      if (!text?.trim()) {
        continue;
      }

      const timestamp = extractTimestamp(entry);
      if (context.since && timestamp) {
        const ts = new Date(timestamp);
        if (ts < context.since) {
          continue;
        }
      }

      yield {
        text,
        timestamp: timestamp ?? undefined,
        session: context.session,
        project: context.project,
      };
    } catch {}
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text);

  return parts.length > 0 ? parts.join(" ") : null;
}

function extractTimestamp(entry: GrokChatEntry): string | null {
  if (typeof entry.timestamp === "string") {
    return entry.timestamp;
  }
  if (typeof entry.created_at === "string") {
    return entry.created_at;
  }
  if (typeof entry.createdAt === "string") {
    return entry.createdAt;
  }
  return null;
}

function decodeProject(projectDir: string): string {
  try {
    return decodeURIComponent(projectDir);
  } catch {
    return projectDir;
  }
}

interface GrokPromptEntry {
  timestamp?: unknown;
  session_id?: unknown;
  prompt?: unknown;
  is_bash?: unknown;
}

interface GrokChatEntry {
  type?: unknown;
  content?: unknown;
  synthetic_reason?: unknown;
  timestamp?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}
