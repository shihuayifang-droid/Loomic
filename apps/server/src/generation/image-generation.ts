import type { GeneratedImage, ImageGenerateParams } from "./types.js";
import { getImageProvider } from "./providers/registry.js";
import { isReferenceImageLimitError, REFERENCE_IMAGE_LIMIT_CODE } from "./upstream-error.js";
import { GenerationError } from "./utils.js";

/**
 * Runs one image generation on a provider.
 *
 * MD-03 / workorder 40B: the six models with an unverified reference-image cap
 * declare `"unbounded"`, so nothing is intercepted on the client. That makes the
 * UPSTREAM refusal the only moment the cap becomes visible, and it used to reach
 * the user as the generic `api_error`. The translation here turns that one
 * refusal into its own code — which the worker does not retry and the web
 * catalogue has copy for — while every other failure is rethrown untouched, same
 * object and same code, so the existing retry / terminal branches keep seeing
 * exactly what they saw before.
 */
export async function generateImage(
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = getImageProvider(providerName);

  try {
    return await provider.generate(params);
  } catch (error) {
    if (isReferenceImageLimitError(error)) {
      throw new GenerationError(providerName, REFERENCE_IMAGE_LIMIT_CODE, "该模型参考图数量超限");
    }
    throw error;
  }
}
