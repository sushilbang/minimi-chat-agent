// Read-only inspector for the agent's SQLite database.
// Usage: npm run db -- <summary|searches|memories|messages|edges> [limit]
//        npm run db -- lineage <memory id>   (what a claim replaced, and what replaced it)
import Database from "better-sqlite3";
import "dotenv/config";

const path = process.env.DB_PATH ?? "./data/agent.db";
const db = new Database(path, { readonly: true, fileMustExist: true });
const [cmd = "summary", arg] = process.argv.slice(2);
const limit = Number(arg) > 0 ? Number(arg) : 10;
const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

if (cmd === "summary") {
  for (const t of ["conversations", "messages", "memories", "edges"]) {
    console.log(t.padEnd(14), db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  }
  const s = db.prepare("SELECT COUNT(*) n FROM messages WHERE meta IS NOT NULL").get().n;
  console.log("replies with saved searches".padEnd(14), s);
} else if (cmd === "searches") {
  // Newest replies that have saved searches: query, filter, and each result with snippet/age.
  const rows = db.prepare("SELECT id, conv_id, created_at, meta FROM messages WHERE meta IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit);
  for (const m of rows) {
    console.log(`\n=== message #${m.id}  ${when(m.created_at)}  conv ${m.conv_id.slice(0, 8)}`);
    for (const s of JSON.parse(m.meta)) {
      const f = (s.kind === "news" ? " [news]" : "") + (s.since ? ` [since ${s.since}]` : s.recency ? ` [past ${s.recency}]` : "");
      console.log(`\n  SEARCH: ${s.query}${f}${s.error ? "  ERROR: " + s.error : ""}`);
      for (const r of s.results) {
        console.log(`   - ${r.title}${r.age ? `  (${r.age})` : ""}\n     ${r.url}`);
        console.log(`     ${r.snippet ? r.snippet : "(no snippet stored; saved before snippets were added)"}`);
      }
    }
  }
} else if (cmd === "memories") {
  for (const m of db.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT ?").all(limit)) {
    console.log(`#${m.id} [${m.status}] ${when(m.observed_at)}  (${m.topic})\n   ${m.text}\n   sources: ${JSON.parse(m.source_urls).length}`);
  }
} else if (cmd === "messages") {
  for (const m of db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit).reverse()) {
    console.log(`\n#${m.id} ${when(m.created_at)} ${m.role.toUpperCase()}${m.meta ? "  (has searches)" : ""}\n${m.content.slice(0, 400)}`);
  }
} else if (cmd === "edges") {
  for (const e of db.prepare("SELECT * FROM edges").all()) console.log(`#${e.from_id} --${e.type}--> #${e.to_id}`);
} else if (cmd === "lineage") {
  // History of one claim: everything it replaced (older) and everything that replaced it (newer).
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) {
    console.log("Usage: npm run db -- lineage <memory id>");
    process.exit(1);
  }
  const root = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  if (!root) {
    console.log(`No memory #${id}.`);
    process.exit(1);
  }
  // The depth cap stops a corrupt cycle from looping forever (depth makes every row distinct).
  const walk = (start, fromCol, toCol) => {
    const rows = db.prepare(
      `WITH RECURSIVE chain(id, type, depth) AS (
         SELECT ${toCol}, type, 1 FROM edges WHERE ${fromCol} = ?
         UNION
         SELECT e.${toCol}, e.type, chain.depth + 1 FROM edges e JOIN chain ON e.${fromCol} = chain.id WHERE chain.depth < 20
       )
       SELECT m.*, chain.type AS edge_type, chain.depth FROM chain JOIN memories m ON m.id = chain.id
       ORDER BY chain.depth, m.id`,
    ).all(start);
    const seen = new Set([start]); // keep only the shallowest visit of each memory
    return rows.filter((m) => !seen.has(m.id) && seen.add(m.id));
  };
  const older = walk(id, "from_id", "to_id"); // what this claim replaced
  const newer = walk(id, "to_id", "from_id"); // what replaced this claim
  const line = (m, tag) => `#${m.id} [${m.status}] ${when(m.observed_at)}  ${tag}\n      ${m.text}`;

  console.log("NEWER (replaced this claim)");
  if (!newer.length) console.log("  (nothing)");
  for (const m of [...newer].reverse()) console.log(`  ${"  ".repeat(m.depth - 1)}${line(m, `-${m.edge_type}->`)}`);
  console.log(`\n>>> THIS CLAIM\n  ${line(root, "")}\n`);
  console.log("OLDER (this claim replaced)");
  if (!older.length) console.log("  (nothing)");
  for (const m of older) console.log(`  ${"  ".repeat(m.depth - 1)}${line(m, `<-${m.edge_type}-`)}`);
} else {
  console.log("Usage: npm run db -- <summary|searches|memories|messages|edges|lineage> [limit | id]");
}
