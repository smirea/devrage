import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(repoRoot, "dist", "cli.js");
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

test("OpenCode cost uses cached models.dev pricing and keeps billed cost separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-opencode-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath);

  const output = stripAnsi(
    await runCli(["scan", "--agent", "opencode", "--cost", "--since", "2026-06-01"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /messages scanned\s+1/);
  assert.match(output, /cost dashboard/);
  assert.match(output, /model mix/);
  assert.match(output, /daily spend/);
  assert.match(output, /2026-06-02\s+\$35\.00/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
  assert.match(output, /billed \$0\.00/);
});

test("cost command renders only the cost dashboard", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--since", "2026-06-01"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /devrage cost/);
  assert.match(output, /\$35\.00/);
  assert.match(output, /1 req/);
  assert.match(output, /models/);
  assert.match(output, /daily/);
  assert.match(output, /agents/);
  assert.match(output, /gpt-5\.5\s+\$35\.00/);
  assert.ok(output.indexOf("agents") < output.indexOf("models"));
  assert.ok(output.indexOf("models") < output.indexOf("daily"));
  assert.doesNotMatch(output, /estimated API-equivalent cost/);
  assert.doesNotMatch(output, /cost dashboard/);
  assert.doesNotMatch(output, /agent cost/);
  assert.doesNotMatch(output, /messages scanned/);
  assert.doesNotMatch(output, /total swears/);
  assert.doesNotMatch(output, /agent language/);
  assert.doesNotMatch(output, /top words/);
});

test("cost range shortcuts default days to one day", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-day-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const dayOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--day"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );
  const daysOutput = stripAnsi(
    await runCli(["cost", "--days", "--agent", "opencode"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(dayOutput, /last 1 day/);
  assert.match(dayOutput, /\$35\.00/);
  assert.match(daysOutput, /last 1 day/);
  assert.match(daysOutput, /\$35\.00/);
});

test("cost range shortcuts accept explicit days", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-days-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--days", "3"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /last 3 days/);
  assert.match(output, /\$35\.00/);
});

test("cost range shortcuts include week and month", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-week-month-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now());

  const weekOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--week"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );
  const monthOutput = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--month"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(weekOutput, /last 7 days/);
  assert.match(weekOutput, /\$35\.00/);
  assert.match(monthOutput, /last 30 days/);
  assert.match(monthOutput, /\$35\.00/);
});

test("cost display floors dollar amounts to cents", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cost-floor-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const dbPath = join(dataHome, "opencode", "opencode.db");

  await mkdir(dirname(dbPath), { recursive: true });
  await writePricingCache(cacheHome);
  createOpenCodeFixture(dbPath, Date.now(), 1_000_333);

  const output = stripAnsi(
    await runCli(["cost", "--agent", "opencode", "--day"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /\$35\.00/);
  assert.doesNotMatch(output, /\$35\.01/);
});

test("Claude cost uses assistant usage once per streamed request", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-claude-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".claude", "projects", "fixture", "session.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(
    sessionPath,
    `${claudeUserLine()}\n${claudeAssistantLine()}\n${claudeAssistantLine()}\n`,
  );

  const output = stripAnsi(
    await runCli(["scan", "--agent", "claude", "--cost"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /messages scanned\s+1/);
  assert.match(output, /claude-opus-4-7\s+\$36\.75\s+1 requests catalog/);
});

test("Codex cost uses cumulative token deltas without double-counting repeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-codex-"));
  const cacheHome = join(root, "cache");
  const sessionPath = join(root, ".codex", "sessions", "2026", "06", "02", "rollout-fixture.jsonl");

  await mkdir(dirname(sessionPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(
    sessionPath,
    `${codexTurnContextLine()}\n${codexUserLine()}\n${codexTokenLine()}\n${codexTokenLine()}\n`,
  );

  const output = stripAnsi(
    await runCli(["scan", "--agent", "codex", "--cost"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
    }),
  );

  assert.match(output, /messages scanned\s+1/);
  assert.match(output, /gpt-5\.5\s+\$35\.05\s+1 requests catalog/);
});

test("Amp cost reads nested usage ledger entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-amp-"));
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");
  const threadPath = join(dataHome, "amp", "threads", "thread.json");

  await mkdir(dirname(threadPath), { recursive: true });
  await writePricingCache(cacheHome);
  await writeFile(threadPath, JSON.stringify(ampThreadFixture()));

  const output = stripAnsi(
    await runCli(["scan", "--agent", "amp", "--cost"], {
      HOME: root,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
    }),
  );

  assert.match(output, /messages scanned\s+1/);
  assert.match(output, /gpt-5\.5\s+\$35\.00\s+1 requests catalog/);
});

test("Cursor scans user prompts and skips assistant-only state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devrage-cursor-"));
  const configHome = join(root, "config");
  const appData = join(root, "AppData", "Roaming");
  const statePath = join(
    cursorUserDir(root, configHome, appData),
    "workspaceStorage",
    "ws",
    "state.vscdb",
  );

  await mkdir(dirname(statePath), { recursive: true });
  createCursorFixture(statePath);

  const output = stripAnsi(
    await runCli(["scan", "--agent", "cursor"], {
      APPDATA: appData,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
    }),
  );

  assert.match(output, /messages scanned\s+2/);
  assert.match(output, /total swears\s+2/);
  assert.match(output, /fuck\s+1/);
  assert.match(output, /crap\s+1/);
  assert.doesNotMatch(output, /shit\s+1/);
});

async function runCli(args, env) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return result.stdout;
}

async function writePricingCache(cacheHome) {
  const cacheDir = join(cacheHome, "devrage");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "models.dev.json"),
    `${JSON.stringify({
      source: "models.dev",
      fetchedAt: new Date().toISOString(),
      schemaVersion: 1,
      catalog: {
        openai: {
          models: {
            "gpt-5.5": { cost: { input: 5, output: 30, cache_read: 0.5 } },
          },
        },
        anthropic: {
          models: {
            "claude-opus-4-7": {
              cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
            },
          },
        },
      },
    })}\n`,
  );
}

function claudeUserLine() {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
    timestamp: "2026-06-02T00:00:00.000Z",
  });
}

function claudeAssistantLine() {
  return JSON.stringify({
    type: "assistant",
    requestId: "req-1",
    timestamp: "2026-06-02T00:00:01.000Z",
    message: {
      id: "msg-1",
      role: "assistant",
      model: "claude-opus-4-7",
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
    },
  });
}

function codexTurnContextLine() {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:00.000Z",
    type: "turn_context",
    payload: { model: "gpt-5.5" },
  });
}

function codexUserLine() {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  });
}

function codexTokenLine() {
  return JSON.stringify({
    timestamp: "2026-06-02T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_100_000,
          cached_input_tokens: 100_000,
          output_tokens: 1_000_000,
          reasoning_output_tokens: 500_000,
          total_tokens: 2_100_000,
        },
      },
    },
  });
}

function ampThreadFixture() {
  return {
    messages: [{ role: "user", content: "hello", timestamp: "2026-06-02T00:00:00.000Z" }],
    usageLedger: {
      entries: [
        {
          provider: "openai",
          model: "gpt-5.5",
          timestamp: "2026-06-02T00:00:01.000Z",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
          },
        },
      ],
    },
  };
}

function createOpenCodeFixture(
  dbPath,
  timestamp = Date.parse("2026-06-02T00:00:00.000Z"),
  outputTokens = 1_000_000,
) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);

    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "user-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      "part-1",
      "user-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({ type: "text", text: "please fix this" }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "assistant-1",
      "session-1",
      timestamp,
      timestamp,
      JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.5",
        cost: 0,
        tokens: { input: 1_000_000, output: outputTokens, cache: { read: 0, write: 0 } },
      }),
    );
  } finally {
    db.close();
  }
}

function cursorUserDir(home, configHome, appData) {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User");
  }

  if (process.platform === "win32") {
    return join(appData, "Cursor", "User");
  }

  return join(configHome, "Cursor", "User");
}

function createCursorFixture(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({
        composerId: "composer-1",
        messages: [
          { role: "user", content: "this is crap", timestamp: "2026-06-02T00:00:00.000Z" },
          { role: "assistant", content: "assistant says shit" },
        ],
      }),
    );
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "aiService.prompts",
      JSON.stringify("please fix this fuck"),
    );
  } finally {
    db.close();
  }
}

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "").replace(/\r/g, "");
}
