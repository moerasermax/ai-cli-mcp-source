# ai-cli-mcp

Run local AI CLIs — Claude, Codex, Antigravity (`agy`) — and **any third-party
OpenAI-compatible API** as MCP tools, with background jobs. Self-maintained from
source, built on a registry architecture: adding an agent means adding one file.

Requires Node `^20.19.0 || >=22.12.0`.

> 完整中文文件（環境變數、設定檔、每個工具的細節）見 **[README.zh-TW.md](README.zh-TW.md)**.
> The Chinese document is the exhaustive reference; this page covers the design and
> the parts you need to get running.

## Quick start

```bash
git clone <repo-url> ai-cli-mcp-source
cd ai-cli-mcp-source
npm install     # triggers build via the prepare script and produces dist/
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```

`dist/` is not version-controlled, so the build has to run before first use.
`npm install` runs it through the `prepare` script, so a separate `npm run build`
is normally unnecessary.

## What it does

Each supported CLI becomes a tool you can call from an MCP client. Jobs run in the
background: `run` returns a PID immediately, and `list_processes`, `peek`, `wait` and
`get_result` observe it while it works. Three entry points — the MCP server, the
`ai-cli` command line, and the detached file-backed runner — are equivalent in
behavior; they differ only in where job state lives.

## Architecture

```
src/
├─ agents/                one file per AI — this is the extension point
│   ├─ types.ts               AgentDefinition, the core contract
│   ├─ registry.ts            central registry
│   └─ claude.ts · codex.ts · antigravity.ts · direct-api.ts
├─ core/                  the framework; untouched when adding an agent
│   ├─ command-builder.ts     model routing and command assembly
│   ├─ process-service.ts     in-memory job management (MCP)
│   ├─ file-process-service.ts file-backed job management (detached CLI)
│   ├─ pty-runner.ts          ConPTY, for CLIs that need a real TTY
│   ├─ circuit-breaker.ts     start-rate and duplicate-prompt breaker
│   ├─ updater.ts             background check, subprocess apply, rollback
│   └─ user-config.ts · binary-resolver.ts · peek.ts · doctor.ts
├─ models/                model catalog, aliases, provenance and disk cache
├─ plugins/               quota lookup bridge
└─ app/                   mcp.ts (MCP server) · cli.ts (command line)
```

The split is the point: `agents/` is data about each CLI, `core/` is the machinery.
A new backend never requires editing the machinery.

## Adding an AI agent

1. Copy `src/agents/codex.ts` to `src/agents/<name>.ts` and implement
   `AgentDefinition`: `id`, `models`, `matchesModel`, `binary`, `reasoning`,
   `buildCommand`, `parseOutput`.
   - Needs a real TTY → set `win32SpawnMode: 'pty'` (see `antigravity.ts`).
   - Is a real `.exe` rather than an npm shim → set `win32DirectExec: true`.
2. Import it in `src/agents/registry.ts` and append it to `AGENTS`. Claude stays
   last — it is the fallback.
3. Add the new id to `AgentId` in `src/agents/types.ts`. If the agent needs a CLI
   binary, extend the `CliPaths` return in `core/doctor.ts`.
4. `npm run build`.

## Start circuit breaker

A caller-side bug can turn into an infinite loop, and an infinite loop hammering a
provider can get an account flagged for abuse. Every subprocess start therefore goes
through `src/core/circuit-breaker.ts` first, which watches for two loop signatures:

- **Rate** — starts within the sliding window exceed `AI_CLI_BREAKER_MAX_STARTS`.
- **Duplicate** — the same agent with the same prompt exceeds
  `AI_CLI_BREAKER_DUP_LIMIT` within the window.

Either one opens the breaker for `AI_CLI_BREAKER_COOLDOWN_SEC`, during which starts
are refused with an explicit error, after which it recovers on its own. Normal usage
does not trip it. Verify with `npm run build && node verify-breaker.mjs`.

## Knowing whether the AI is still alive

A `wait` timeout means the observation window closed, not that the job failed — the
process keeps running. Earlier versions threw `Timed out after N seconds`, which MCP
wrapped as an InternalError, and calling models routinely read that as failure and
abandoned the PID.

Now `wait` returns the array of current results instead. Only items still `running`
at the timeout carry `timedOut: true`. An unknown PID is still an error;
`completed`, `failed` and `lost` carry neither `liveness` nor `timedOut`.

Running items from `get_result`, `wait` and `list_processes` all carry the same
`liveness` object:

| Field | Meaning |
|---|---|
| `alive` | Process is up. It does **not** promise the model is producing tokens. |
| `elapsedSec` | Seconds since start. |
| `sinceLastOutputSec` | Seconds since the last stdout/stderr chunk; `null` if there has never been output. |
| `stdoutBytes` / `stderrBytes` | Bytes received. PTY-merged output counts as stdout. |
| `lastEvent` | One-line summary of the last meaningful event, ≤120 chars. |
| `eventCount` | Complete decoded events. Blank lines, bad JSON and partial lines do not count. |
| `hint` | Plain-English advice: starting up, recently active, alive but silent, or waiting on end-of-run metadata. |

This matters because Codex and Claude emit nothing at all while reasoning. Without
`liveness`, silence is indistinguishable from death.

The file-backed path keeps a `lost` state: the PID is gone and no completion was
recorded, so the outcome is genuinely unknown — which is not the same as failed.

## Did the code actually get verified?

Same idea as `liveness`, one layer up: the caller is an AI, and it only ever sees the
tool result. If the result does not say "this job changed code and never ran a test",
the caller treats the sub-agent's "done" as done.

So `run`, `wait` and `get_result` all carry a `verification` field — **including in
compact mode**, because a field that only exists under `verbose` is a field nobody
reads.

| Status | Meaning |
|---|---|
| `not_applicable` | No source file was modified. Nothing needed verifying. |
| `not_observed` | Either code changed and no verification followed, or the agent emits no structured tool history at all (agy). "Can't see" is not "didn't happen". |
| `passed` | A test/build/lint ran **after the last code change** and succeeded. |
| `failed` | Such a run happened and failed. Do not treat the work as done. |
| `waived` | Code changed without verification, with an explicit reason recorded. Never overrides `failed`. |
| `pending` | Still running. Anything else would be a guess. |

It is deliberately not a boolean. `verified: false` cannot tell apart "no code was
touched", "code was touched but I can't see whether it was checked", and "it was
checked and it broke" — three states that call for three different next moves.

Ordering is the whole game: verification only counts if it ran **after** the last
edit. Otherwise "run the tests, then change the code" reports a pass. The evidence
object names the last code change, the verifications that followed it, and how many
stale ones were ignored.

### The companion plugin

The same judgement runs on your own turns too, via a bundled Claude Code plugin
(`plugin/`, published through `.claude-plugin/marketplace.json`). Its `Stop` hook
blocks **once** when a turn changed code and never verified it, then asks you to run
the tests or state why you are not going to.

```bash
/plugin marketplace add moerasermax/ai-cli-mcp-source
/plugin install ai-cli-verification-gate@ai-cli-mcp
```

Hard rules: always exit 0, never break the session; block at most once (the official
`stop_hook_active` flag exists for exactly this, and the second pass is always let
through and logged as `waived`); and when the situation cannot be judged reliably —
unreadable transcript, missing module — let it through. Missing a violation is
cheaper than blocking work that was fine.

Only changes **under the working directory** count — `workFolder` for dispatched
jobs, the hook event's `cwd` for your own turns. A throwaway analysis script written
to a temp directory will not trip the gate; it has no tests to run in the first place.
(Relative paths always count, since they resolve against that same directory.)

Both layers append their verdicts to the same
`AI_CLI_STATE_DIR/verification-gate.jsonl`, tagged with `source` (`ai-cli` or `hook`).
Together they are one machine's quality baseline; split apart, neither number
represents the whole. It only records — no aggregation, nothing sent anywhere. A
cross-machine baseline needs an explicit sync target and a privacy policy first.

Why it exists: scanning 178 transcripts over 44 hours (26,003 usage records), **31.7%
of work segments that touched source code never ran a single test or build**, and that
share climbs with context size — 5% below 200k tokens, 59% in the 600–800k band. Of
the segments that did verify, 59.2% needed rework, averaging 4.67 rounds. First-pass
rates showed no trend across context sizes (89/77/86/78/86%), so long context was not
making the code worse — it was just making the same work cost 11.64M tokens instead
of 1.43M.

## Auto-update

All three entry points serve normally after the transport connects, then check in the
background ~3 seconds later and apply updates in a subprocess; the new version takes
effect on the next start. Nothing blocks startup, and no running server or job is
killed.

| `AI_CLI_AUTO_UPDATE` | Behavior |
|---|---|
| `on` (default) | Check in the background, apply automatically |
| `check` | Report a new version, do not apply |
| `off` | Never touch the network; still reads existing state |

Also honored: `AI_CLI_UPDATE_CHECK_INTERVAL_SEC` (default `3600`),
`AI_CLI_UPDATE_BRANCH`, and `AI_CLI_STATE_DIR` (default `~/.local/state/ai-cli`).

## direct-api

Any OpenAI-compatible endpoint can be wired in yourself through the `direct-api`
agent, addressed as `or-<model>` for OpenRouter, `ds-<model>` for DashScope, or
`<provider>-<model>` for any provider key configured in
`~/.local/share/ai-cli/providers.json`. See the Chinese reference for the config
file format and the limits of what this path can do.

## Wiring into Claude Code

```bash
# bash / git bash
claude mcp add ai-cli -s user -- node "$PWD/dist/server.js"
```
```powershell
# PowerShell
claude mcp add ai-cli -s user -- node "$PWD\dist\server.js"
```

## License

Apache-2.0. See [LICENSE](LICENSE).
