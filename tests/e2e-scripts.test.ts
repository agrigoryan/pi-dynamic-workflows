import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUsage, SubagentRunOptions, SubagentRunResult } from "../src/agent-runner.js";
import { runWorkflow, type WorkflowRunnerLike } from "../src/runtime.js";

/**
 * End-to-end execution of realistic workflow scripts through the full stack
 * (normalize → parse → vm sandbox → runtime), with a scripted fake runner in
 * place of live LLM sessions so scenarios stay deterministic.
 */

const usage = (output = 10): AgentUsage => ({
  input: 5,
  output,
  totalTokens: 5 + output,
  cost: 0.001,
  turns: 1,
});

function scriptedRunner(
  handler: (prompt: string, options: SubagentRunOptions, call: number) => unknown | Promise<unknown>,
  outputTokens = 10,
): { runner: WorkflowRunnerLike; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    runner: {
      async run(prompt, options): Promise<SubagentRunResult> {
        prompts.push(prompt);
        return { result: await handler(prompt, options, prompts.length), usage: usage(outputTokens) };
      },
    },
  };
}

const META = (name: string) => `export const meta = { name: '${name}', description: 'e2e: ${name}' }\n`;

test("multi-phase fan-out and synthesis with progress events", async () => {
  const { runner } = scriptedRunner((prompt) => {
    if (prompt.startsWith("list")) return "a.ts\nb.ts\nc.ts";
    if (prompt.startsWith("audit")) return `finding in ${prompt.slice(6)}`;
    return "SYNTHESIS: 3 findings";
  });

  const events: string[] = [];
  const script = `${META("audit")}
phase('Scan')
const files = (await agent('list files')).split('\\n')
phase('Audit')
const findings = await parallel(files.map((f) => () => agent('audit ' + f, { label: 'audit ' + f })))
phase('Synthesize')
const summary = await agent('summarize: ' + findings.join('; '), { label: 'synth' })
return { files: files.length, findings: findings.filter(Boolean).length, summary }`;

  const run = await runWorkflow(script, {
    runner,
    concurrency: 1,
    onPhase: (title) => events.push(`phase:${title}`),
    onAgentStart: (e) => events.push(`start:${e.phase}:${e.label}`),
    onAgentEnd: (e) => events.push(`end:${e.status}:${e.label}`),
  });

  assert.deepEqual(run.result, { files: 3, findings: 3, summary: "SYNTHESIS: 3 findings" });
  assert.equal(run.agentCount, 5);
  assert.deepEqual(run.phases, ["Scan", "Audit", "Synthesize"]);
  // Phases arrive in order, every agent starts and ends, all under the right phase.
  assert.deepEqual(
    events.filter((e) => e.startsWith("phase:")),
    ["phase:Scan", "phase:Audit", "phase:Synthesize"],
  );
  assert.equal(events.filter((e) => e.startsWith("start:Audit:audit ")).length, 3);
  assert.equal(events.filter((e) => e.startsWith("end:done:")).length, 5);
  assert.equal(run.usage.output, 50);
});

test("pipeline has no barrier between stages", async () => {
  // "slow" delays only in stage 1; if pipeline barriered between stages, the
  // fast item's stage-2 could never finish before the slow item's stage-1.
  const order: string[] = [];
  const runner: WorkflowRunnerLike = {
    async run(prompt) {
      if (prompt.includes("slow") && prompt.startsWith("s1")) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      order.push(prompt);
      return { result: prompt, usage: usage() };
    },
  };
  const script = `${META("overlap")}
return await pipeline(['fast', 'slow'],
  (item) => agent('s1 ' + item),
  (prev) => agent('s2 ' + prev))`;

  const run = await runWorkflow(script, { runner, concurrency: 4 });
  assert.deepEqual(run.result, ["s2 s1 fast", "s2 s1 slow"]);
  assert.ok(
    order.indexOf("s2 s1 fast") < order.indexOf("s1 slow"),
    `fast item should clear stage 2 before slow item clears stage 1: ${order.join(" | ")}`,
  );
});

test("loop-until-dry discovery converges with Set dedup", async () => {
  const rounds = [
    ["bug-1", "bug-2"],
    ["bug-2", "bug-3"], // one duplicate, one fresh
    [], // dry
    [], // dry x2 -> stop
  ];
  const { runner, prompts } = scriptedRunner((_prompt, _options, call) =>
    JSON.stringify(rounds[call - 1] ?? []),
  );
  const script = `${META("until_dry")}
const seen = new Set()
let dry = 0
let round = 0
while (dry < 2 && round < 10) {
  round++
  const found = JSON.parse(await agent('find bugs, round ' + round))
  const fresh = found.filter((b) => !seen.has(b))
  if (fresh.length === 0) { dry++; continue }
  dry = 0
  fresh.forEach((b) => seen.add(b))
  log('round ' + round + ': ' + fresh.length + ' fresh')
}
return { bugs: [...seen].sort(), rounds: round }`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, { bugs: ["bug-1", "bug-2", "bug-3"], rounds: 4 });
  assert.equal(prompts.length, 4);
  assert.deepEqual(
    run.logs.filter((l) => l.startsWith("round")),
    ["round 1: 2 fresh", "round 2: 1 fresh"],
  );
});

test("budget-driven loop stops before exhausting the ceiling", async () => {
  const { runner, prompts } = scriptedRunner(() => "chunk", 100); // 100 output tokens per agent
  const script = `${META("budgeted")}
const results = []
while (budget.total && budget.remaining() > 150) {
  results.push(await agent('work item ' + results.length))
}
return { count: results.length, spent: budget.spent() }`;

  const run = await runWorkflow(script, { runner, tokenBudget: 450 });
  // 450 budget, 100/agent, loop guard at >150 remaining: 3 agents (spent 300, remaining 150 stops).
  assert.deepEqual(run.result, { count: 3, spent: 300 });
  assert.equal(prompts.length, 3);
});

test("adversarial verification: nested parallel voting inside pipeline", async () => {
  const { runner } = scriptedRunner((prompt, options) => {
    if (prompt.startsWith("find")) return "issue-A\nissue-B";
    // Verifiers use a schema; refute issue-B under every lens, keep issue-A.
    assert.ok(options.schema, "verifier must use a schema");
    return { refuted: prompt.includes("issue-B") };
  });
  const script = `${META("verify")}
const found = (await agent('find issues')).split('\\n')
const verdicts = await pipeline(found,
  (issue) => parallel(['correctness', 'security', 'repro'].map((lens) => () =>
    agent('as ' + lens + ' skeptic, refute: ' + issue, {
      label: lens + ':' + issue,
      schema: { type: 'object', properties: { refuted: { type: 'boolean' } }, required: ['refuted'] },
    }))),
  (votes, issue) => ({ issue, real: votes.filter(Boolean).filter((v) => !v.refuted).length >= 2 }))
return verdicts.filter((v) => v && v.real).map((v) => v.issue)`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, ["issue-A"]);
  assert.equal(run.agentCount, 7); // 1 finder + 2 issues x 3 lenses
});

test("sequential chain: each agent's output feeds the next prompt", async () => {
  const { runner, prompts } = scriptedRunner((prompt, _options, call) => `step${call}(${prompt})`);
  const script = `${META("chain")}
let value = 'seed'
for (const step of ['plan', 'apply', 'check']) {
  value = await agent(step + ' <- ' + value)
}
return value`;

  const run = await runWorkflow(script, { runner });
  assert.equal(run.result, "step3(check <- step2(apply <- step1(plan <- seed)))");
  assert.deepEqual(prompts, [
    "plan <- seed",
    "apply <- step1(plan <- seed)",
    "check <- step2(apply <- step1(plan <- seed))",
  ]);
});

test("args round-trips arrays and objects into the script", async () => {
  const { runner } = scriptedRunner((prompt) => `did:${prompt}`);
  const script = `${META("args_roundtrip")}
if (!Array.isArray(args.targets)) throw new Error('args.targets must be an array')
const results = await parallel(args.targets.map((t) => () => agent('process ' + t.name)))
return { mode: args.mode, results }`;

  const run = await runWorkflow(script, {
    runner,
    args: { mode: "strict", targets: [{ name: "x" }, { name: "y" }] },
  });
  assert.deepEqual(run.result, { mode: "strict", results: ["did:process x", "did:process y"] });
});

test("console.log routes into workflow logs; Set/Map/JSON usable", async () => {
  const { runner } = scriptedRunner(() => "ok");
  const script = `${META("stdlib")}
console.log('starting')
console.warn('careful')
const m = new Map([['k', 1]])
const s = new Set(['a', 'a', 'b'])
await agent('touch')
return JSON.parse(JSON.stringify({ m: m.get('k'), s: s.size }))`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, { m: 1, s: 2 });
  assert.ok(run.logs.includes("starting"));
  assert.ok(run.logs.includes("[warn] careful"));
});

test("sandbox hides host capabilities from scripts", async () => {
  const { runner } = scriptedRunner(() => "ok");
  const script = `${META("sandbox")}
await agent('touch')
return {
  requireType: typeof require,
  fetchType: typeof fetch,
  setTimeoutType: typeof setTimeout,
  processEnv: typeof process.env,
  processCwd: typeof process.cwd,
  importMeta: typeof globalThis.importScripts,
}`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, {
    requireType: "undefined",
    fetchType: "undefined",
    setTimeoutType: "undefined",
    processEnv: "undefined",
    processCwd: "function",
    importMeta: "undefined",
  });
});

test("a throwing pipeline stage skips the item's remaining stages", async () => {
  const stage2Calls: string[] = [];
  const runner: WorkflowRunnerLike = {
    async run(prompt) {
      if (prompt === "s1 poison") throw new Error("stage 1 died");
      if (prompt.startsWith("s2")) stage2Calls.push(prompt);
      return { result: prompt, usage: usage() };
    },
  };
  const script = `${META("skip_stages")}
return await pipeline(['good', 'poison'],
  async (item) => {
    const r = await agent('s1 ' + item)
    if (r === null) throw new Error('upstream failed for ' + item)
    return r
  },
  (prev) => agent('s2 ' + prev))`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, ["s2 s1 good", null]);
  assert.deepEqual(stage2Calls, ["s2 s1 good"]);
  assert.ok(run.logs.some((l) => l.includes("upstream failed for poison")));
});

test("script-thrown errors reject the whole run", async () => {
  const { runner } = scriptedRunner(() => "ok");
  await assert.rejects(
    runWorkflow(`${META("explode")}\nawait agent('x')\nthrow new Error('business rule violated')`, {
      runner,
    }),
    /business rule violated/,
  );
});

test("syntactically invalid scripts are rejected before any agent runs", async () => {
  const { runner, prompts } = scriptedRunner(() => "ok");
  await assert.rejects(runWorkflow(`${META("broken")}\nconst = nope(`, { runner }));
  assert.equal(prompts.length, 0);
});

test("fenced scripts execute after normalization at the tool boundary contract", async () => {
  // The tool strips fences via normalizeScript before runWorkflow; simulate that contract.
  const { normalizeScript } = await import("../src/parser.js");
  const { runner } = scriptedRunner(() => "ok");
  // biome-ignore lint/style/useTemplate: escaped backticks in a template obscure the fence being built
  const fenced = "```js\n" + META("fenced") + "return await agent('x')\n```";
  const run = await runWorkflow(normalizeScript(fenced), { runner });
  assert.equal(run.result, "ok");
});

test("mixed schema and text results compose in one script", async () => {
  const { runner } = scriptedRunner((_prompt, options) =>
    options.schema ? { score: 7, notes: ["solid"] } : "free text answer",
  );
  const script = `${META("mixed")}
const text = await agent('describe the repo')
const scored = await agent('score it', {
  schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
})
return { text, score: scored.score, notes: scored.notes }`;

  const run = await runWorkflow(script, { runner });
  assert.deepEqual(run.result, { text: "free text answer", score: 7, notes: ["solid"] });
});

test("concurrency cap holds across mixed parallel and pipeline load", async () => {
  let active = 0;
  let peak = 0;
  const runner: WorkflowRunnerLike = {
    async run(prompt) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { result: prompt, usage: usage() };
    },
  };
  const script = `${META("load")}
const [a, b] = await Promise.all([
  parallel([1, 2, 3, 4].map((n) => () => agent('p' + n))),
  pipeline([1, 2, 3, 4], (n) => agent('s1-' + n), (prev) => agent('s2-' + prev)),
])
return { a: a.length, b: b.length }`;

  const run = await runWorkflow(script, { runner, concurrency: 3 });
  assert.deepEqual(run.result, { a: 4, b: 4 });
  assert.equal(run.agentCount, 12);
  assert.ok(peak <= 3, `expected peak <= 3, got ${peak}`);
});
