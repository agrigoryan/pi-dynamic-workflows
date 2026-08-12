import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listRuns, projectRunsDir } from "../src/journal.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

export default function extension(pi: ExtensionAPI) {
  const workflowTool = createWorkflowTool();
  pi.registerTool(workflowTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });

  pi.registerCommand("workflows", {
    description: "List recent dynamic workflow runs for this project (runId, status, agents)",
    handler: async (_args, ctx) => {
      const runs = listRuns(ctx.cwd);
      if (runs.length === 0) {
        ctx.ui.notify(`No workflow runs yet (${projectRunsDir(ctx.cwd)})`, "info");
        return;
      }
      const lines = runs.map((run) => {
        const when = run.startedAt.replace("T", " ").slice(0, 19);
        const agents = run.agentCount != null ? ` · ${run.agentCount} agents` : "";
        const error = run.error ? ` · ${run.error.slice(0, 60)}` : "";
        return `${run.runId}  ${run.status.padEnd(9)}  ${when}  ${run.name}${agents}${error}`;
      });
      ctx.ui.notify(["Recent workflow runs:", ...lines].join("\n"), "info");
    },
  });
}
