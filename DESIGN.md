# DESIGN

## How it works
A Hono server streams (SSE) a hand-written tool-use loop over the Anthropic API. The model has one tool, `web_search`, backed by Brave. Everything else is plain code around it.

1. **Pre-step (code, before the model).** `dates.ts` resolves phrases like "Monday", "last Tuesday", "3 November", "2 weeks ago" to absolute dates in the user's timezone. `memory.ts` then pulls what was said on those days and any related stored claims, and puts them in the system prompt as `<memory>`. The model also gets the current date/time/timezone.
2. **Loop.** Sonnet streams its answer, calls `web_search` (several in parallel per step, max 4 rounds, then forced to answer). `since` and `recency` map to Brave's `freshness` filter, so "what changed since Monday" searches only newer pages.
3. **Post-step (async).** After the answer streams, Haiku extracts discrete claims into SQLite. A claim that contradicts an existing one gets an `updates` edge and the old one is marked superseded.

## Why this shape
- **The test prompts are about time and recall, not search.** So memory and date maths are the core, and they are deterministic code, not model guesses.
- **Memory is not a second tool.** The brief says one tool. A pre-step also removes a model round trip and the risk of it forgetting to look.
- **Supermemory-style memory without the infrastructure.** Claims have timestamps, sources, status and graph edges. That is a graph in an `edges` table in SQLite plus FTS5 for keywords. "Is your answer still correct?" becomes: load old claims, re-search them, compare, and record the update.
- **Speed.** Tokens stream from the first byte, searches run in parallel, the 10-minute search cache avoids repeats, and extraction never blocks the response. The UI shows searches live.
- **Honesty.** The prompt demands CHANGED / UNCHANGED / COULDN'T VERIFY per item, dated sources, and "no record" when memory is empty.

## Considered and rejected
- **Agent frameworks** (LangChain etc.): opaque, slower, harder to defend line by line.
- **Graph database (Neo4j):** a server and a driver for a tiny, shallow graph; breaks "npm install, npm run dev".
- **Vector memory:** fuzzy where the questions need exact dates and entities.
- **Memory as a model-callable tool:** extra latency, can be skipped by the model.
- **Anthropic's built-in web search:** less control over date filters than Brave's `freshness`.
- **Planner/critic multi-agent setup:** latency for little gain at this scope.

## Known limits
- Weekday phrases resolve to the most recent *past* occurrence; ambiguity is flagged to the model, not asked about.
- Memory recall is keyword (FTS5) + date based; single-user, no auth.
- Extraction quality depends on Haiku; a bad claim is possible, and old ones are never deleted, only superseded.

## With another week
Embeddings for fuzzy recall alongside FTS; a proper "re-verify" mode that re-searches each stored claim automatically and reports a diff; fetching full pages for pricing (snippets can miss tables); evals with a fixed question set and a judge model; per-user memory and auth; prompt caching on the system prompt.

## Architecture diagrams
GitHub renders these Mermaid diagrams.

### System overview

```mermaid
flowchart LR
  UI["Browser UI<br/>public/index.html"] -->|"POST /api/chat"| API["Hono server<br/>src/server.ts"]
  API -->|"SSE stream: text, search, results"| UI
  API --> PRE["Pre-step<br/>dates.ts + memory.ts"]
  PRE --> LOOP["Agent loop<br/>agent.ts"]
  LOOP <-->|"messages + tool calls"| CLAUDE["Claude Sonnet"]
  LOOP <-->|"web_search"| BRAVE["Brave Search API<br/>search.ts"]
  PRE <--> DB[("SQLite<br/>db.ts")]
  API --> DB
  API -.->|"after the reply"| POST["Post-step: claim extraction<br/>Claude Haiku"]
  POST --> DB
```

### One chat turn

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser
  participant S as Server
  participant M as Memory pre-step
  participant A as Agent loop
  participant C as Claude Sonnet
  participant B as Brave Search
  participant D as SQLite
  participant H as Claude Haiku

  U->>S: POST /api/chat (conversationId, message, timezone)
  S->>D: load this conversation's history
  S->>M: buildMemoryContext(message)
  M->>M: resolve "Monday", "3 November" to real dates
  M->>D: messages on those dates, keyword matches, latest claims
  M-->>S: memory block
  S->>D: save the user message
  S->>A: runAgent(history, message, memory)
  loop up to 4 rounds, then a forced final answer
    A->>C: stream (system prompt, history, web_search tool)
    C-->>A: text deltas and/or tool_use blocks
    A-->>U: text deltas over SSE
    opt Claude called web_search (parallel calls)
      A-->>U: search event (query, filter)
      A->>B: web or news query with freshness filter
      B-->>A: results (title, url, snippet, age)
      A->>A: drop results unrelated to the query subject
      A-->>U: results event
    end
  end
  A-->>S: final answer, searches, cited URLs
  S->>D: save the reply and its searches (meta)
  S-->>U: done
  S--)H: extract claims (async, after the reply)
  H->>D: insert new memories, supersede changed ones
```

### Database

```mermaid
erDiagram
  conversations ||--o{ messages : contains
  messages ||--o{ memories : "message_id"
  memories ||--o| memories_fts : "same rowid"
  memories ||--o{ edges : "from_id (newer)"
  memories ||--o{ edges : "to_id (older)"

  conversations {
    TEXT id PK
    TEXT title
    INTEGER created_at
    INTEGER updated_at
  }
  messages {
    INTEGER id PK
    TEXT conv_id
    TEXT role "user or assistant"
    TEXT content
    INTEGER created_at "epoch ms"
    TEXT meta "JSON: searches with results"
  }
  memories {
    INTEGER id PK
    TEXT conv_id
    INTEGER message_id
    TEXT text "one checkable claim"
    TEXT topic "entity and aspect"
    INTEGER observed_at "epoch ms"
    TEXT source_urls "JSON array"
    TEXT status "current or superseded"
  }
  edges {
    INTEGER from_id "newer memory"
    INTEGER to_id "older memory"
    TEXT type "updates"
  }
  memories_fts {
    TEXT text
    TEXT topic
  }
```

#### Memory lifecycle

```mermaid
stateDiagram-v2
  [*] --> current: Haiku extracts a new claim
  current --> superseded: a newer claim "updates" it (edge added)
  current --> current: restated claim refreshes date and sources
  superseded --> [*]: kept for history, never deleted
```

### "Is your answer still correct?"

```mermaid
flowchart TD
  Q["User: Has X changed since last Monday?"] --> D["Code resolves 'last Monday' to a date"]
  D --> R["Pull that day's messages and related stored claims"]
  R --> S["Model re-searches each claim with the since filter"]
  S --> E{"Evidence?"}
  E -->|"newer value found"| CH["Answer CHANGED, old vs new"]
  E -->|"same value, fresh source"| UN["Answer UNCHANGED"]
  E -->|"nothing recent or conflicting"| UV["Answer COULDN'T VERIFY"]
  CH --> W["New claim saved, old one superseded"]
  UN --> W2["Claim restated, kept"]
```
