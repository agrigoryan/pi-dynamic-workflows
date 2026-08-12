# pi-dynamic-workflows

Claude-Code-style **dynamic workflows** for the [pi coding agent](https://pi.dev): the model writes a deterministic JavaScript orchestration script, and the extension executes it — fanning work out across isolated pi subagents with `agent()`, `parallel()`, and `pipeline()`. Intermediate results stay in script variables instead of filling the conversation context; only the final return value comes back.

Modeled on [Anthropic's dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) (see also [A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)).

## Install

```bash
pi install git:github.com/agrigoryan/pi-dynamic-workflows
```

Then `/reload` in a running pi session (new sessions pick it up automatically). To try it once without installing:

```bash
pi -e git:github.com/agrigoryan/pi-dynamic-workflows
```

For development, clone and load from source:

```bash
git clone https://github.com/agrigoryan/pi-dynamic-workflows && cd pi-dynamic-workflows && npm install
pi -e ./extensions/workflow.ts
```

## Use

Ask pi explicitly for a workflow (the tool is gated on explicit intent, mirroring Claude Code's opt-in rule):

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

pi writes and executes a script like:

```js
export const meta = {
  name: "auth_audit",
  description: "Find routes missing auth checks and verify findings",
  phases: [{ title: "Scan" }, { title: "Audit" }, { title: "Verify" }],
}

phase("Scan")
const files = await agent(
  "List every route file under src/routes/, one path per line, nothing else.",
  { label: "route inventory" },
)

phase("Audit")
const findings = await pipeline(
  files.split("\n").filter(Boolean),
  (file) => agent(`Audit ${file} for missing auth checks. Return findings as bullet points, or "none".`, {
    label: `audit ${file}`,
    phase: "Audit",
  }),
  (finding, file) => finding === "none" ? null : agent(
    `Adversarially verify this finding in ${file} — try to refute it:\n${finding}`,
    { label: `verify ${file}`, phase: "Verify", schema: { type: "object", properties: { real: { type: "boolean" }, reason: { type: "string" } }, required: ["real"] } },
  ),
)

return findings.filter(Boolean).filter((f) => f.real)
```

## Script runtime

| Global | Behavior |
| --- | --- |
| `agent(prompt, opts?)` | Spawn a fresh in-process pi subagent. Returns its final text, or a schema-validated object when `opts.schema` (plain JSON Schema) is set. Failures resolve to `null` (and are logged), never reject. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; barrier — awaits all; order preserved; failed thunks become `null`. |
| `pipeline(items, ...stages)` | Each item flows through all stages independently, **no barrier between stages**. Stage callbacks get `(prev, originalItem, index)`. A throwing stage drops that item to `null`. |
| `phase(title)` | Start a progress group; subsequent agents render under it. |
| `log(message)` | Emit a progress line. |
| `args` | The `args` value passed to the tool, verbatim. |
| `budget` | `{ total, spent(), remaining() }` over real subagent output tokens. Hard ceiling: once exhausted, further `agent()` calls throw. |
| `cwd` / `process.cwd()` | The project directory. |

Agent options: `label`, `phase`, `schema`, `model` (`"provider/modelId"` or `"provider/modelId:thinkingLevel"`, resolved against your authenticated models; omit to inherit the session model), `agentType` (advisory role line in the subagent prompt).

## Semantics

- **Deterministic sandbox** — scripts run in a Node `vm` context (a determinism aid for resume, *not* a security boundary). `Date.now()`, `Math.random()`, `new Date()`, imports, fs, and network are unavailable inside the orchestration script; subagents do the real work with pi's coding tools.
- **Isolation** — each subagent is a fresh in-memory pi session with the default coding tools, your skills/prompts/AGENTS.md context, and **no extensions** (a subagent cannot recurse into the workflow tool). Nothing is written to pi's session directory.
- **Concurrency** — `min(16, cores − 2)` concurrent subagents (override with `concurrency`); 1000-agent lifetime cap per run (`maxAgents`); 4096 items max per `parallel()`/`pipeline()` call.
- **Real accounting** — token counts and cost come from actual provider usage on each subagent message, not estimates.

## Journaled resume

Every run persists to `~/.pi/dynamic-workflows/projects/<project>/<runId>/` (`script.js`, `run.json`, `journal.jsonl`). Successful `agent()` results are journaled; pass `resumeFromRunId` to replay them:

- unchanged `agent()` calls return their journaled results instantly at zero token cost,
- edited or new calls run live,
- failed (`null`) calls are never cached, so a resume retries exactly what didn't finish.

Unlike Claude Code's positional prefix matching, replay here is **keyed** on `sha256(prompt + schema + model + agentType)` plus an occurrence counter — so reordering completion in parallel stages doesn't invalidate the cache, and editing one prompt re-runs only that call.

`/workflows` lists recent runs (runId, status, agent count) for the current project.

## Tool parameters

`script` (required), `args`, `tokenBudget` (hard output-token ceiling), `concurrency`, `maxAgents`, `resumeFromRunId`.

## Development

```bash
npm test        # biome + typecheck + unit tests
```

The runtime accepts any `WorkflowRunnerLike`, so tests (and embedders) can inject a fake runner; `runWorkflow`, `SubagentRunner`, `RunJournal`, and `createWorkflowTool` are exported for library use.

## Credits

The code-mode orchestration design comes from Anthropic's dynamic workflows in Claude Code. Prior art on pi that this implementation studied: [Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) (original) and [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) (extended fork). This is an independent implementation with keyed journal replay, real usage accounting, and pi ≥ 0.84 APIs.

## License

MIT
