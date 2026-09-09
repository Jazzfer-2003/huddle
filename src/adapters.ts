// Adapter registry — the "any agent" layer.
// Each adapter is a small manifest: how to invoke a guest CLI headless,
// where the model flag goes, and which models it offers.
// Add a new agent = copy _template.json, edit 4 fields, PR. That's it.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Adapter {
  name: string;
  command: string;
  argsTemplate: string[];      // may contain {model} and {promptFile}
  promptVia: "stdin" | "arg"; // how the prompt is delivered
  outputFormat?: "json" | "text";
  models: { id: string; label: string; tier: "free" | "paid" | "local" }[];
  defaultModel?: string;
  adviseArgs?: string[];       // read-only flags where the CLI supports it
  extractResult?: (raw: string) => string; // custom parse (only for built-ins)
  builtin?: boolean;
}

function builtinDir(): string {
  return new URL("../adapters", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

function userAdapterDir(): string {
  const dir = join(homedir(), ".huddle", "adapters");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadAdapters(): Map<string, Adapter> {
  const map = new LocalAdapters();
  const seen = new Set<string>();
  for (const dir of [builtinDir(), userAdapterDir()]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
      try {
        const a = JSON.parse(readFileSync(join(dir, f), "utf8")) as Adapter;
        if (!a.name || !a.command || !Array.isArray(a.argsTemplate)) continue;
        if (seen.has(a.name)) continue; // user adapters may override builtins
        map.set(a.name, a);
        seen.add(a.name);
      } catch {
        // skip malformed adapter
      }
    }
  }
  return map as unknown as Map<string, Adapter>;
}

// Small helper class so we can cast to Map-like easily
class LocalAdapters extends Map<string, Adapter> {}

export function saveUserAdapter(adapter: Adapter) {
  const file = join(userAdapterDir(), `${adapter.name}.json`);
  writeFileSync(file, JSON.stringify(adapter, null, 2));
  return file;
}

export function adaptersDir(): string {
  return userAdapterDir();
}
