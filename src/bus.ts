import { DatabaseSync } from "node:sqlite";

// Roundtable bus — the shared session transcript.
// Every exchange (host asks, guest answers, worker events) is logged here,
// so any agent at the table shares one conversation history.

export interface TurnRow {
  id: number;
  session_id: string;
  seq: number;
  role: "host" | "user" | string; // "user" (human), host agent name, or guest agent name
  agent: string | null; // adapter name for guests, null for human
  model: string | null;
  kind: "ask" | "answer" | "check" | "review" | "event" | "note";
  content: string;
  meta: string | null; // JSON blob
  created_at: string;
}

export interface EventRow {
  id: number;
  session_id: string;
  turn_id: number | null;
  agent: string;
  event: string; // tool_call | file_edit | file_read | spawn | exit | error
  detail: string | null; // JSON blob
  created_at: string;
}

export class Bus {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        host TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        git_branch TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id INTEGER,
        agent TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
    `);
  }

  session(id: string): { id: string; host: string | null; created_at: string; git_branch: string | null } | undefined {
    const row = this.db
      .prepare("SELECT id, host, created_at, git_branch FROM sessions WHERE id = ?")
      .get(id) as any;
    if (!row) {
      this.db.prepare("INSERT OR IGNORE INTO sessions (id) VALUES (?)").run(id);
      return this.session(id);
    }
    return row;
  }

  setHost(id: string, host: string) {
    this.session(id);
    this.db.prepare("UPDATE sessions SET host = ? WHERE id = ?").run(host, id);
  }

  setGitBranch(id: string, branch: string) {
    this.db.prepare("UPDATE sessions SET git_branch = ? WHERE id = ?").run(branch, id);
  }

  addTurn(input: {
    session_id: string;
    role: string;
    agent?: string | null;
    model?: string | null;
    kind: TurnRow["kind"];
    content: string;
    meta?: unknown;
  }): TurnRow {
    this.session(input.session_id);
    const seq = (this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE session_id = ?")
      .get(input.session_id) as any).n;
    const meta = input.meta === undefined ? null : JSON.stringify(input.meta);
    const r = this.db
      .prepare(
        `INSERT INTO turns (session_id, seq, role, agent, model, kind, content, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.session_id, seq, input.role, input.agent ?? null, input.model ?? null, input.kind, input.content, meta);
    return this.getTurn(Number(r.lastInsertRowid))!;
  }

  getTurn(id: number): TurnRow | undefined {
    return this.db
      .prepare("SELECT id, session_id, seq, role, agent, model, kind, content, meta, created_at FROM turns WHERE id = ?")
      .get(id) as any;
  }

  history(sessionId: string, limit = 10): TurnRow[] {
    return this.db
      .prepare(
        `SELECT id, session_id, seq, role, agent, model, kind, content, meta, created_at
         FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
      )
      .all(sessionId, limit)
      .reverse() as any;
  }

  addEvent(input: { session_id: string; turn_id?: number | null; agent: string; event: string; detail?: unknown }) {
    this.db
      .prepare("INSERT INTO events (session_id, turn_id, agent, event, detail) VALUES (?, ?, ?, ?, ?)")
      .run(input.session_id, input.turn_id ?? null, input.agent, input.event, input.detail === undefined ? null : JSON.stringify(input.detail));
  }

  events(sessionId: string, agent?: string): EventRow[] {
    if (agent) {
      return this.db
        .prepare("SELECT * FROM events WHERE session_id = ? AND agent = ? ORDER BY id")
        .all(sessionId, agent) as any;
    }
    return this.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY id").all(sessionId) as any;
  }

  close() {
    this.db.close();
  }
}
