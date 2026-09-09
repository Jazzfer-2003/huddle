// Guest spawner — the only place roundtable executes anything.
// Security layers 1, 2, 5 live here:
//   1. execFile with args array — never shell, prompt via stdin
//   2. only registered adapter commands can run (router enforces before this)
//   5. timeout + kill on breach

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Adapter } from "./adapters.ts";

// Windows: npm installs .cmd shims (codex.cmd, gemini.cmd), and modern Node
// refuses to execFile them without a shell. Instead of a shell, we resolve
// what the shim wraps: read the .cmd, extract the underlying node script,
// and spawn `node script.js` with a pure args array — layer 1 intact.
function resolveCommand(command: string): { exe: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { exe: command, prefixArgs: [] };
  if (command.includes("/") || command.includes("\\")) return { exe: command, prefixArgs: [] };

  const exts = process.env.PATHEXT ? process.env.PATHEXT.split(";") : [".COM", ".EXE", ".BAT", ".CMD"];
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);

  // 1. prefer real executables (.exe) — no shim needed
  for (const p of paths) {
    for (const ext of [".exe", ".cmd", ".bat", ".ps1"]) {
      const candidate = join(p, command + ext.toLowerCase());
      if (!existsSync(candidate)) continue;
      if (ext === ".exe") return { exe: candidate, prefixArgs: [] };
      // parse shim for the underlying node script
      const script = extractNodeScriptFromShim(candidate);
      if (script) return { exe: process.execPath, prefixArgs: [script] };
    }
  }
  return { exe: command, prefixArgs: [] };
}

function extractNodeScriptFromShim(shimPath: string): string | null {
  try {
    const content = readFileSync(shimPath, "utf8");
    const m = content.match(/node_modules[\\\/][^\s"']+\.(?:js|mjs|cjs)/);
    if (!m) return null;
    const shimDir = dirname(shimPath);
    const script = join(shimDir, m[0]);
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

export interface SpawnResult {
  ok: boolean;
  raw: string;
  text: string;
  error?: string;
  durationMs: number;
}

// Extract the assistant's answer from a CLI's raw output.
function extract(adapter: Adapter, raw: string): string {
  // JSON output formats
  const trimmed = raw.trim();
  if (adapter.outputFormat === "json" || adapter.name === "claude" || adapter.name === "codex") {
    // claude -p --output-format json → single JSON object with `result`
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.result === "string") return parsed.result;
      if (typeof parsed?.message === "string") return parsed.message;
    } catch {}
    // codex exec --json → JSONL stream; take the last agent_message item
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item?.type === "agent_message" && typeof item.message === "string") return item.message;
        if (item?.msg?.type === "agent_message" && typeof item.msg.message === "string") return item.msg.message;
        if (typeof item?.result === "string") return item.result;
      } catch {}
    }
  }
  // Plain text fallback — return as-is
  return trimmed;
}

export function buildArgs(adapter: Adapter, model?: string): string[] {
  const modelId = model ?? adapter.defaultModel ?? "default";
  return adapter.argsTemplate.map((a) => (a === "{model}" ? modelId : a));
}

export async function spawnGuest(
  adapter: Adapter,
  opts: { prompt: string; cwd?: string; model?: string; timeoutMs: number; extraArgs?: string[] }
): Promise<SpawnResult> {
  const args = buildArgs(adapter, opts.model);
  const resolved = resolveCommand(adapter.command);
  const promptArgs = adapter.promptVia === "arg" ? [opts.prompt] : [];
  const fullArgs = [...resolved.prefixArgs, ...args, ...promptArgs, ...(opts.extraArgs ?? [])];
  const start = Date.now();

  return await new Promise<SpawnResult>((resolve) => {
    let settled = false;
    const finish = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(r);
    };

    // Layer 5, explicit: on timeout, hard-kill the child tree, then resolve.
    const killer = setTimeout(() => {
      try { child.kill(); } catch {}
      // Windows: execFile's own timeout may use SIGTERM which .cmd/node trees ignore;
      // follow up with a taskkill on the process tree for certainty.
      if (process.platform === "win32" && child.pid) {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false });
        } catch {}
      }
      finish({
        ok: false,
        raw: "",
        text: `Guest ${adapter.name} timed out after ${opts.timeoutMs}ms and was killed.`,
        error: "timeout",
        durationMs: opts.timeoutMs,
      });
    }, opts.timeoutMs);

    const child = execFile(
      resolved.exe,
      fullArgs,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: process.env,
        shell: false, // layer 1: never a shell — prompt goes via stdin or arg, never into a command string
      },
      (err, stdout) => {
        const raw: string = typeof stdout === "string" ? stdout : "";
        if (err) {
          const killed = err.killed === true || (err as any)?.code === "ETIMEDOUT" || String(err.message ?? "").includes("TIMEDOUT");
          finish({
            ok: false,
            raw,
            text: killed
              ? `Guest ${adapter.name} timed out after ${opts.timeoutMs}ms and was killed.`
              : raw || err.message || "spawn failed",
            error: killed ? "timeout" : String(err.message ?? err),
            durationMs: Date.now() - start,
          });
        } else {
          finish({ ok: true, raw, text: extract(adapter, raw), durationMs: Date.now() - start });
        }
      }
    );
    // Deliver the prompt and signal EOF — CLIs that read stdin unblock immediately.
    if (adapter.promptVia === "stdin") child.stdin?.end(opts.prompt);
    else child.stdin?.end();
  });
}
