# minimi chat agent

A streaming chat agent with exactly one tool, **web search**, plus a dated memory that lets it answer questions like *"What did you tell me on Monday?"* or *"Has that pricing changed since last week?"*.

Relative dates are resolved in code (not guessed by the model), past answers are stored as timestamped claims in SQLite, and newer evidence supersedes older claims instead of overwriting them. The reasoning behind these choices is in [DESIGN.md](DESIGN.md).

## Features

- **Streaming answers** over Server-Sent Events, with searches and their results shown live in the UI.
- **One tool: `web_search`** (Brave Search API), web or news index, with `since` / `recency` freshness filters. Parallel calls, up to 4 rounds per turn, 10-minute result cache.
- **Date-aware recall.** Phrases like "Monday", "last Tuesday", "3 November" or "2 weeks ago" are resolved to real dates in the user's timezone before the model runs.
- **Claim memory.** After each reply, a fast model extracts checkable claims with sources. A contradicting newer claim marks the old one `superseded` and links them with an `updates` edge, so history is kept.
- **Honest re-verification.** When asked whether an earlier answer still holds, the agent reports each item as CHANGED, UNCHANGED or COULDN'T VERIFY, with dated sources.
- **No build step.** A single-file HTML UI, served by the same Hono server.

## Stack

TypeScript · [Hono](https://hono.dev) · [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) · [Brave Search API](https://brave.com/search/api/) · SQLite via `better-sqlite3` (with FTS5)

## Getting started

Requirements: Node.js 20+, an Anthropic API key, and a Brave Search API key.

```bash
git clone <this-repo-url>
cd minimi-chat-agent
cp .env.example .env    # then add ANTHROPIC_API_KEY and BRAVE_API_KEY
npm install
npm run dev             # http://localhost:3000
```

### Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | | Claude API access |
| `BRAVE_API_KEY` | yes | | Brave Search API access |
| `AGENT_MODEL` | no | `claude-sonnet-5-5` | Model that answers and calls the tool |
| `FAST_MODEL` | no | `claude-haiku-5-5` | Model that extracts claims after each reply |
| `PORT` | no | `3000` | HTTP port |
| `DB_PATH` | no | `./data/agent.db` | SQLite database file |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the server with file watching |
| `npm start` | Start the server |
| `npm run typecheck` | Type-check with `tsc` |
| `npm run db` | Read-only database summary |
| `npm run db -- searches [n]` | Recent replies with their saved searches and results |
| `npm run db -- memories [n]` | Recent stored claims |
| `npm run db -- messages [n]` | Recent messages |
| `npm run db -- edges` | All `updates` edges between claims |
| `npm run db -- lineage <id>` | What a claim replaced, and what replaced it |

## API

| Route | Description |
|---|---|
| `POST /api/chat` | Body `{ conversationId, message, tz }`. Streams SSE events: `text`, `search`, `results`, `done`, `error`. |
| `GET /api/conversations` | List conversations |
| `GET /api/conversations/:id` | Messages of one conversation, with their searches |

## Project layout

```
src/
  server.ts    HTTP routes, SSE streaming, persistence of messages and searches
  agent.ts     System prompt, tool definition, streaming tool-use loop
  search.ts    Brave client, freshness filters, relevance filter, cache
  dates.ts     Relative-date resolution in the user's timezone
  memory.ts    Builds the memory context; extracts claims after each reply
  db.ts        SQLite schema, queries, FTS5 search, supersede logic
  config.ts    Environment configuration
public/
  index.html   Chat UI (no build step)
scripts/
  db.mjs       Read-only database inspector
```

## Limitations

Single user, no authentication. Memory recall is keyword (FTS5) and date based, not semantic. See [DESIGN.md](DESIGN.md#known-limits) for details and next steps.
