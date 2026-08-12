import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createStructuredOutputTool, STRUCTURED_OUTPUT_CONTRACT } from "./structured-output.js";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface AgentUsage {
  input: number;
  output: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface SubagentRunOptions {
  label?: string;
  schema?: TSchema;
  /** "provider/modelId" or "provider/modelId:thinkingLevel"; overrides the default model. */
  model?: string;
  instructions?: string;
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  result: unknown;
  usage: AgentUsage;
}

export interface SubagentRunnerOptions {
  cwd?: string;
  /** Registry from the host session; used to resolve per-agent model overrides. */
  modelRegistry?: ModelRegistry;
  /** Default model for subagents (usually the host session's model). */
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

/**
 * Runs each agent() call as a fresh in-process pi session: in-memory (no session
 * files), default coding tools, and no extensions — a subagent must not recurse
 * into the workflow tool. Skills, prompt templates, and AGENTS.md context still load
 * via the shared resource loader, which is built once and reused across all agents.
 */
export class SubagentRunner {
  private readonly cwd: string;
  private readonly options: SubagentRunnerOptions;
  private resourceLoaderPromise: Promise<DefaultResourceLoader> | undefined;

  constructor(options: SubagentRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.options = options;
  }

  async run(prompt: string, options: SubagentRunOptions = {}): Promise<SubagentRunResult> {
    if (options.signal?.aborted) throw new Error("subagent aborted");

    const capture = { called: false, value: undefined as unknown };
    const customTools: ToolDefinition[] = [];
    if (options.schema) customTools.push(createStructuredOutputTool(options.schema, capture));

    const agentDir = getAgentDir();
    const { model, thinkingLevel } = this.resolveModel(options.model);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      resourceLoader: await this.getResourceLoader(agentDir),
      customTools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    let removeAbortListener: (() => void) | undefined;
    try {
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(buildPrompt(prompt, options));
      if (options.signal?.aborted) throw new Error("subagent aborted");

      const usage = collectUsage(session.messages);
      if (options.schema) {
        if (!capture.called) throw new Error("subagent finished without calling structured_output");
        return { result: capture.value, usage };
      }
      const text = lastAssistantText(session.messages);
      if (!text.trim()) throw new Error("subagent produced empty output");
      return { result: text, usage };
    } finally {
      removeAbortListener?.();
      session.dispose();
    }
  }

  private getResourceLoader(agentDir: string): Promise<DefaultResourceLoader> {
    this.resourceLoaderPromise ??= (async () => {
      const loader = new DefaultResourceLoader({
        cwd: this.cwd,
        agentDir,
        settingsManager: SettingsManager.create(this.cwd, agentDir),
        noExtensions: true,
      });
      await loader.reload();
      return loader;
    })();
    return this.resourceLoaderPromise;
  }

  private resolveModel(spec: string | undefined): {
    model: Model<any> | undefined;
    thinkingLevel: ThinkingLevel | undefined;
  } {
    if (!spec) return { model: this.options.model, thinkingLevel: this.options.thinkingLevel };
    const match = spec.match(/^(.+?)\/([^:]+)(?::(.+))?$/);
    if (!match) throw new Error(`invalid model spec "${spec}": expected "provider/modelId[:thinkingLevel]"`);
    const [, provider, modelId, thinking] = match;
    const available = this.options.modelRegistry?.getAvailable() ?? [];
    const model = available.find((item) => item.provider === provider && item.id === modelId);
    if (!model) {
      const known = available.map((item) => `${item.provider}/${item.id}`).join(", ");
      throw new Error(`model "${provider}/${modelId}" is not available. Available: ${known || "none"}`);
    }
    return { model, thinkingLevel: thinking as ThinkingLevel | undefined };
  }
}

function buildPrompt(prompt: string, options: SubagentRunOptions): string {
  const parts = [
    "You are a workflow subagent. Complete the task below and return only the requested data — " +
      "your final message is consumed by an orchestration script, not read by a human.",
    options.instructions,
    options.label ? `Task label: ${options.label}` : undefined,
    prompt,
    options.schema ? STRUCTURED_OUTPUT_CONTRACT : undefined,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function collectUsage(messages: unknown[]): AgentUsage {
  const usage: AgentUsage = { input: 0, output: 0, totalTokens: 0, cost: 0, turns: 0 };
  for (const message of messages) {
    const assistant = message as Partial<AssistantMessage>;
    if (assistant?.role !== "assistant" || !assistant.usage) continue;
    usage.turns++;
    usage.input += assistant.usage.input ?? 0;
    usage.output += assistant.usage.output ?? 0;
    usage.totalTokens += assistant.usage.totalTokens ?? 0;
    usage.cost += assistant.usage.cost?.total ?? 0;
  }
  return usage;
}

function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
