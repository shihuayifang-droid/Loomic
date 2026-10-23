// ED-06 / GN-05 — the `quick_edit` tool runner.
//
// The tool executor resolves the artifact's ORIGINAL bytes and hands them here
// together with the panel params; this runner turns them into one image edit on
// the gateway — the source image as the reference plus the prompt — and returns
// the edited image. Forcing the product back to the source size and to PNG is the
// executor's job (ED-07 / workorder 40P), not this module's.
import { generateImage } from "../../../generation/image-generation.js";
import { OpenAIImageProvider } from "../../../generation/providers/openai-image.js";
import type { GeneratedImage } from "../../../generation/types.js";
import { ToolRunError, type ToolRunner, type ToolRunnerInput } from "../tool-runners.js";

/** ED-06's execution model, used when the job payload names none (GN-05). */
export const QUICK_EDIT_DEFAULT_MODEL = "kwjm/gpt-image-2.5-sunburst";

/**
 * The gateway provider name (GN-05).
 *
 * `PROVIDER_NAME` in `openai-image.ts` is module-private, and GN-05 makes the
 * MODEL configurable while the provider stays fixed, so the name is read off the
 * provider instead of being written a second time here — two literals would drift
 * the moment the provider is renamed.
 */
const PROVIDER_NAME = new OpenAIImageProvider("").name;

const DOWNLOAD_TIMEOUT_MS = 60_000;

export function createQuickEditRunner(
  deps: { generate?: typeof generateImage } = {},
): ToolRunner {
  const generate = deps.generate ?? generateImage;

  return async (input: ToolRunnerInput) => {
    const prompt = readPrompt(input.params);
    // ED-06: the panel's `empty_prompt` rule, enforced here as well — an empty
    // prompt never reaches the provider, so it can never be billed.
    if (prompt.length === 0) {
      throw new ToolRunError("invalid_input", "请先描述要怎么改");
    }

    const model = input.model ?? QUICK_EDIT_DEFAULT_MODEL;
    let generated: GeneratedImage;
    try {
      generated = await generate(PROVIDER_NAME, {
        model,
        prompt,
        inputImages: [dataUriOf(input.mimeType, input.bytes)],
        size: { width: input.width, height: input.height },
      });
    } catch (error) {
      throw new ToolRunError("provider_failed", messageOf(error));
    }

    try {
      const bytes = generated.url.startsWith("data:")
        ? decodeDataUri(generated.url)
        : await downloadBytes(generated.url);
      return { bytes, mimeType: "image/png" };
    } catch (error) {
      throw error instanceof ToolRunError
        ? error
        : new ToolRunError("provider_failed", messageOf(error));
    }
  };
}

/** `params.prompt` is untyped JSON from the job payload; anything else is empty. */
function readPrompt(params: Record<string, unknown>): string {
  const raw = params.prompt;
  return typeof raw === "string" ? raw.trim() : "";
}

function dataUriOf(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeDataUri(dataUri: string): Buffer {
  const comma = dataUri.indexOf(",");
  if (!dataUri.startsWith("data:") || comma === -1) {
    throw new ToolRunError("provider_failed", "The gateway returned an unreadable image");
  }
  return Buffer.from(dataUri.slice(comma + 1), "base64");
}

async function downloadBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new ToolRunError(
      "provider_failed",
      `The gateway image download failed: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}
