#!/usr/bin/env node
// huddle MCP server — the heart.
// Zero-dependency: speaks MCP (JSON-RPC over stdio) natively via node:stdio.
// Exposes the table to any MCP-capable host (opencode, Claude Code):
//   ask    — hand a task to a guest agent, answer returns inline
//   review — guest critiques another agent's last answer
//   check  — supervisor: audit a worker vs its task (AI-watches-AI)
//   history / roster / models

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Bus } from "./bus.ts";
import { loadAdapters } from "./adapters.ts";
import { spawnGuest } from "./spawn.ts";
import { guestPromptFor, resolveAdapter, rosterEntries } from "./router.ts";
import { redact } from "./security/redact.ts";
import { LimitTracker, DEFAULT_LIMITS } from "./security/limits.ts";
import { execFileSync } from "node:child_process";

// ── session state ─────────────────────────────────────────────
const CONFIG_DIR = join(homedir(), ".huddle");
const DB_PATH = join(CONFIG_DIR, "bus.db");
if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

const adapters = loadAdapters();
const bus = new Bus(DB_PATH);
const limits = new LimitTracker(DEFAULT_LIMITS);

const SESSION_ID = process.env.HUDDLE_SESSION ?? "default";
const CWD = process.env.HUDDLE_CWD ?? process.cwd();
const GUESTS = (process.env.HUDDLE_GUESTS ?? "claude,codex,gemini,opencode")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HOST = process.env.HUDDLE_HOST ?? "host";

bus.setHost(SESSION_ID, HOST);

function gitOut(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: CWD, encoding: "utf8", shell: false }).trim();
  } catch {
    return null;
  }
}

// ── shared spawn path (ask / review / check) ──────────────────
async function runGuest(
  agentName: string,
  task: string,
  opts: { mode?: "advise" | "act"; model?: string; asSupervisor?: boolean } = {}
): Promise<string> {
  const adapter = resolveAdapter(adapters, agentName); // layer 2: registry or throw
  const mode = opts.mode ?? "advise";

  const gate = limits.canSpawn(SESSION_ID);
  if (!gate.ok) return `⟦huddle⟧ ${gate.reason}`;

  const prompt = guestPromptFor(adapters, bus, SESSION_ID, GUESTS, { task, mode, asSupervisor: opts.asSupervisor });

  const askTurn = bus.addTurn({
    session_id: SESSION_ID,
    role: agentName,
    agent: agentName,
    kind: "ask",
    content: redact(task),
    meta: { mode, model: opts.model ?? adapter.defaultModel, supervisor: opts.asSupervisor ?? false },
  });
  limits.record(SESSION_ID);
  bus.addEvent({ session_id: SESSION_ID, turn_id: askTurn.id, agent: agentName, event: "spawn", detail: { mode, model: opts.model } });

  const extraArgs =
    mode === "advise"
      ? adapter.adviseArgs ?? []
      : adapter.actArgs ?? [];
  const result = await spawnGuest(adapter, { prompt, cwd: CWD, model: opts.model, timeoutMs: DEFAULT_LIMITS.timeoutMs, extraArgs });

  const answer = result.ok ? result.text : `⟦huddle⟧ guest failed: ${result.text}`;
  bus.addTurn({
    session_id: SESSION_ID,
    role: agentName,
    agent: agentName,
    model: opts.model ?? adapter.defaultModel,
    kind: "answer",
    content: redact(answer),
    meta: { durationMs: result.durationMs, ok: result.ok },
  });
  bus.addEvent({
    session_id: SESSION_ID,
    turn_id: askTurn.id,
    agent: agentName,
    event: result.ok ? "exit" : "error",
    detail: { durationMs: result.durationMs, error: result.error ?? null },
  });
  limits.release(SESSION_ID);

  // act-mode visibility: git diff stat into the transcript
  if (mode === "act" && result.ok) {
    const stat = gitOut(["diff", "--stat"]);
    if (stat) bus.addEvent({ session_id: SESSION_ID, turn_id: askTurn.id, agent: agentName, event: "file_edit", detail: { stat: redact(stat) } });
  }

  return `⟦huddle:${agentName}⟧\n${answer}\n⟦/huddle⟧`;
}

// ── tool catalog ─────────────────────────────────────────────
function tools() {
  return [
    {
      name: "ask",
      description:
        "Hand a task to a guest agent at the table. Their answer returns here, inline. Use when the user @mentions an agent (e.g. '@claude review this'). mode 'act' (or user's '!' suffix like '@claude!') lets the guest edit files; default 'advise' is read-only analysis.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: [...adapters.keys()] },
          task: { type: "string" },
          mode: { type: "string", enum: ["advise", "act"] },
          model: { type: "string", description: "model id override, e.g. opus / gemini-3-pro / z-ai/glm-5.3-free" },
        },
        required: ["agent", "task"],
      },
    },
    {
      name: "review",
      description: "Ask a guest agent to critique another agent's most recent answer (peer review).",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string" }, target: { type: "string" }, model: { type: "string" } },
        required: ["agent", "target"],
      },
    },
    {
      name: "check",
      description:
        "Supervision: audit a worker agent's last run against the task it was given. Supervisor reads worker's transcript + events and returns VERDICT: ON-SPEC/OFF-SPEC/PARTIAL with findings. AI-watches-AI.",
      inputSchema: {
        type: "object",
        properties: { supervisor: { type: "string" }, worker: { type: "string" }, model: { type: "string" } },
        required: ["supervisor", "worker"],
      },
    },
    {
      name: "history",
      description: "Tail of the shared session transcript (all agents + human).",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    },
    {
      name: "roster",
      description: "Who is at the table this session, with models.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "models",
      description: "Model catalog for every registered agent (id, label, tier: free/paid/local).",
      inputSchema: { type: "object", properties: { agent: { type: "string" } } },
    },
  ];
}

async function callTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "ask":
      return runGuest(args.agent, args.task, { mode: args.mode, model: args.model });

    case "review": {
      const lastAnswer = bus
        .history(SESSION_ID, 50)
        .reverse()
        .find((t) => t.agent === args.target && t.kind === "answer");
      if (!lastAnswer) return `⟦huddle⟧ no answer from ${args.target} to review yet`;
      return runGuest(
        args.agent,
        `Review ${args.target}'s last answer below. Is it correct? Any bugs, risks, or better approaches? Be specific and concise.\n\n---\n${lastAnswer.content}\n---`,
        { model: args.model }
      );
    }

    case "check": {
      const worker = args.worker;
      const turns = bus.history(SESSION_ID, 100).slice().reverse();
      const lastTask = turns.find((t) => t.agent === worker && t.kind === "ask");
      if (!lastTask) return `⟦huddle⟧ no recorded run by ${worker} to audit`;
      const workerAnswer = turns.find((t) => t.agent === worker && t.kind === "answer" && t.seq > lastTask.seq);
      const events = bus.events(SESSION_ID, worker);
      const transcript = [
        `TASK GIVEN TO ${worker}:`,
        lastTask.content,
        "",
        `${worker}'S ANSWER:`,
        workerAnswer?.content ?? "(no answer recorded)",
        "",
        "WORKER EVENTS:",
        events.length ? events.map((e) => `- [${e.event}] ${e.detail ?? ""}`).join("\n") : "(none)",
      ].join("\n");
      return runGuest(args.supervisor, transcript, { model: args.model, asSupervisor: true });
    }

    case "history": {
      const lines = bus.history(SESSION_ID, args.limit ?? 10).map(
        (t) =>
          `[${t.created_at}] ${t.role}${t.model ? `(${t.model})` : ""} ${t.kind}: ${
            t.content.length > 300 ? t.content.slice(0, 300) + "…" : t.content
          }`
      );
      return lines.join("\n") || "(empty)";
    }

    case "roster": {
      const rows = rosterEntries(adapters, GUESTS).map((r) => `- ${r.name} (${r.model})`);
      return `host: ${HOST}\nguests:\n${rows.join("\n")}`;
    }

    case "models": {
      const list = args.agent ? [resolveAdapter(adapters, args.agent)] : [...adapters.values()];
      return list.map((a) => `${a.name}:\n${a.models.map((m) => `  - ${m.id} [${m.tier}] ${m.label}`).join("\n")}`).join("\n");
    }

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ── minimal MCP over stdio (JSON-RPC 2.0, line-delimited) ─────
function reply(id: any, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id: any, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) + "\n");
}

const KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const rl = createInterface({ input: process.stdin });
let pending = 0;
// Serialize tool calls: guests share one bus and one working tree, so
// concurrent runs would interleave transcripts and collide on files.
let tail: Promise<void> = Promise.resolve();

rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg: any;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // not JSON-RPC — ignore
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const version = KNOWN_VERSIONS.includes(requested) ? requested : "2024-11-05";
    reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "huddle", version: "0.2.0" } });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // notification, no reply
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: tools() });
    return;
  }
  if (method === "tools/call") {
    pending++;
    const job = tail.then(() => callTool(params?.name, params?.arguments ?? {})).then(
      (text) => reply(id, { content: [{ type: "text", text }], isError: false }),
      (err: any) => reply(id, { content: [{ type: "text", text: `⟦huddle⟧ error: ${err.message}` }], isError: true })
    ).finally(() => {
      pending--;
    });
    tail = job.catch(() => {});
    return;
  }
  if (id !== undefined) replyErr(id, `method not found: ${method}`);
});

rl.on("close", async () => {
  // stdin closed — but a guest call may still be running. Wait for it, reply, then exit.
  const deadline = Date.now() + 600_000;
  while (pending > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  bus.close();
  process.exit(0);
});
