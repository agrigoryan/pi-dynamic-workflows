import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Live end-to-end: drives a real `pi` binary with the extension loaded, spawning real
 * subagent LLM sessions. Costs tokens and needs configured pi auth, so it only runs
 * when explicitly requested:
 *
 *   RUN_LIVE_E2E=1 npm run test:live
 */

const LIVE = process.env.RUN_LIVE_E2E === "1";
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "workflow.ts");

/**
 * Run pi headless with stdin ignored: pi reads piped stdin when it is not a TTY,
 * so an open-but-silent stdin pipe (execFile's default) hangs it forever.
 */
function runPi(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`pi exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

test("live: pi runs a two-agent workflow with schema output and phases", { skip: !LIVE }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-live-"));
  writeFileSync(join(cwd, "colors.txt"), "red\ngreen\nblue\n");
  try {
    const prompt = `Call the workflow tool with exactly this script (script parameter, verbatim):

export const meta = { name: "live_smoke", description: "live e2e smoke test", phases: [{ title: "Read" }, { title: "Verify" }] }
phase("Read")
const data = await agent("Read the file colors.txt in the current directory and return ONLY its lines as JSON.", { label: "read colors", schema: { type: "object", properties: { colors: { type: "array", items: { type: "string" } } }, required: ["colors"] } })
phase("Verify")
const count = await agent("Reply with ONLY the number of items in this list, as digits: " + data.colors.join(", "), { label: "count colors" })
return { colors: data.colors, count: count.trim() }

After the workflow completes, print the workflow result JSON verbatim and nothing else.`;

    const stdout = await runPi(["-e", extensionPath, "--no-session", "-p", prompt], cwd, 300_000);

    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    assert.deepEqual(parsed.colors, ["red", "green", "blue"]);
    assert.equal(String(parsed.count).trim(), "3");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
