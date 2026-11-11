import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
-- A memory is one checkable claim the agent made, stamped with when it was observed.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, message_id INTEGER,
  text TEXT NOT NULL, topic TEXT NOT NULL, observed_at INTEGER NOT NULL,
  source_urls TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'current'  -- current | superseded
);
-- Graph edges between memories: from (newer) --updates--> to (older).
CREATE TABLE IF NOT EXISTS edges (
  from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, type TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, topic);
`);

// Older databases predate the `meta` column (search activity shown above a reply).
if (!(db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).some((c) => c.name === "meta")) {
  db.exec("ALTER TABLE messages ADD COLUMN meta TEXT");
}

export type MessageRow = { id: number; conv_id: string; role: "user" | "assistant"; content: string; created_at: number; meta: string | null };
export type MemoryRow = {
  id: number; conv_id: string | null; message_id: number | null; text: string;
  topic: string; observed_at: number; source_urls: string; status: string;
};

export function ensureConversation(id: string, firstMessage: string, now: number): void {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  db.prepare(
    "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title, now, now);
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
}

export function addMessage(
  convId: string, role: "user" | "assistant", content: string, now: number, meta: string | null = null,
): number {
  return Number(
    db.prepare("INSERT INTO messages (conv_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)")
      .run(convId, role, content, now, meta).lastInsertRowid,
  );
}

export function getMessages(convId: string, limit = 40): MessageRow[] {
  return db.prepare(
    "SELECT * FROM (SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
  ).all(convId, limit) as MessageRow[];
}

export function listConversations(limit = 50) {
  return db.prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function messagesBetween(startMs: number, endMs: number, excludeConv: string, limit = 30): MessageRow[] {
  return db.prepare(
    "SELECT * FROM messages WHERE created_at >= ? AND created_at < ? AND conv_id != ? ORDER BY created_at LIMIT ?",
  ).all(startMs, endMs, excludeConv, limit) as MessageRow[];
}

// ---- memories ----

const STOP = new Set(
  "the a an and or but if of to in on at for with about from by is are was were be been it this that these those i you we they my our your me what which who when how why did does do has have had can could would should will any all some than then there their them his her its as not so very just also into over since".split(" "),
);

function ftsQuery(text: string): string | null {
  const toks = [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 12);
  return toks.length ? toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ") : null;
}

export function searchMemories(text: string, limit = 8): MemoryRow[] {
  const q = ftsQuery(text);
  if (!q) return [];
  return db.prepare(
    `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
     WHERE memories_fts MATCH ? AND m.status = 'current' ORDER BY rank LIMIT ?`,
  ).all(q, limit) as MemoryRow[];
}

/** Latest current claims, regardless of keywords, so recall never depends on word overlap alone. */
export function recentMemories(limit = 8): MemoryRow[] {
  return db.prepare("SELECT * FROM memories WHERE status = 'current' ORDER BY observed_at DESC, id DESC LIMIT ?").all(limit) as MemoryRow[];
}

export function insertMemory(m: {
  convId: string; messageId: number; text: string; topic: string; observedAt: number; sources: string[];
}): number {
  const id = Number(
    db.prepare(
      "INSERT INTO memories (conv_id, message_id, text, topic, observed_at, source_urls) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(m.convId, m.messageId, m.text, m.topic, m.observedAt, JSON.stringify(m.sources)).lastInsertRowid,
  );
  db.prepare("INSERT INTO memories_fts (rowid, text, topic) VALUES (?, ?, ?)").run(id, m.text, m.topic);
  return id;
}

/** A restated claim was re-confirmed: refresh its date and merge sources instead of duplicating it. */
export function touchMemory(id: number, observedAt: number, sources: string[]): void {
  const row = db.prepare("SELECT source_urls FROM memories WHERE id = ?").get(id) as { source_urls: string } | undefined;
  if (!row) return;
  const merged = [...new Set([...(JSON.parse(row.source_urls) as string[]), ...sources])].slice(0, 12);
  db.prepare("UPDATE memories SET observed_at = ?, source_urls = ? WHERE id = ?").run(observedAt, JSON.stringify(merged), id);
}

/** Record that `newId` replaces `oldId`: add the graph edge and retire the old fact. */
export function supersede(newId: number, oldId: number): void {
  db.prepare("INSERT INTO edges (from_id, to_id, type) VALUES (?, ?, 'updates')").run(newId, oldId);
  db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ?").run(oldId);
}
