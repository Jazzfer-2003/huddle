// Context builder — what a guest sees when it joins the table.
// Two context sources stack (spec: "how agentic coding plays here"):
//   1. filesystem — the guest's own tools, spawned with cwd = project root
//   2. conversation — the shared bus history, injected into the prompt

import type { Bus } from "./bus.ts";

export function buildGuestPrompt(input: {
  task: string;
  history: string; // pre-rendered transcript lines
  roster: string; // who's at the table + models
  mode: "advise" | "act";
  asSupervisor?: boolean;
}): string {
  const modeLine =
    input.mode === "advise"
      ? "MODE: ADVISE. You are a read-only advisor. Do NOT edit files. Analyze, answer, and if a change is needed, output a unified diff as a suggestion — the host will apply it."
      : "MODE: ACT. You may edit files in the working directory directly. Make the smallest change that satisfies the task.";

  const supervisorLine = input.asSupervisor
    ? `ROLE: SUPERVISOR. Another agent worked on a task. Audit whether they did what was asked.
Return a verdict in exactly this shape:
VERDICT: ON-SPEC | OFF-SPEC | PARTIAL
FINDINGS:
- numbered list of what was done vs asked, including anything missing or wrong
PATCH (only if fixes are needed): unified diff`
    : "";

  return [
    `You are joining a shared coding session as guest agent "${"guest"}" via huddle.`,
    supervisorLine,
    modeLine,
    "",
    "PEERS AT THE TABLE:",
    input.roster,
    "",
    "SHARED TRANSCRIPT (most recent last):",
    input.history || "(empty — this is the first exchange)",
    "",
    "YOUR TASK:",
    input.task,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderHistory(bus: Bus, sessionId: string, limit = 10): string {
  return bus
    .history(sessionId, limit)
    .map((t) => `${t.role === "user" ? "human" : t.role}: ${t.content.length > 400 ? t.content.slice(0, 400) + "…" : t.content}`)
    .join("\n");
}

export function renderRoster(adapters: { name: string; model?: string | null }[]): string {
  return adapters.map((a) => `- ${a.name}${a.model ? ` (${a.model})` : ""}`).join("\n");
}
