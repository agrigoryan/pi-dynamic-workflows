import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUsage, SubagentRunOptions, SubagentRunResult } from "../src/agent-runner.js";
import { runWorkflow, type WorkflowRunnerLike } from "../src/runtime.js";

const usage = (output = 10): AgentUsage => ({
  input: 5,
  output,
  totalTokens: 5 + output,
  cost: 0.001,
  turns: 1,
});

function fakeRunner(
  handler: (prompt: string, options: SubagentRunOptions) => unknown | Promise<unknown>,
): WorkflowRunnerLike {
  return {
    async run(prompt, options): Promise<SubagentRunResult> {
      return { result: await handler(prompt, options), usage: usage() };
    },
  };
}

const META = "export const meta = { name: 'test', description: 'test workflow' }\n";

test("runs agents and returns the script result", async () => {
  const runner = fakeRunner((prompt) => `echo:${prompt}`);
  const run = await runWorkflow(`${META}phase('Work')\nconst a = await agent('one')\nreturn { a }`, {
    runner,
  });
  assert.deepEqual(run.result, { a: "echo:one" });
  assert.equal(run.agentCount, 1);
  assert.deepEqual(run.phases, ["Work"]);
  assert.equal(run.usage.output, 10);
});

test("parallel takes thunks, preserves order, and maps errors to null", async () => {
  const runner = fakeRunner((prompt) => {
    if (prompt === "bad") throw new Error("boom");
    return prompt.toUpperCase();
  });
  const script = `${META}
const results = await parallel(['a', 'bad', 'c'].map((item) => () => agent(item)))
return results`;
  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, ["A", null, "C"]);
});

test("parallel rejects promises instead of thunks", async () => {
  const runner = fakeRunner(() => "x");
  await assert.rejects(
    runWorkflow(`${META}return await parallel([agent('a')])`, { runner }),
    /functions, not promises/,
  );
});

test("pipeline stages receive (prev, original, index) and drop failed items to null", async () => {
  const runner = fakeRunner((prompt) => {
    if (prompt.includes("fail")) throw new Error("nope");
    return `r:${prompt}`;
  });
  const script = `${META}
const out = await pipeline(
  ['x', 'fail'],
  (item) => agent(item),
  (prev, original, index) => agent(prev + ':' + original + ':' + index),
)
return out`;
  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, ["r:r:x:x:0", null]);
});

test("agent failures resolve to null and are logged", async () => {
  const runner = fakeRunner(() => {
    throw new Error("subagent died");
  });
  const run = await runWorkflow(`${META}const x = await agent('a', { label: 'doomed' })\nreturn { x }`, {
    runner,
  });
  assert.deepEqual(run.result, { x: null });
  assert.ok(run.logs.some((line) => line.includes("doomed") && line.includes("subagent died")));
});

test("token budget is a hard ceiling", async () => {
  const runner = fakeRunner(() => "ok");
  const script = `${META}
await agent('first')
let threw = false
try { await agent('second') } catch (error) { threw = true }
return { threw, remaining: budget.remaining(), total: budget.total }`;
  const run = await runWorkflow(script, { runner, tokenBudget: 10 });
  assert.deepEqual(run.result, { threw: true, remaining: 0, total: 10 });
});

test("agent cap throws", async () => {
  const runner = fakeRunner(() => "ok");
  const script = `${META}
await agent('one')
await agent('two')
return 'unreachable'`;
  await assert.rejects(runWorkflow(script, { runner, maxAgents: 1 }), /agent cap/);
});

test("workflows must call agent() at least once", async () => {
  const runner = fakeRunner(() => "ok");
  await assert.rejects(runWorkflow(`${META}return 42`, { runner }), /at least once/);
});

test("unawaited results are rejected as non-cloneable", async () => {
  const runner = fakeRunner(() => "ok");
  await assert.rejects(runWorkflow(`${META}return { pending: agent('a') }`, { runner }), /await/);
});

test("schema and model pass through to the runner", async () => {
  const seen: SubagentRunOptions[] = [];
  const runner: WorkflowRunnerLike = {
    async run(_prompt, options) {
      seen.push(options);
      return { result: { ok: true }, usage: usage() };
    },
  };
  const script = `${META}
return await agent('check', { schema: { type: 'object' }, model: 'prov/mod:high', label: 'checker' })`;
  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, { ok: true });
  assert.equal(seen[0]?.model, "prov/mod:high");
  assert.equal(seen[0]?.label, "checker");
  assert.deepEqual(seen[0]?.schema, { type: "object" });
});

test("abort signal stops the workflow", async () => {
  const controller = new AbortController();
  const runner: WorkflowRunnerLike = {
    async run() {
      controller.abort();
      return { result: "late", usage: usage() };
    },
  };
  await assert.rejects(
    runWorkflow(`${META}await agent('a')\nawait agent('b')\nreturn 1`, { runner, signal: controller.signal }),
    /abort/i,
  );
});

test("concurrency limiter respects the cap", async () => {
  let active = 0;
  let peak = 0;
  const runner: WorkflowRunnerLike = {
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { result: "ok", usage: usage() };
    },
  };
  const script = `${META}
await parallel([1, 2, 3, 4, 5, 6].map((n) => () => agent('task ' + n)))
return peakUnused ?? 'done'`;
  await runWorkflow(script.replace("peakUnused ?? ", ""), { runner, concurrency: 2 });
  assert.ok(peak <= 2, `expected peak <= 2, got ${peak}`);
});
