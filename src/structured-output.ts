import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export interface StructuredOutputCapture {
  called: boolean;
  value: unknown;
}

/**
 * Terminating tool that captures schema-validated params as the subagent's result.
 * Pi validates params against the schema before execute() runs; `terminate: true`
 * ends the subagent turn without an extra assistant follow-up.
 */
export function createStructuredOutputTool(
  schema: TSchema,
  capture: StructuredOutputCapture,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return the final machine-readable result for this task. Call exactly once, as your final action.",
    parameters: schema as any,
    async execute(_toolCallId, params) {
      capture.called = true;
      capture.value = params;
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: params,
        terminate: true,
      };
    },
  }) as unknown as ToolDefinition;
}

export const STRUCTURED_OUTPUT_CONTRACT = [
  "Final output contract:",
  "- Your final action MUST be a single structured_output tool call; its arguments are your return value.",
  "- Do not write a prose final answer instead of (or after) calling structured_output.",
  "- Inspect files or run commands first if needed, then call structured_output exactly once.",
].join("\n");
