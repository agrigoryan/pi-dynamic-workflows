import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, SubagentRunResult } from "../src/agent-runner.js";
import type { WorkflowSnapshot } from "../src/display.js";
import { projectRunsDir } from "../src/journal.js";
import type { WorkflowRunnerLike } from "../src/runtime.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

/**
 * End-to-end through the pi tool layer: createWorkflowTool().execute() with a mock
 * ExtensionContext and an injected runner — exercising argument preparation, journal
 * persistence, resume, streaming updates, and result formatting exactly as pi would.
 */

const root = mkdtempSync(join(tmpdir(), "pi-dw-tool-test-"));
process.env.PI_DYNAMIC_WORKFLOWS_DIR = root;

after(() => rmSync(root, { recursive: true, force: true }));

const usage = (): AgentUsage => ({ input: 10, output: 20, totalTokens: 30, cost: 0.002, turns: 1 });
const CWD = "/fake/tool-project";

function mockContext(): ExtensionContext {
  return {
    cwd: CWD,
    hasUI: false,
    ui: { setWidget() {}, notify() {} },
    modelRegistry: undefined,
    model: undefined,
    thinkingLevel: undefined,
  } as unknown as ExtensionContext;
}

function makeTool(handler: (prompt: string) => unknown | Promise<unknown>): {
  tool: ReturnType<typeof createWorkflowTool>;
  prompts: string[];
} {
  const prompts: string[] = [];
  const runner: WorkflowRunnerLike = {
    async run(prompt): Promise<SubagentRunResult> {
      prompts.push(prompt);
      return { result: await handler(prompt), usage: usage() };
    },
  };
  return { tool: createWorkflowTool({ runnerFactory: () => runner }), prompts };
}

const SCRIPT = `export const meta = { name: 'tool_e2e', description: 'tool-level e2e', phases: [{ title: 'Work' }] }
phase('Work')
const first = await agent('alpha', { label: 'alpha' })
const second = await agent('beta', { label: 'beta' })
return { first, second }`;

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

test("executes a fenced script, streams updates, persists journal and run record", async () => {
  const { tool } = makeTool((prompt) => `r:${prompt}`);
  const updates: string[] = [];
  // biome-ignore lint/style/useTemplate: escaped backticks in a template obscure the fence being built
  const params = tool.prepareArguments?.({ script: "```js\n" + SCRIPT + "\n```" });
  assert.ok(params && !params.script.includes("```"), "prepareArguments must strip fences");

  const result = await tool.execute(
    "call-1",
    params,
    undefined,
    (update) => updates.push(textOf(update as any)),
    mockContext(),
  );

  const text = textOf(result);
  assert.match(text, /Workflow tool_e2e completed: 2 agent\(s\)/);
  assert.match(text, /"first": "r:alpha"/);
  const runId = text.match(/runId: (wf_[a-z0-9]+)/)?.[1];
  assert.ok(runId, "result text must expose the runId");

  // Streaming updates rendered live progress.
  assert.ok(updates.length >= 2, "expected streamed progress updates");
  assert.ok(updates.some((u) => u.includes("● alpha") || u.includes("✓ alpha")));

  // Journal + run record persisted where /workflows and resume expect them.
  const runDir = join(projectRunsDir(CWD), runId);
  assert.ok(existsSync(join(runDir, "script.js")));
  const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.agentCount, 2);
  assert.equal(readFileSync(join(runDir, "journal.jsonl"), "utf8").trim().split("\n").length, 2);

  const details = result.details as WorkflowSnapshot;
  assert.equal(details.name, "tool_e2e");
  assert.equal(details.usage?.totalTokens, 60);
});

test("resumeFromRunId replays the completed prefix and re-runs only the failure", async () => {
  // First run: beta fails -> null in result, not journaled.
  let betaFails = true;
  const { tool, prompts } = makeTool((prompt) => {
    if (prompt.includes("beta") && betaFails) throw new Error("flaky beta");
    return `r:${prompt}`;
  });

  const first = await tool.execute("call-1", { script: SCRIPT }, undefined, undefined, mockContext());
  const firstText = textOf(first);
  assert.match(firstText, /"second": null/);
  const runId = firstText.match(/runId: (wf_[a-z0-9]+)/)?.[1];
  assert.ok(runId);

  // Second run resumes: alpha replays from journal, only beta runs live.
  betaFails = false;
  prompts.length = 0;
  const second = await tool.execute(
    "call-2",
    { script: SCRIPT, resumeFromRunId: runId },
    undefined,
    undefined,
    mockContext(),
  );
  const secondText = textOf(second);
  assert.match(secondText, /"first": "r:alpha"/);
  assert.match(secondText, /"second": "r:beta"/);
  assert.match(secondText, /1 replayed from/);
  assert.deepEqual(
    prompts.filter((p) => p.includes("alpha")),
    [],
    "alpha must replay from journal, not run live",
  );
  assert.equal(prompts.filter((p) => p.includes("beta")).length, 1);
});

test("resume with an unknown runId fails fast", async () => {
  const { tool } = makeTool(() => "ok");
  await assert.rejects(
    tool.execute(
      "call-1",
      { script: SCRIPT, resumeFromRunId: "wf_does_not_exist" },
      undefined,
      undefined,
      mockContext(),
    ),
    /no run found/,
  );
});

test("abort marks the run aborted and offers resume", async () => {
  const controller = new AbortController();
  const runner: WorkflowRunnerLike = {
    async run(prompt): Promise<SubagentRunResult> {
      if (prompt.includes("beta")) controller.abort();
      return { result: `r:${prompt}`, usage: usage() };
    },
  };
  const tool = createWorkflowTool({ runnerFactory: () => runner });

  let abortedRunId: string | undefined;
  await assert.rejects(
    tool.execute("call-1", { script: SCRIPT }, controller.signal, undefined, mockContext()),
    (error: Error) => {
      assert.match(error.message, /aborted/i);
      abortedRunId = error.message.match(/resumeFromRunId: "(wf_[a-z0-9]+)"/)?.[1];
      assert.ok(abortedRunId, "abort error must name the run to resume");
      return true;
    },
  );

  // The aborted run record is on disk for /workflows, and alpha's journal entry survived.
  const runDir = join(projectRunsDir(CWD), abortedRunId as string);
  const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  assert.equal(record.status, "aborted");
  const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8").trim().split("\n");
  assert.equal(journal.length, 1);
  assert.match(journal[0] as string, /alpha/);
});

test("tokenBudget parameter reaches the script's budget global", async () => {
  const { tool } = makeTool(() => "ok");
  const script = `export const meta = { name: 'budget_probe', description: 'probe budget' }
await agent('one')
return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`;

  const result = await tool.execute(
    "call-1",
    { script, tokenBudget: 500 },
    undefined,
    undefined,
    mockContext(),
  );
  const text = textOf(result);
  assert.match(text, /"total": 500/);
  assert.match(text, /"spent": 20/);
  assert.match(text, /"remaining": 480/);
});

test("invalid scripts are rejected before any run state is created", async () => {
  const { tool, prompts } = makeTool(() => "ok");
  await assert.rejects(
    tool.execute("call-1", { script: "const nope = 1" }, undefined, undefined, mockContext()),
    /export const meta/,
  );
  assert.equal(prompts.length, 0);
});
