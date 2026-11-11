import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { iso, localYmd, rangeMs, resolveDates } from "./dates.js";
import { insertMemory, messagesBetween, recentMemories, searchMemories, supersede, touchMemory, type MemoryRow } from "./db.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

const day = (ms: number, tz: string) => iso(localYmd(ms, tz));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Pre-step, run in code before the model sees the turn: resolve date phrases,
 * pull what was said on those days, and pull related remembered claims.
 * Memory is therefore not a second tool the model must remember to call.
 */
export function buildMemoryContext(userText: string, now: number, tz: string, convId: string): string {
  const hints = resolveDates(userText, now, tz);
  const parts: string[] = [];

  if (hints.length) {
    parts.push(
      "Date phrases resolved by code (most recent past occurrence; mention if ambiguous):\n" +
        hints.map((h) => `- "${h.phrase}" = ${h.from === h.to ? h.from : `${h.from} to ${h.to}`}`).join("\n"),
    );
    const seen = new Set<number>();
    const lines: string[] = [];
    for (const h of hints) {
      const [s, e] = rangeMs(h.from, h.to, tz);
      for (const m of messagesBetween(s, e, convId)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        lines.push(`[${day(m.created_at, tz)} ${new Date(m.created_at).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" })}] ${m.role}: ${clip(m.content, 700)}`);
      }
    }
    parts.push(
      lines.length
        ? "Earlier conversation on those dates:\n" + lines.join("\n")
        : "Nothing was said in earlier conversations on those dates.",
    );
  }

  // Keyword matches first, then the latest claims, so an unrelated question still sees recent notes.
  const byId = new Map<number, MemoryRow>();
  for (const m of [...searchMemories(userText), ...recentMemories(8)]) byId.set(m.id, m);
  const mems = [...byId.values()].slice(0, 14);
  if (mems.length) {
    parts.push(
      "Claims from earlier answers (matching this message, plus the most recent; may be stale, re-verify if the user asks about changes):\n" +
        mems.map((m) => `- (#${m.id}, observed ${day(m.observed_at, tz)}) [${m.topic}] ${m.text}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ---- extraction: turn an answer into atomic claims, without duplicating what we already know ----

type Claim = { text: string; topic: string };
type Verdict = { index: number; relation: "new" | "same" | "updates"; target_ids?: number[] };

const EXTRACT_SYSTEM = `You extract durable, checkable facts from an assistant's answer for a memory store.
Return ONLY JSON: {"claims":[{"text":string,"topic":string}]}
- ATOMIC: one fact per claim. Never combine several facts, and never restate the same fact in different words.
- Self-contained: name the entity, the value, and any date.
- topic: short entity + aspect, e.g. "Node.js 26 release date", "HubSpot Sales Hub pricing".
- Max 8. Skip opinions, chit-chat, advice, and anything the answer does not support.
- Nothing worth keeping: {"claims":[]}.`;

const JUDGE_SYSTEM = `You decide how new claims relate to existing memories.
Return ONLY JSON: {"verdicts":[{"index":number,"relation":"new"|"same"|"updates","target_ids":number[]}]}
- "same": the claim states the same fact as an existing memory (wording may differ, or the existing one already contains it). target_ids = [that memory].
- "updates": same subject but the value changed or is contradicted. target_ids = EVERY existing memory the new claim contradicts or replaces (several memories may repeat the old value).
- "new": a fact not covered by any candidate. target_ids = [].
- Be strict about "same": if the value or date differs, it is "updates", not "same".
One verdict per claim index.`;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? []);
function similarity(a: string, b: string): number {
  const x = words(a), y = words(b);
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / Math.max(1, Math.min(x.size, y.size)); // overlap coefficient: containment counts as a match
}

function parseJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function ask(system: string, content: string, maxTokens: number): Promise<string> {
  const res = await client.messages.create({
    model: config.fastModel, max_tokens: maxTokens, system, messages: [{ role: "user", content }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** Runs after the answer has streamed, so it adds no user-facing latency. */
export async function rememberTurn(args: {
  convId: string; messageId: number; question: string; answer: string; urls: string[]; now: number;
}): Promise<void> {
  // 1. Extract atomic claims from the answer alone.
  const extracted = parseJson<{ claims?: Claim[] }>(
    await ask(EXTRACT_SYSTEM, `QUESTION:\n${args.question}\n\nANSWER:\n${args.answer}`, 1500),
  )?.claims?.filter((c) => c?.text && c.topic).slice(0, 8) ?? [];
  if (!extracted.length) return;

  // 2. For each claim, fetch its nearest stored neighbours by its OWN text.
  //    (Searching by the whole question+answer missed old claims on other subjects.)
  const candidates = new Map<number, MemoryRow>();
  const perClaim = extracted.map((c) => {
    const near = searchMemories(`${c.topic} ${c.text}`, 4);
    near.forEach((m) => candidates.set(m.id, m));
    return near;
  });

  // 3. Code-level guard: a near-verbatim restatement is "same" without asking a model.
  const verdicts = new Map<number, Verdict>();
  extracted.forEach((c, i) => {
    const twin = perClaim[i].find((m) => similarity(c.text, m.text) >= 0.85);
    if (twin) verdicts.set(i, { index: i, relation: "same", target_ids: [twin.id] });
  });

  // 4. Ask the model only about claims that have neighbours but no verbatim twin.
  const undecided = extracted.map((_, i) => i).filter((i) => !verdicts.has(i) && perClaim[i].length);
  if (undecided.length) {
    const judged = parseJson<{ verdicts?: Verdict[] }>(
      await ask(
        JUDGE_SYSTEM,
        `NEW CLAIMS:\n${undecided.map((i) => `${i}. [${extracted[i].topic}] ${extracted[i].text}`).join("\n")}\n\n` +
          `EXISTING memories:\n${[...candidates.values()].map((m) => `#${m.id} [${m.topic}] ${m.text}`).join("\n")}`,
        800,
      ),
    )?.verdicts ?? [];
    for (const v of judged) if (undecided.includes(v.index)) verdicts.set(v.index, v);
  }

  // 5. Apply. Restated claims refresh the old row; changed ones supersede it; the rest are new.
  extracted.forEach((c, i) => {
    const v = verdicts.get(i);
    const targets = (v?.target_ids ?? []).filter((id) => candidates.has(id));
    if (v?.relation === "same" && targets.length) return touchMemory(targets[0], args.now, args.urls);
    const newId = insertMemory({
      convId: args.convId, messageId: args.messageId, text: c.text, topic: c.topic,
      observedAt: args.now, sources: args.urls,
    });
    if (v?.relation === "updates") for (const id of targets) supersede(newId, id);
  });
}
