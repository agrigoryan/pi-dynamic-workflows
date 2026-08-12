import type { AgentUsage } from "./agent-runner.js";
import type { WorkflowMeta } from "./parser.js";

export type AgentStatus = "running" | "done" | "error" | "cached" | "skipped";

export interface AgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  status: AgentStatus;
  resultPreview?: string;
  error?: string;
}

export interface WorkflowSnapshot {
  runId: string;
  name: string;
  description: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: AgentSnapshot[];
  usage?: AgentUsage;
  durationMs?: number;
  result?: unknown;
}

export function createSnapshot(meta: WorkflowMeta, runId: string): WorkflowSnapshot {
  return {
    runId,
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
  };
}

export interface RenderOptions {
  maxAgentsPerPhase?: number;
  maxLogs?: number;
}

export function renderSnapshot(
  snapshot: WorkflowSnapshot,
  completed: boolean,
  options: RenderOptions = {},
): string {
  const maxAgents = options.maxAgentsPerPhase ?? 6;
  const maxLogs = options.maxLogs ?? 2;
  const done = snapshot.agents.filter((agent) => agent.status === "done" || agent.status === "cached").length;
  const running = snapshot.agents.filter((agent) => agent.status === "running").length;
  const errors = snapshot.agents.filter((agent) => agent.status === "error").length;

  const counters = [
    `${done}/${snapshot.agents.length} done`,
    running ? `${running} running` : undefined,
    errors ? `${errors} failed` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [`◆ workflow ${snapshot.name} [${snapshot.runId}] — ${counters || "starting"}`];

  const phaseNames = [
    ...new Set([
      ...snapshot.phases,
      ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
      ...snapshot.agents.map((agent) => agent.phase).filter((phase): phase is string => Boolean(phase)),
    ]),
  ];
  const rendered = new Set<AgentSnapshot>();

  for (const phaseName of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phaseName);
    if (agents.length === 0 && snapshot.currentPhase !== phaseName) continue;
    for (const agent of agents) rendered.add(agent);
    const active = agents.some((agent) => agent.status === "running") || snapshot.currentPhase === phaseName;
    lines.push(`  ${active && !completed ? "▶" : "✓"} ${phaseName}`);
    appendAgents(lines, agents, maxAgents);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) appendAgents(lines, unphased, maxAgents);

  for (const message of snapshot.logs.slice(-maxLogs)) lines.push(`  log: ${message}`);

  if (snapshot.usage && (completed || snapshot.usage.totalTokens > 0)) {
    const cost = snapshot.usage.cost ? ` · $${snapshot.usage.cost.toFixed(4)}` : "";
    const duration = snapshot.durationMs ? ` · ${(snapshot.durationMs / 1000).toFixed(1)}s` : "";
    lines.push(`  tokens: ${snapshot.usage.totalTokens} (${snapshot.usage.output} out)${cost}${duration}`);
  }
  return lines.join("\n");
}

function appendAgents(lines: string[], agents: AgentSnapshot[], maxAgents: number): void {
  const visible = agents.slice(-maxAgents);
  if (agents.length > visible.length) lines.push(`    … ${agents.length - visible.length} earlier agents`);
  for (const agent of visible) {
    const suffix =
      agent.status === "error" && agent.error
        ? ` — ${shorten(agent.error, 60)}`
        : agent.resultPreview
          ? ` — ${shorten(agent.resultPreview, 60)}`
          : "";
    lines.push(`    ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${suffix}`);
  }
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "●";
    case "done":
      return "✓";
    case "cached":
      return "↻";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? shorten(text, max) : "";
}
