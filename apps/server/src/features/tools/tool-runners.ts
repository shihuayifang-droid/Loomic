// Server-side tool runners (GN-24, ED-00j, ED-07).
//
// The tool_execution executor does not know any concrete tool. It resolves the
// original image, hands the bytes to the runner registered under the job's
// `tool_id`, and stores whatever comes back. Each concrete tool (background
// removal, quick edits) is one runner, registered by its own module.

export type ToolRunnerInput = {
  /** The original object's bytes, never a display variant (ED-00j). */
  bytes: Buffer;
  mimeType: string;
  /** The source image's pixel size; the executor forces the output to match it. */
  width: number;
  height: number;
  params: Record<string, unknown>;
  model: string | null;
  signal?: AbortSignal;
};

export type ToolRunnerOutput = { bytes: Buffer; mimeType: string };

export type ToolRunner = (input: ToolRunnerInput) => Promise<ToolRunnerOutput>;

export type ToolRunErrorCode = "unknown_tool" | "invalid_input" | "provider_failed";

export class ToolRunError extends Error {
  readonly code: ToolRunErrorCode;

  constructor(code: ToolRunErrorCode, message: string) {
    super(message);
    this.name = "ToolRunError";
    this.code = code;
  }
}

const runners = new Map<string, ToolRunner>();

export function registerToolRunner(toolId: string, runner: ToolRunner): void {
  runners.set(toolId, runner);
}

export function getToolRunner(toolId: string): ToolRunner | undefined {
  return runners.get(toolId);
}

/** Test only: forget every registered runner. */
export function clearToolRunnersForTest(): void {
  runners.clear();
}
