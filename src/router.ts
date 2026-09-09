// Router — resolves who's at the table and builds the roster.
// Security layer 2: a guest name must match a registered adapter.
// User text can never reach the exec path — only manifest commands run.

import type { Adapter } from "./adapters.ts";
import type { Bus } from "./bus.ts";
import { buildGuestPrompt, renderHistory, renderRoster } from "./context.ts";

export function resolveAdapter(adapters: Map<string, Adapter>, name: string): Adapter {
  const a = adapters.get(name);
  if (!a) {
    throw new Error(
      `Unknown agent "${name}". Registered: ${[...adapters.keys()].join(", ")}. Add yours via ~/.huddle/adapters/<name>.json`
    );
  }
  return a;
}

export function rosterEntries(adapters: Map<string, Adapter>, present: string[]): { name: string; model?: string | null }[] {
  return present
    .map((n) => adapters.get(n))
    .filter(Boolean)
    .map((a) => ({ name: a!.name, model: a!.defaultModel }));
}

export function guestPromptFor(
  adapters: Map<string, Adapter>,
  bus: Bus,
  sessionId: string,
  present: string[],
  input: { task: string; mode: "advise" | "act"; asSupervisor?: boolean }
): string {
  return buildGuestPrompt({
    task: input.task,
    history: renderHistory(bus, sessionId),
    roster: renderRoster(rosterEntries(adapters, present)),
    mode: input.mode,
    asSupervisor: input.asSupervisor,
  });
}
