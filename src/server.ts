import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type Anthropic from "@anthropic-ai/sdk";
import { assertConfig, config } from "./config.js";
import { runAgent, type AgentEvent, type StoredResult } from "./agent.js";
import { safeTz } from "./dates.js";
import { addMessage, ensureConversation, getMessages, listConversations } from "./db.js";
import { buildMemoryContext, rememberTurn } from "./memory.js";

assertConfig();
const app = new Hono();

app.get("/api/conversations", (c) => c.json(listConversations()));
app.get("/api/conversations/:id", (c) =>
  c.json(
    getMessages(c.req.param("id"), 200).map(({ role, content, meta }) => ({
      role, content, searches: meta ? JSON.parse(meta) : [],
    })),
  ),
);

app.post("/api/chat", async (c) => {
  const body = await c.req.json().catch(() => null) as { conversationId?: string; message?: string; tz?: string } | null;
  const convId = body?.conversationId;
  const text = body?.message?.trim();
  if (!convId || !text) return c.json({ error: "conversationId and message are required" }, 400);
  const tz = safeTz(body?.tz);

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const send = (data: unknown) => { stream.writeSSE({ data: JSON.stringify(data) }).catch(() => {}); };

    try {
      const now = Date.now();
      const history: Anthropic.MessageParam[] = getMessages(convId).map((m) => ({ role: m.role, content: m.content }));
      const memory = buildMemoryContext(text, now, tz, convId);
      ensureConversation(convId, text, now);
      addMessage(convId, "user", text, now);

      // Keep each search and its results so the activity block survives a reload.
      const searches = new Map<string, { query: string; kind?: string; recency?: string; since?: string; results: StoredResult[]; error?: string }>();
      const emit = (e: AgentEvent) => {
        if (e.type === "search") searches.set(e.id, { query: e.query, kind: e.kind, recency: e.recency, since: e.since, results: [] });
        else if (e.type === "results") {
          const s = searches.get(e.id);
          if (s) { s.results = e.results; s.error = e.error; }
        }
        send(e);
      };

      const { answer, searched, urls } = await runAgent({
        history, userText: text, memory, now, tz, emit, signal: ac.signal,
      });

      const msgId = addMessage(
        convId, "assistant", answer, Date.now(),
        searches.size ? JSON.stringify([...searches.values()]) : null,
      );
      send({ type: "done" });
      if (searched) {
        rememberTurn({ convId, messageId: msgId, question: text, answer, urls, now: Date.now() })
          .catch((e) => console.error("memory extraction failed:", e));
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      console.error(err);
      send({ type: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    }
  });
});

app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Chat agent running at http://localhost:${info.port}`);
});
