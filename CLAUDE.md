# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [AGENTS.md](AGENTS.md) first**. It holds the project conventions (no `console.log`, error model,
one-way imports, date handling, `activity_id` validation, SPDX headers). [ARCHITECTURE.md](ARCHITECTURE.md)
covers the full design and the caching semantics. This file adds what those two leave out.

## Commands

```bash
npm install
npm run build                         # tsc -> build/
npm test                              # vitest run (the script injects dummy INTERVALS_* env vars)
npm test -- __tests__/ema.test.ts     # a single test file
npm test -- -t "READ_ONLY"            # tests whose name matches
npm run dev                           # MCP server from source over stdio (needs .env)
npm run cli:dev -- list               # CLI from source; `<tool> '<json-args>' [--raw]` runs one tool
npx @modelcontextprotocol/inspector node build/index.js   # try tools interactively
```

There is no linter. CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build && npm test` on Node 20 and 22,
so the code must build with `tsc` as well as pass the tests. `config.ts` validates env vars at import time,
so anything that imports it needs `INTERVALS_ATHLETE_ID` and `INTERVALS_API_KEY` set. See `.env.example`
for every optional variable (`ATHLETE_TIMEZONE`, `MCP_TRANSPORT`, `CACHE_DIR`, `READ_ONLY`, `LBSS_FIELD`, …).

## How the pieces fit

- `src/tool-registry.ts` defines the `ToolDef` contract and the `TOOLS` array. `getActiveTools()` is the
  single place that applies `READ_ONLY` filtering: it withholds tools marked `writesAccount: true`.
  Both surfaces must go through it. Mark any new tool that writes to the Intervals.icu account with
  `writesAccount: true`. Local-only side effects, such as the cache tools, don't count as account writes.
- There are two independent composition roots: `index.ts` (MCP over stdio or Streamable HTTP) and `cli.ts`.
  They must never import each other. `tool-registry.ts` and `adapters/` must not import express or `index.ts`.
- `core/intervals-client.ts` routes every call through a single private `request()`. Only activity streams
  are cached, on disk, with no TTL.
- `src/instructions.ts` is the text sent to AI clients on how to pick tools. Tool descriptions and these
  instructions are part of the product, so keep them accurate when you change behavior.

## Tests that enforce invariants (and go red on purpose)

- **`tool-inventory.test.ts`**: a new or renamed tool has to be updated in all of these places: the
  `EXPECTED_TOOLS` list and counts in the test (total and READ_ONLY-withheld), `manifest.json` `tools[]`,
  and both the "Recommended workflow" and "Tool selection guide" sections of `src/instructions.ts`.
- **`console-error-allowlist.test.ts`**: fixes the number of `console.error` calls per file. Adding a log
  call means updating `ALLOWLIST` on purpose, after checking that the line cannot leak credentials or
  upstream response bodies (`log-sentinel.test.ts` covers the latter).
- **`version.test.ts`**: `manifest.json` `version` must equal `package.json` `version`. Bump both when releasing.
- **PII guards** (`metadata-pii`, `artifact-pii`, `scripts/check-mcpb-pii.mjs`): identity data comes from
  `pii-guard.config.json`, plus a gitignored `.pii-forbidden` for the deep checks. Example emails in docs use
  RFC 2606 domains (`example.com`, `.test`), and example home paths use the username `you`
  (`/home/you/`, `/Users/you/`).

## Domain notes

- Intervals.icu field names are not intuitive (`icu_average_watts`, `icu_training_load`, `icu_ctl`, …).
  A wrong field name fails silently as `undefined`, so check real `get_activity_detail` output before
  referencing a field.
- The Stryd extension (`src/extensions/stryd/`) builds a dual PMC from RSS and LBSS (read from a custom
  activity field, `LBSS_FIELD`, default `StrydLBSSv2`) and includes a Critical Impact (CI) estimator and table.
  Deterministic math stays in pure, unit-tested functions. The LLM is handed finished numbers to interpret.
- `docs/` holds the design notes (`STREAMS_DESIGN.md`, `PHASE3_DESIGN.md`, `CLI.md`). `DEVELOPMENT_GUIDE.md`
  is in Japanese and documents the PII guard / gitleaks workflow.
