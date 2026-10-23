// ED-07 / GN-05 — the `remove_background` tool runner.
//
// Replicate is the provider the user picked on 2026-10-23 after the gateway's
// `gpt-image-2.5` redrew the subject instead of cutting it out. The prediction is
// awaited synchronously for us (`Prefer: wait`), and the input image travels as
// BYTES in a data URI — never as a signed URL — because a short-lived read
// credential must not be handed to a third party. The prediction's output is
// already a transparent PNG; forcing the source size is the executor's job
// (workorder 40P).
import { ToolRunError, type ToolRunner, type ToolRunnerInput } from "../tool-runners.js";

/**
 * Same base as `generation/providers/replicate-image.ts`; that constant is
 * module-private, and this module may not widen its exports.
 */
const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/** The model behind ED-07's 「去背景」. */
const BACKGROUND_REMOVAL_MODEL = "851-labs/background-remover";

const PREDICTION_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

type Prediction = {
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  detail?: string;
};

export function createRemoveBackgroundRunner(deps: {
  apiToken: string;
  fetchImpl?: typeof fetch;
}): ToolRunner {
  const doFetch = deps.fetchImpl ?? fetch;

  return async (input: ToolRunnerInput) => {
    // A missing token is an operator problem (U-21), not a construction problem:
    // failing HERE keeps the process alive and records the failure on the job as a
    // provider failure instead of taking the worker down at start-up.
    if (deps.apiToken.length === 0) {
      throw new ToolRunError("provider_failed", "Replicate API token is not configured");
    }

    const prediction = await requestPrediction(doFetch, deps.apiToken, input);
    const url = outputUrl(prediction);
    if (!url) {
      throw new ToolRunError("provider_failed", "Replicate returned no output image");
    }
    return { bytes: await downloadBytes(doFetch, url), mimeType: "image/png" };
  };
}

async function requestPrediction(
  doFetch: typeof fetch,
  apiToken: string,
  input: ToolRunnerInput,
): Promise<Prediction> {
  const image = `data:${input.mimeType};base64,${input.bytes.toString("base64")}`;

  try {
    const response = await doFetch(
      `${REPLICATE_API_BASE}/models/${BACKGROUND_REMOVAL_MODEL}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input: { image } }),
        signal: AbortSignal.timeout(PREDICTION_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: string } | null;
      throw new ToolRunError(
        "provider_failed",
        `Replicate API error ${response.status}: ${body?.detail ?? "Unknown error"}`,
      );
    }

    const prediction = (await response.json()) as Prediction;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new ToolRunError(
        "provider_failed",
        `Replicate prediction ${prediction.status}: ${prediction.error ?? "no error message"}`,
      );
    }
    if (prediction.status !== "succeeded") {
      throw new ToolRunError(
        "provider_failed",
        `Replicate prediction did not finish: ${prediction.status ?? "unknown status"}`,
      );
    }
    return prediction;
  } catch (error) {
    // The message never carries the token: only a status number or Replicate's own
    // `error` text, and every error below is built that way.
    throw error instanceof ToolRunError
      ? error
      : new ToolRunError("provider_failed", messageOf(error));
  }
}

/** Replicate answers with a single URL string, or an array whose first item is it. */
function outputUrl(prediction: Prediction): string | null {
  const output = prediction.output;
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output)) {
    const first = output[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return null;
}

async function downloadBytes(doFetch: typeof fetch, url: string): Promise<Buffer> {
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      throw new ToolRunError(
        "provider_failed",
        `Replicate output download failed: ${response.status} ${response.statusText}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw error instanceof ToolRunError
      ? error
      : new ToolRunError("provider_failed", messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
