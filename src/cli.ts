#!/usr/bin/env node
// huddle CLI — init / history / undo / models / adapters / help
// Usage: huddle <command> [flags]

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const RT_DIR = resolve(import.meta.dirname, "..");

function help() {
  console.log(`huddle — one session, many AI brains

commands:
  init --host <opencode|claude> --guests <a,b,c> [--yes]
                      detect agents, pick your table, write MCP config
                      (without flags: interactive picker)
  history [n]         show the shared session transcript (default 20 turns)
  undo                reset the working tree to HEAD (act-mode recovery)
  models [agent]      show model catalogs (free/paid/local)
  adapters            list registered adapters and how to add your own
`);
}

// ── detection ────────────────────────────────────────────────
// No shell, cross-platform: probing `--version` doubles as an availability check.
function which(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", shell: false, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const KNOWN_AGENTS = ["claude", "codex", "opencode", "gemini"];
const KNOWN_HOSTS = ["opencode", "claude"];

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") out.host = args[++i];
    else if (args[i] === "--guests") out.guests = args[++i];
    else if (args[i] === "--yes" || args[i] === "-y") out.yes = true;
  }
  return out;
}

// ── init ─────────────────────────────────────────────────────
function init(flags: Record<string, string | boolean>) {
  console.log("huddle init — set your table\n");

  const present = KNOWN_AGENTS.filter(which);
  console.log("Detected agents: " + (present.length ? present.join(", ") : "(none)") + "\n");

  // resolve host
  let host = typeof flags.host === "string" ? flags.host : "";
  if (!host) host = present.find((a) => KNOWN_HOSTS.includes(a)) ?? "opencode";
  if (!KNOWN_HOSTS.includes(host)) {
    console.log(`unknown host '${host}' — supported: ${KNOWN_HOSTS.join(", ")}`);
    process.exit(1);
  }

  // resolve guests
  let guests: string[] = [];
  if (typeof flags.guests === "string") {
    guests = flags.guests.split(",").map((g) => g.trim()).filter(Boolean);
  } else if (flags.yes) {
    guests = present.filter((a) => a !== host);
  }
  if (guests.length === 0) {
    // interactive fallback
    const fallback = present.filter((a) => a !== host);
    const raw = prompt(`Guests (comma-separated from: ${present.join(", ")}) [${fallback.join(",")}]: `);
    guests = raw ? raw.split(",").map((g) => g.trim()).filter(Boolean) : fallback;
  }
  const unknown = guests.filter((g) => !KNOWN_AGENTS.includes(g));
  if (unknown.length) {
    console.log(`unknown agents: ${unknown.join(", ")} — known: ${KNOWN_AGENTS.join(", ")} (custom adapters go in ~/.huddle/adapters/)`);
    process.exit(1);
  }

  console.log(`Table: host=${host}, guests=${guests.join(", ")}\n`);
  writeHostConfig(host, guests);
  writeSkill(host);
}

function prompt(q: string): string {
  process.stdout.write(q);
  const buf = Buffer.alloc(1);
  let out = "";
  const fs = require("node:fs") as typeof import("node:fs");
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null as any);
      if (n === 0) break;
      const ch = buf.toString("utf8", 0, 1);
      if (ch === "\n" || ch === "\r") break;
      out += ch;
    }
  } catch {
    return "";
  }
  return out.trim();
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ── config writers ───────────────────────────────────────────
function writeHostConfig(host: string, guests: string[]) {
  const serverPath = join(RT_DIR, "src", "server.ts");
  const guestsEnv = guests.join(",");

  if (host === "opencode") {
    const cfgPath = join(homedir(), ".config", "opencode", "opencode.json");
    let cfg: any = {};
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { cfg = {}; }
    }
    cfg.mcp = cfg.mcp ?? {};
    cfg.mcp.huddle = {
      type: "local",
      command: ["node", "--experimental-strip-types", serverPath],
      enabled: true,
      environment: { HUDDLE_GUESTS: guestsEnv, HUDDLE_HOST: "opencode" },
      timeout: 300000,
    };
    mkdirSync(join(homedir(), ".config", "opencode"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`✔ Wrote MCP config → ${cfgPath}`);
  } else if (host === "claude") {
    const cfgPath = join(homedir(), ".claude.json");
    let cfg: any = {};
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { cfg = {}; }
    }
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers.huddle = {
      command: "node",
      args: ["--experimental-strip-types", serverPath],
      env: { HUDDLE_GUESTS: guestsEnv, HUDDLE_HOST: "claude" },
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`✔ Wrote MCP config → ${cfgPath}`);
  }

  console.log(`\nNext: start '${host}' in any project and type  @${guests[0]} <question>`);
}

function writeSkill(host: string) {
  const skillSrc = join(RT_DIR, "skills", "huddle.md");
  if (!existsSync(skillSrc)) return;
  const skill = readFileSync(skillSrc, "utf8");
  if (host === "opencode") {
    const dir = join(process.cwd(), ".opencode", "skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "huddle.md"), skill);
    console.log(`✔ Wrote host skill → ${join(".opencode", "skill", "huddle.md")}`);
  } else if (host === "claude") {
    const dir = join(process.cwd(), ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "huddle.md"), skill);
    console.log(`✔ Wrote host skill → ${join(".claude", "skills", "huddle.md")}`);
  }
}

// ── history ─────────────────────────────────────────────────
function history(n: number) {
  const dbPath = join(homedir(), ".huddle", "bus.db");
  if (!existsSync(dbPath)) {
    console.log("No huddle sessions yet. Start one from your host agent.");
    return;
  }
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(`SELECT session_id, seq, role, model, kind, content, created_at FROM turns ORDER BY rowid DESC LIMIT ?`)
    .all(n)
    .reverse();
  for (const r of rows as any[]) {
    const who = `${r.role}${r.model ? `(${r.model})` : ""}`;
    const text = r.content.length > 200 ? r.content.slice(0, 200) + "…" : r.content;
    console.log(`[${r.created_at}] ${who} ${r.kind}: ${text.replace(/\n/g, " ")}`);
  }
  db.close();
}

// ── undo (act-mode recovery) ────────────────────────────────
function undo() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", shell: false }).trim();
    execFileSync("git", ["reset", "--hard", "HEAD"], { shell: false });
    console.log(`✔ Working tree reset to HEAD on ${branch}. Uncommitted guest edits are gone.`);
    console.log("  (committed changes survive — 'git log' to inspect)");
  } catch {
    console.log("Not a git repo (or git unavailable) — undo is unavailable here.");
  }
}

// ── models ─────────────────────────────────────────────────
function models(agent?: string) {
  const userDir = join(homedir(), ".huddle", "adapters");
  const seen = new Map<string, any>();
  for (const dir of [join(RT_DIR, "adapters"), userDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      try {
        const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
        seen.set(a.name, a);
      } catch {}
    }
  }
  const list = agent ? [seen.get(agent)].filter(Boolean) : [...seen.values()];
  if (!list.length) { console.log(`no adapter '${agent}'`); return; }
  for (const a of list as any[]) {
    console.log(`${a.name}  (default: ${a.defaultModel ?? "?"})`);
    for (const m of a.models ?? []) console.log(`  - ${m.id.padEnd(34)} [${m.tier}] ${m.label}`);
  }
}

// ── adapters ────────────────────────────────────────────────
function adaptersInfo() {
  const builtinDir = join(RT_DIR, "adapters");
  console.log("Registered adapters:");
  for (const dir of [builtinDir, join(homedir(), ".huddle", "adapters")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.startsWith("_")) continue;
      try {
        const a = JSON.parse(readFileSync(join(dir, f), "utf8"));
        console.log(`  - ${a.name}`);
      } catch {}
    }
  }
  console.log(`\nAdd your own agent: copy ${join(builtinDir, "_template.json")} → ~/.huddle/adapters/<name>.json (4 fields), done.`);
}

// ── main ────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "init": init(parseFlags(rest)); break;
  case "history": history(Number(rest[0] ?? 20)); break;
  case "undo": undo(); break;
  case "models": models(rest[0]); break;
  case "adapters": adaptersInfo(); break;
  default: help();
}
