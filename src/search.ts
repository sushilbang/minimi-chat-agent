import { config } from "./config.js";
import { iso, localYmd } from "./dates.js";

export type SearchResult = { title: string; url: string; snippet: string; age?: string };
export type SearchInput = {
  query: string;
  /** "news" hits Brave's news index: far better for "what was announced or shipped" questions. */
  type?: "web" | "news";
  recency?: "day" | "week" | "month" | "year";
  /** ISO date (YYYY-MM-DD): only results published on/after this day. */
  since?: string;
};

const ENDPOINT = {
  web: "https://api.search.brave.com/res/v1/web/search",
  news: "https://api.search.brave.com/res/v1/news/search",
} as const;
const FRESH = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
const cache = new Map<string, { at: number; results: SearchResult[] }>();
const TTL_MS = 10 * 60_000;

// Words that describe the *kind* of page wanted, not the subject. They are ignored when
// checking whether a result is about the thing we searched for.
const GENERIC = new Set(
  ("the and for with new news latest release released releases announcement announcements announce announces announced " +
    "update updates launch launched launches feature features price prices pricing plan plans change changes changed " +
    "since about what how from this that date page official changelog notes per user month year cost costs " +
    "2024 2025 2026 2027 january february march april may june july august september october november december").split(" "),
);

function subjectTokens(query: string): string[] {
  const toks = query.toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) ?? [];
  return [...new Set(toks)].filter((t) => !GENERIC.has(t));
}

/**
 * Drop results that share almost nothing with the subject of the query (a "Pipedrive" search
 * returning a pipe-flow engineering press release). Falls back to everything rather than
 * returning nothing, so a legitimate synonym never leaves the model empty-handed.
 */
export function keepRelevant(query: string, results: SearchResult[]): SearchResult[] {
  const toks = subjectTokens(query);
  if (!toks.length) return results;
  const need = Math.ceil(toks.length / 2);
  const kept = results.filter((r) => {
    const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    // The query leads with its subject ("Neon plans"), so mentioning it is enough;
    // otherwise at least half of the subject words must appear.
    return hay.includes(toks[0]) || toks.filter((t) => hay.includes(t)).length >= need;
  });
  return kept.length ? kept : results;
}

type RawResult = { title: string; url: string; description?: string; age?: string; page_age?: string; extra_snippets?: string[] };

export async function braveSearch(input: SearchInput, tz: string): Promise<SearchResult[]> {
  const type = input.type === "news" ? "news" : "web";
  const url = new URL(ENDPOINT[type]);
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", type === "news" ? "8" : "6");
  url.searchParams.set("text_decorations", "false");
  if (type === "web") url.searchParams.set("extra_snippets", "true");
  if (input.since && /^\d{4}-\d{2}-\d{2}$/.test(input.since)) {
    url.searchParams.set("freshness", `${input.since}to${iso(localYmd(Date.now(), tz))}`);
  } else if (input.recency) {
    url.searchParams.set("freshness", FRESH[input.recency]);
  }

  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": config.braveKey },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1100)); // free tier: 1 req/sec
  }
  if (!res || !res.ok) throw new Error(`Brave ${type} search failed (${res?.status ?? "no response"})`);

  const data = (await res.json()) as { web?: { results?: RawResult[] }; results?: RawResult[] };
  const raw = type === "news" ? (data.results ?? []) : (data.web?.results ?? []);
  const mapped = raw.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: [r.description, ...(r.extra_snippets ?? []).slice(0, 2)].filter(Boolean).join(" … "),
    age: r.age ?? r.page_age?.slice(0, 10),
  }));
  const results = keepRelevant(input.query, mapped);
  cache.set(key, { at: Date.now(), results });
  return results;
}

export function formatResults(results: SearchResult[]): string {
  if (!results.length) return "No results.";
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.age ? `\nPublished: ${r.age}` : ""}\n${r.snippet}`)
    .join("\n\n");
}
