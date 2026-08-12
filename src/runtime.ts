import vm from "node:vm";
import type { AgentUsage, SubagentRunOptions, SubagentRunResult } from "./agent-runner.js";
import { agentCallKey, type RunJournal } from "./journal.js";
import { parseWorkflowScript, type WorkflowMeta } from "./parser.js";

export interface AgentEndEvent {
  label: string;
  phase?: string;
  status: "done" | "error" | "cached";
  result: unknown;
  error?: string;
}

export interface WorkflowRunnerLike {
  run(prompt: string, options: SubagentRunOptions): Promise<SubagentRunResult>;
}

export interface WorkflowRunOptions {
  cwd?: string;
  args?: unknown;
  runner: WorkflowRunnerLike;
  journal?: RunJournal;
  concurrency?: number;
  maxAgents?: number;
  /** Hard output-token ceiling across all live subagents; null/undefined = unlimited. */
  tokenBudget?: number | null;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
  onAgentEnd?: (event: AgentEndEvent) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  replayedCount: number;
  usage: AgentUsage;
  durationMs: number;
}

const MAX_ITEMS_PER_CALL = 4096;
const DEFAULT_MAX_AGENTS = 1000;
const SYNC_EVAL_TIMEOUT_MS = 30_000;

interface AgentCallOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  agentType?: string;
}

/**
 * Execute a workflow orchestration script in a deterministic vm sandbox, exposing
 * agent()/parallel()/pipeline()/phase()/log()/args/budget as globals. The sandbox is
 * a determinism aid (for journal replay), not a security boundary — subagents do the
 * actual work with real tools.
 */
export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  const concurrency = clampConcurrency(options.concurrency);
  const limiter = createLimiter(concurrency);
  const pendingRuns = new Set<Promise<unknown>>();

  const state = {
    currentPhase: undefined as string | undefined,
    logs: [] as string[],
    phases: [] as string[],
    agentCount: 0,
    replayedCount: 0,
    usage: { input: 0, output: 0, totalTokens: 0, cost: 0, turns: 0 } as AgentUsage,
  };

  const log = (message: unknown) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.usage.output,
    remaining: () =>
      options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.usage.output),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  const agent = (prompt: unknown, rawOptions: unknown = {}) => {
    throwIfAborted();
    const taskPrompt = requireString(prompt, "agent prompt");
    const callOptions = normalizeAgentOptions(rawOptions);
    const assignedPhase = callOptions.phase ?? state.currentPhase;

    if (state.agentCount >= maxAgents) {
      throw new Error(`workflow agent cap reached (${maxAgents} agents)`);
    }
    if (budget.total !== null && budget.remaining() <= 0) {
      throw new Error(`workflow token budget exhausted (${budget.total} output tokens)`);
    }

    state.agentCount++;
    const label = callOptions.label?.trim() || defaultLabel(assignedPhase, state.agentCount);
    const key = agentCallKey(taskPrompt, {
      schema: callOptions.schema,
      model: callOptions.model,
      agentType: callOptions.agentType,
    });

    const cached = options.journal?.replay(key);
    if (cached) {
      state.replayedCount++;
      options.onAgentEnd?.({ label, phase: assignedPhase, status: "cached", result: cached.result });
      return Promise.resolve(cached.result);
    }
    const occurrence = options.journal?.nextOccurrence(key) ?? 0;

    const run = limiter(async () => {
      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt });
      try {
        throwIfAborted();
        const { result, usage } = await options.runner.run(taskPrompt, {
          label,
          schema: callOptions.schema as SubagentRunOptions["schema"],
          model: callOptions.model,
          signal: options.signal,
          instructions: buildInstructions(assignedPhase, callOptions),
        });
        throwIfAborted();
        addUsage(state.usage, usage);
        options.journal?.record({ key, occurrence, label, result, usage: compactUsage(usage) });
        options.onAgentEnd?.({ label, phase: assignedPhase, status: "done", result });
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        log(`agent "${label}" failed: ${message}`);
        options.onAgentEnd?.({ label, phase: assignedPhase, status: "error", result: null, error: message });
        return null;
      }
    });
    pendingRuns.add(run);
    run.then(
      () => pendingRuns.delete(run),
      () => pendingRuns.delete(run),
    );
    return run;
  };

  const parallel = (thunks: unknown) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items, got ${thunks.length}`);
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      (thunks as Array<() => unknown>).map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = (
    items: unknown,
    ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items, got ${items.length}`);
    }
    if (stages.length === 0 || stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., prev => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
          } catch (error) {
            if (options.signal?.aborted) throw error;
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  const cwd = options.cwd ?? process.cwd();
  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    budget,
    cwd,
    process: Object.freeze({ cwd: () => cwd }),
    console: Object.freeze({
      log,
      info: log,
      warn: (message: unknown) => log(`[warn] ${String(message)}`),
      error: (message: unknown) => log(`[error] ${String(message)}`),
    }),
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Set,
    Map,
    Promise,
    Error,
    TypeError,
    structuredClone,
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const compiled = new vm.Script(wrapped, { filename: `${meta.name}.workflow.js` });
  const raw = await compiled.runInContext(context, { timeout: SYNC_EVAL_TIMEOUT_MS });
  await Promise.allSettled([...pendingRuns]);
  // Clone across the vm realm boundary: sandbox objects carry foreign prototypes.
  const result = cloneResult(raw);

  if (state.agentCount === 0) {
    throw new Error("workflow scripts must call agent() at least once; use ordinary tools for static work");
  }

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    replayedCount: state.replayedCount,
    usage: state.usage,
    durationMs: Date.now() - started,
  };
}

function clampConcurrency(requested: number | undefined): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 8;
  const fallback = Math.max(1, cores - 2);
  return Math.max(1, Math.min(requested ?? fallback, 16));
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function normalizeAgentOptions(value: unknown): AgentCallOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const raw = value as Record<string, unknown>;
  return {
    label: optionalString(raw.label, "agent label"),
    phase: optionalString(raw.phase, "agent phase"),
    model: optionalString(raw.model, "agent model"),
    agentType: optionalString(raw.agentType, "agent agentType"),
    // Clone the schema out of the vm realm so downstream consumers see native objects.
    schema: raw.schema === undefined ? undefined : structuredClone(raw.schema),
  };
}

function buildInstructions(phase: string | undefined, options: AgentCallOptions): string | undefined {
  const lines: string[] = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as subagent type: ${options.agentType}`);
  return lines.length ? lines.join("\n") : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function defaultLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase.toLowerCase()} #${index}` : `agent #${index}`;
}

function addUsage(total: AgentUsage, usage: AgentUsage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.totalTokens += usage.totalTokens;
  total.cost += usage.cost;
  total.turns += usage.turns;
}

function compactUsage(usage: AgentUsage) {
  return { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: usage.cost };
}

function cloneResult(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `workflow result must be JSON-serializable; did you forget to await agent()/parallel()/pipeline()?${detail}`,
    );
  }
}
