// Layer 5 of the security model: runaway-guest guards.
// Per-call timeout and per-session spawn cap. A guest that breaches
// either is killed and reported — never silently retried.

export interface Limits {
  timeoutMs: number;
  maxSpawnsPerSession: number;
}

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: Number(process.env.HUDDLE_TIMEOUT_MS ?? 120_000),
  maxSpawnsPerSession: Number(process.env.HUDDLE_MAX_SPAWNS ?? 25),
};

export class LimitTracker {
  private counts = new Map<string, number>();
  private limits: Limits;

  constructor(limits: Limits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  canSpawn(sessionId: string): { ok: boolean; reason?: string } {
    const used = this.counts.get(sessionId) ?? 0;
    if (used >= this.limits.maxSpawnsPerSession) {
      return { ok: false, reason: `spawn cap reached (${this.limits.maxSpawnsPerSession} guests this session)` };
    }
    return { ok: true };
  }

  record(sessionId: string) {
    this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1);
  }

  release(sessionId: string) {
    const used = (this.counts.get(sessionId) ?? 1) - 1;
    this.counts.set(sessionId, Math.max(0, used));
  }

  used(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }
}
