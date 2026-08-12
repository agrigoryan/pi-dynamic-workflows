import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentRunner } from "./agent-runner.js";
import {
  type AgentSnapshot,
  createSnapshot,
  preview,
  renderSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { newRunId, RunJournal } from "./journal.js";
import { normalizeScript, parseWorkflowScript } from "./parser.js";
import { runWorkflow, type WorkflowRunnerLike, type WorkflowRunResult } from "./runtime.js";

const RESULT_PREVIEW_LIMIT = 48_000;
const WIDGET_KEY = "dynamic-workflow";

const parametersSchema = Type.Object({
  script: Type.String({
    description: [
      "Raw JavaScript workflow script (no Markdown fences, no TypeScript).",
      "First statement: export const meta = { name: 'short_kebab_or_snake', description: '...' } as a pure literal; optional meta.phases documents the plan.",
      "Globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args, cwd, budget.",
      "Must call agent() at least once. Date.now()/Math.random()/new Date() are unavailable (journaled resume requires determinism).",
    ].join(" "),
  }),
  args: Type.Optional(Type.Any({ description: "JSON value exposed to the script as the global `args`." })),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Hard ceiling on subagent output tokens; agent() throws once exhausted. Omit for unlimited.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Max concurrent subagents (clamped to 1-16). Default: cpu cores - 2." }),
  ),
  maxAgents: Type.Optional(Type.Number({ description: "Lifetime agent cap for this run (default 1000)." })),
  resumeFromRunId: Type.Optional(
    Type.String({
      description:
        "Run ID of a prior run to resume: unchanged agent() calls replay journaled results instantly; edited or new calls run live.",
    }),
  ),
});

export interface WorkflowToolOptions {
  concurrency?: number;
  /** Override how subagents are executed (tests / embedders). Default: a real SubagentRunner. */
  runnerFactory?: (ctx: ExtensionContext) => WorkflowRunnerLike;
}

export function createWorkflowTool(
  options: WorkflowToolOptions = {},
): ToolDefinition<typeof parametersSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Dynamic Workflow",
    description: [
      "Execute a deterministic JavaScript orchestration script that fans work out across pi subagents",
      "with agent(), parallel(), and pipeline(). Subagent results stay in script variables;",
      "only the returned value enters the conversation. Journaled: pass resumeFromRunId to replay completed agents.",
    ].join(" "),
    promptSnippet:
      "Run a multi-agent workflow from a deterministic JavaScript script (agent/parallel/pipeline/phase globals).",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration; a task that would merely benefit does not count.",
      "workflow scripts are plain JavaScript: first statement `export const meta = { name, description }` (pure literal), then top-level await is allowed. No imports, fs, network, TypeScript, Date.now(), Math.random(), or new Date().",
      "workflow subagents start with NO conversation context: include all needed paths, constraints, and background in each agent() prompt, and tell each agent to return raw data (its final text is the return value).",
      "parallel() takes thunks, not promises: await parallel(items.map(item => () => agent(...))). agent()/parallel()/pipeline() failures resolve to null — .filter(Boolean) before synthesizing.",
      "Default to pipeline(items, ...stages) for multi-stage work (no barrier between stages); use parallel() only when a stage genuinely needs all previous results together (dedup, early-exit, cross-comparison).",
      "Pass opts.schema (plain JSON Schema) when a result feeds later logic; agent() then returns a validated object instead of prose. Give every agent a short unique label.",
      "For machine-checkable quality, compose patterns: adversarial verification (spawn skeptics that try to refute each finding), loop-until-dry discovery (repeat until 2 consecutive rounds find nothing new), and a final synthesis agent.",
      "If a run is interrupted or a prompt needs editing, re-invoke with resumeFromRunId from the previous result: unchanged agent() calls replay from the journal at zero cost.",
      "opts.model accepts 'provider/modelId' or 'provider/modelId:thinkingLevel' to route an agent to a different model; omit to inherit the session model.",
    ],
    parameters: parametersSchema,
    prepareArguments(raw) {
      if (!raw || typeof raw !== "object")
        throw new Error("workflow requires an object with a `script` string");
      const value = raw as Record<string, unknown>;
      if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
      return { ...value, script: normalizeScript(value.script) } as any;
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeScript(params.script);
      const parsed = parseWorkflowScript(script);
      const runId = newRunId();
      const journal = new RunJournal(ctx.cwd, runId);
      const scriptPath = journal.saveScript(script);

      let replayableEntries = 0;
      if (params.resumeFromRunId) {
        replayableEntries = journal.loadReplayCache(ctx.cwd, params.resumeFromRunId);
      }

      const startedAt = new Date().toISOString();
      journal.saveRecord({
        runId,
        name: parsed.meta.name,
        description: parsed.meta.description,
        status: "running",
        startedAt,
      });

      const snapshot = createSnapshot(parsed.meta, runId);
      let agentSequence = 0;
      const emit = (completed: boolean) => {
        const text = renderSnapshot(snapshot, completed);
        onUpdate?.({ content: [{ type: "text", text }], details: { ...snapshot } });
        if (ctx.hasUI) {
          if (completed) ctx.ui.setWidget(WIDGET_KEY, undefined);
          else ctx.ui.setWidget(WIDGET_KEY, text.split("\n"), { placement: "belowEditor" });
        }
      };

      const runner =
        options.runnerFactory?.(ctx) ??
        new SubagentRunner({
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel,
        });

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: ctx.cwd,
          args: params.args,
          runner,
          journal,
          signal,
          concurrency: params.concurrency ?? options.concurrency,
          maxAgents: params.maxAgents,
          tokenBudget: params.tokenBudget,
          onLog(message) {
            snapshot.logs.push(message);
            emit(false);
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
            emit(false);
          },
          onAgentStart(event) {
            snapshot.agents.push({
              id: ++agentSequence,
              label: event.label,
              phase: event.phase,
              status: "running",
            });
            emit(false);
          },
          onAgentEnd(event) {
            let entry = [...snapshot.agents]
              .reverse()
              .find((agent) => agent.label === event.label && agent.status === "running");
            if (!entry) {
              entry = { id: ++agentSequence, label: event.label, phase: event.phase } as AgentSnapshot;
              snapshot.agents.push(entry);
            }
            entry.status = event.status;
            entry.error = event.error;
            entry.resultPreview = preview(event.result);
            emit(false);
          },
        });
      } catch (error) {
        const aborted = signal?.aborted === true;
        finalizeSnapshot(snapshot, ctx, emit);
        journal.saveRecord({
          runId,
          name: parsed.meta.name,
          description: parsed.meta.description,
          status: aborted ? "aborted" : "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          agentCount: snapshot.agents.length,
          error: error instanceof Error ? error.message : String(error),
        });
        if (aborted) throw new Error(`Workflow ${runId} aborted. Resume with resumeFromRunId: "${runId}".`);
        throw error;
      }

      snapshot.usage = result.usage;
      snapshot.durationMs = result.durationMs;
      snapshot.result = result.result;
      emit(true);

      journal.saveRecord({
        runId,
        name: parsed.meta.name,
        description: parsed.meta.description,
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        agentCount: result.agentCount,
      });

      const resultJson = truncate(JSON.stringify(result.result, null, 2) ?? "null", RESULT_PREVIEW_LIMIT);
      const replayNote = result.replayedCount
        ? ` (${result.replayedCount} replayed from ${params.resumeFromRunId})`
        : replayableEntries
          ? " (journal loaded but no calls matched — edited prompts re-ran live)"
          : "";
      return {
        content: [
          {
            type: "text",
            text: [
              `Workflow ${result.meta.name} completed: ${result.agentCount} agent(s)${replayNote}, ` +
                `${result.usage.totalTokens} tokens ($${result.usage.cost.toFixed(4)}), ` +
                `${(result.durationMs / 1000).toFixed(1)}s.`,
              `runId: ${runId} (resume with resumeFromRunId), script: ${scriptPath}`,
              "",
              "Result:",
              resultJson,
            ].join("\n"),
          },
        ],
        details: { ...snapshot, scriptPath },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as (WorkflowSnapshot & { scriptPath?: string }) | undefined;
      if (details?.name) return new Text(renderSnapshot(details, !isPartial), 0, 0);
      const first = result.content?.[0];
      return new Text(first?.type === "text" ? first.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function finalizeSnapshot(
  snapshot: WorkflowSnapshot,
  ctx: ExtensionContext,
  emit: (completed: boolean) => void,
) {
  for (const agent of snapshot.agents) {
    if (agent.status === "running") agent.status = "skipped";
  }
  emit(true);
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}
