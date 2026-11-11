import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { describeNow, iso, localYmd } from "./dates.js";
import { braveSearch, formatResults, type SearchInput } from "./search.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

/** What we keep per result: enough to audit an answer against its evidence later. */
export type StoredResult = { title: string; url: string; snippet?: string; age?: string };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export type AgentEvent =
  | { type: "search"; id: string; query: string; kind?: string; recency?: string; since?: string }
  | { type: "results"; id: string; results: StoredResult[]; error?: string }
  | { type: "text"; delta: string };

const SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs, publish ages and snippets. Call it several times in the same turn (in parallel), one subject per query. Use type 'news' for 'what was announced, launched or reported' and 'web' for pages such as pricing, docs and changelogs. Use `since` for 'what changed since <date>' and `recency` for 'latest'.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Short, specific query naming ONE subject, e.g. 'Pipedrive announces' or 'Attio changelog'. No filler words." },
      type: { type: "string", enum: ["web", "news"], description: "news = news index (launches, announcements). Default web." },
      recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Only pages from this period." },
      since: { type: "string", description: "YYYY-MM-DD. Only pages published on or after this date." },
    },
    required: ["query"],
  },
};

function systemPrompt(now: number, tz: string, memory: string): string {
  return `You are a chat agent with one tool, web_search. Be as accurate, current and pleasant to talk to as the best assistants on the internet.

Now: ${describeNow(now, tz)}. Today's date is ${iso(localYmd(now, tz))}. Your training data is out of date for anything recent; the web is the source of truth.

How to work:
- Search for anything that can change (prices, versions, news, people, releases) or that you are not sure of. Skip search for stable knowledge and small talk.
- Issue independent searches in parallel in one step. Prefer targeted queries (official pricing page, changelog, release notes). Search again if results are weak or stale; stop once you can answer.
- For "what changed since <date>": search with \`since\`, compare against what was true on that date, and answer per item as CHANGED / UNCHANGED / COULDN'T VERIFY, with the old and new value.
- Query craft: one subject per query, official name first, then what you want ("Pipedrive announces", "Attio changelog", "HubSpot pricing page"). No filler like "new feature launch pricing" in one string; it returns noise. For "shipped, launched, announced, changed" questions run, per subject, a type "news" search with \`since\` AND a web search for its changelog or pricing page. If a result is clearly about something else, ignore it. If nothing relevant turns up, say which searches you ran and that you found nothing.
- Lead with the answer. Be concise, use short lists or tables when comparing, and cite sources inline as markdown links. Say how fresh the evidence is when it matters ("as of the pricing page, 2026-11-08").
- Never claim you verified something you did not. If sources conflict or are thin, say so plainly.
- Do not narrate that you are about to search; just call the tool.
- <memory> is a partial view: the most recent claims plus keyword matches. A claim you stated earlier in THIS chat came from real evidence, so never retract it just because it is not in <memory> now.
- Questions about earlier conversations: use ONLY the <memory> block below. If it has nothing, say you have no record of it. Never invent past conversations. Then, if asked whether an old answer still holds, re-check its claims with search rather than trusting memory.
- Ask one short clarifying question only when you truly cannot proceed (for example "those 5 tools" and memory does not say which).
${memory ? `\n<memory>\n${memory}\n</memory>` : ""}`;
}

export async function runAgent(args: {
  history: Anthropic.MessageParam[];
  userText: string;
  memory: string;
  now: number;
  tz: string;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<{ answer: string; searched: boolean; urls: string[] }> {
  const { emit, tz, signal } = args;
  const messages: Anthropic.MessageParam[] = [...args.history, { role: "user", content: args.userText }];
  const system = systemPrompt(args.now, tz, args.memory);
  const urls = new Set<string>();
  let answer = "";
  let searched = false;

  for (let round = 0; ; round++) {
    const stream = client.messages.stream(
      {
        model: config.model,
        max_tokens: 4096,
        system,
        tools: [SEARCH_TOOL],
        tool_choice: round >= config.maxRounds ? { type: "none" } : { type: "auto" },
        messages,
      },
      { signal },
    );
    stream.on("text", (delta) => {
      answer += delta;
      emit({ type: "text", delta });
    });
    const msg = await stream.finalMessage();

    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) break;

    searched = true;
    messages.push({ role: "assistant", content: msg.content });
    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
        const input = u.input as SearchInput;
        emit({ type: "search", id: u.id, query: String(input.query ?? ""), kind: input.type, recency: input.recency, since: input.since });
        try {
          const found = await braveSearch(input, tz);
          found.forEach((r) => urls.add(r.url));
          emit({
            type: "results", id: u.id,
            results: found.map((r) => ({ title: r.title, url: r.url, snippet: clip(r.snippet, 400), age: r.age })),
          });
          return { type: "tool_result", tool_use_id: u.id, content: formatResults(found) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emit({ type: "results", id: u.id, results: [], error: message });
          return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Search failed: ${message}. Retry with a different query or say you could not verify.` };
        }
      }),
    );
    messages.push({ role: "user", content: results });
    if (answer && !answer.endsWith("\n\n")) {
      answer += "\n\n";
      emit({ type: "text", delta: "\n\n" });
    }
  }

  // Keep only URLs the answer actually cites for the memory record.
  const cited = [...urls].filter((u) => answer.includes(u));
  return { answer: answer.trim(), searched, urls: cited };
}
