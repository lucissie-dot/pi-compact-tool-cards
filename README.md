# pi-compact-tool-cards

A [pi](https://pi.dev) extension that collapses tool-call noise in the TUI: every tool call in a
single request is folded into **one compact summary block** instead of one row per call.

> Renders the TUI only. It does **not** change tool results or inject messages into the model
> context — with one exception: it registers the seven built-in tools by name, which makes pi
> activate `grep`/`find`/`ls` (see [Context / token impact](#context--token-impact)).

## Features

- **Aggregate mode (default)** — while a request runs, only one progress line is visible
  (`⏳ processing N operations · latest: …`). When it finishes, all tool rows disappear and a single
  summary block is appended under the answer, e.g.
  `🔧 8 operations: ✏️ 5 files changed · 📖 3 files read · 💻 2 commands · 🔍 1 search`.
- **`Ctrl+O` to expand** — per-item detail with edit `+a / −r` stats and the first line of any error.
  Large requests keep the **first 5 and last 15** items with an omission marker in between.
- **v1 mode** (`PI_COMPACT_TOOLS_AGGREGATE=0`) — one compact row per tool (call row + one-line result),
  expandable with `Ctrl+O`.
- **Session restore** — history is rebuilt from `compact-tools.group` session entries, so `pi -c`
  reopens with summary blocks (no ghost tool rows) and nothing is re-executed.
- **Zero context delta** apart from the activated tool schemas: the registered definitions are
  byte-identical to the built-ins and `execute` returns the built-in result by the same reference.

## Install

```bash
pi install git:github.com/lucissie-dot/pi-compact-tool-cards@v0.1.0

# try without installing (temporary)
pi -e git:github.com/lucissie-dot/pi-compact-tool-cards@v0.1.0
```

Manual / offline: copy `extensions/compact-tools.ts` to `~/.pi/agent/extensions/` (global) or
`.pi/extensions/` (project-local), then `/reload`.

> Don't do both. If you install the package **and** keep a loose `compact-tools.ts` in
> `~/.pi/agent/extensions/`, the same seven tools are registered twice.

## Requirements

- pi `0.85.1` is the baseline (developed and tested against it).
- The extension overrides built-in tools and depends on pi internals
  (`createXxxToolDefinition`, `renderShell: "self"`, `SettingsManager`, entry rendering).
  After a pi upgrade, run the checklist in the detailed docs (§7).

## Context / token impact

Registering the seven built-in tools makes pi activate `grep`, `find` and `ls` (pi activates all
extension-registered tools; the default built-in set is only `read`/`bash`/`edit`/`write`).

| Metric | Value |
| --- | --- |
| Extra tool schemas per request | ≈ **2.2 KB ≈ 545 tokens** (pi's `chars/4` estimate) |
| Measured over an 83-request session | **0.39%** of all prompt tokens, **0.73%** of cost |
| Share of a single request | ~**7.7%** for the very first request of a fresh session, ~0.2–0.4% once the context grows |

So it is negligible in long sessions and only noticeable on a short, uncached first request.
To avoid the overhead entirely: `pi --exclude-tools grep,find,ls` (the extension then no longer
renders/aggregates those three tools), or configure `defaultTools` to exclude them.

Everything else has zero context cost: no injected messages, no prompt text, and the
`compact-tools.group` session entries are custom entries that do not participate in LLM context
(they do grow the session file by roughly 170–280 bytes per tool call).

## Configuration

| Setting | Effect |
| --- | --- |
| `PI_COMPACT_TOOLS_AGGREGATE=0` | Fall back to v1 mode (one compact row per tool). Read at module load — restart pi after changing. |

The most useful constants (`EXPANDED_LIMIT`, `MODIFIED_NAME_MAX`, `DETAIL_HEAD`/`DETAIL_TAIL`,
`LABEL_MAX`, `ENTRY_TYPE`) live at the top of `extensions/compact-tools.ts`.

## How it works

The extension re-registers the seven built-in tools with `renderShell: "self"` and custom
`renderCall`/`renderResult`. During a request it keeps a live group of tool calls; the newest row
shows a progress line and all other rows render to zero height. At `agent_end` it writes a
`compact-tools.group` custom entry (TUI-only, excluded from LLM context) and appends the summary
block via an entry renderer. Execution is 100% delegated to the built-in implementations.

## Tests

```bash
node extensions/compact-tools.selftest.mjs
```

Runs 18 cases against real `read`/`write`/`edit`/`bash` in a temp directory, using pi's own jiti to
load the extension with a stub `pi`/theme/ctx. It resolves the pi package from the `PI_PKG`
environment variable first, then `npm root -g`.

## Security

Extensions run with your full system permissions and can execute arbitrary code. Read
`extensions/compact-tools.ts` before installing anything from a third party.

## Detailed documentation (中文)

The full design notes, the ten maintenance pitfalls, the API cheat-sheet and the test matrix are in
**[`extensions/compact-tools.md`](extensions/compact-tools.md)** (Chinese).

## License

[MIT](LICENSE) © 2026 lucis.sie
