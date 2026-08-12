import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentUsage, SubagentRunResult } from "../src/agent-runner.js";
import { RunJournal } from "../src/journal.js";
import { runWorkflow, type WorkflowRunnerLike } from "../src/runtime.js";

const root = mkdtempSync(join(tmpdir(), "pi-dw-test-"));
process.env.PI_DYNAMIC_WORKFLOWS_DIR = root;

after(() => rmSync(root, { recursive: true, force: true }));

const usage = (): AgentUsage => ({ input: 1, output: 2, totalTokens: 3, cost: 0, turns: 1 });
const META = "export const meta = { name: 'journal-test', description: 'journal test' }\n";

function countingRunner(): { runner: WorkflowRunnerLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      async run(prompt): Promise<SubagentRunResult> {
        calls.push(prompt);
        return { result: `live:${prompt}`, usage: usage() };
      },
    },
  };
}

test("resume replays unchanged calls and re-runs edited ones", async () => {
  const cwd = "/fake/project";
  const script = `${META}
const a = await agent('alpha')
const b = await agent('beta')
return [a, b]`;

  const first = countingRunner();
  const journalA = new RunJournal(cwd, "wf_first");
  const runA = await runWorkflow(script, { runner: first.runner, journal: journalA });
  assert.deepEqual(runA.result, ["live:alpha", "live:beta"]);
  assert.equal(first.calls.length, 2);
  assert.equal(runA.replayedCount, 0);

  // Same script: 100% cache hit.
  const second = countingRunner();
  const journalB = new RunJournal(cwd, "wf_second");
  journalB.loadReplayCache(cwd, "wf_first");
  const runB = await runWorkflow(script, { runner: second.runner, journal: journalB });
  assert.deepEqual(runB.result, ["live:alpha", "live:beta"]);
  assert.equal(second.calls.length, 0);
  assert.equal(runB.replayedCount, 2);

  // Edited prompt: only the edited call runs live.
  const edited = `${META}
const a = await agent('alpha')
const b = await agent('beta-edited')
return [a, b]`;
  const third = countingRunner();
  const journalC = new RunJournal(cwd, "wf_third");
  journalC.loadReplayCache(cwd, "wf_first");
  const runC = await runWorkflow(edited, { runner: third.runner, journal: journalC });
  assert.deepEqual(runC.result, ["live:alpha", "live:beta-edited"]);
  assert.deepEqual(third.calls, ["beta-edited"]);
  assert.equal(runC.replayedCount, 1);
});

test("repeated identical prompts replay by occurrence", async () => {
  const cwd = "/fake/project2";
  const script = `${META}
const first = await agent('same')
const second = await agent('same')
return [first, second]`;

  const journalA = new RunJournal(cwd, "wf_occ_a");
  let counter = 0;
  const runner: WorkflowRunnerLike = {
    async run(prompt) {
      counter++;
      return { result: `${prompt}:${counter}`, usage: usage() };
    },
  };
  const runA = await runWorkflow(script, { runner, journal: journalA });
  assert.deepEqual(runA.result, ["same:1", "same:2"]);

  const journalB = new RunJournal(cwd, "wf_occ_b");
  journalB.loadReplayCache(cwd, "wf_occ_a");
  const replayOnly: WorkflowRunnerLike = {
    async run() {
      throw new Error("should not run live");
    },
  };
  const runB = await runWorkflow(script, { runner: replayOnly, journal: journalB });
  assert.deepEqual(runB.result, ["same:1", "same:2"]);
  assert.equal(runB.replayedCount, 2);
});

test("failed agents are not journaled", async () => {
  const cwd = "/fake/project3";
  const script = `${META}
const value = await agent('flaky')
return { value }`;

  const journalA = new RunJournal(cwd, "wf_fail_a");
  const failing: WorkflowRunnerLike = {
    async run() {
      throw new Error("transient");
    },
  };
  const runA = await runWorkflow(script, { runner: failing, journal: journalA });
  assert.deepEqual(runA.result, { value: null });

  const journalB = new RunJournal(cwd, "wf_fail_b");
  journalB.loadReplayCache(cwd, "wf_fail_a");
  const { runner, calls } = countingRunner();
  const runB = await runWorkflow(script, { runner, journal: journalB });
  assert.deepEqual(runB.result, { value: "live:flaky" });
  assert.deepEqual(calls, ["flaky"]);
  assert.equal(runB.replayedCount, 0);
});
