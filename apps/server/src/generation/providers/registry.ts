import type {
  ImageModelInfo,
  ImageOperation,
  ImageProvider,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError } from "../utils.js";

const imageProviders = new Map<string, ImageProvider>();
const videoProviders = new Map<string, VideoProvider>();

export function registerImageProvider(provider: ImageProvider): void {
  imageProviders.set(provider.name, provider);
}

export function registerVideoProvider(provider: VideoProvider): void {
  videoProviders.set(provider.name, provider);
}

export function getImageProvider(name: string): ImageProvider {
  const provider = imageProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      name,
      "provider_not_found",
      `No image provider registered: ${name}`,
    );
  }
  return provider;
}

export function getVideoProvider(name: string): VideoProvider {
  const provider = videoProviders.get(name);
  if (!provider) {
    throw new GenerationError(
      name,
      "provider_not_found",
      `No video provider registered: ${name}`,
    );
  }
  return provider;
}

/**
 * Model info enriched with its owning provider name.
 *
 * Extends ImageModelInfo, not the bare ModelInfo: the spread in
 * `getAvailableImageModels` always carried `limits` at runtime, but the wider
 * type hid it from every consumer, so the tool schema had to hard-code reference
 * image counts in prose instead of reading them.
 */
export interface AvailableModel extends ImageModelInfo {
  provider: string;
}

export interface AvailableVideoModel extends VideoModelInfo {
  provider: string;
}

/**
 * Returns image models from all registered providers.
 *
 * Pass an operation to get only the models that perform it. Tools must do this:
 * a text-to-image tool that lists an upscaler would let the LLM pick a model
 * that ignores its prompt. Omitting the argument returns everything and is only
 * right for the "show the user the whole catalogue" case.
 */
export function getAvailableImageModels(
  operation?: ImageOperation,
): AvailableModel[] {
  return [...imageProviders.values()].flatMap((p) =>
    p.models
      .filter((m) => operation === undefined || m.operation === operation)
      .map((m) => ({ ...m, provider: p.name })),
  );
}

/** Returns all video models from all registered providers. */
export function getAvailableVideoModels(): AvailableVideoModel[] {
  return [...videoProviders.values()].flatMap((p) =>
    p.models.map((m) => ({ ...m, provider: p.name })),
  );
}

/**
 * Resolves the provider name that handles a given image model ID.
 *
 * Pass `expectedOperation` to also assert the model does what the caller is
 * about to ask of it. Without that check an upscaler id reaching a text-to-image
 * call site would be dispatched happily and produce a confusing result rather
 * than an error.
 */
export function resolveImageProviderName(
  modelId: string,
  expectedOperation?: ImageOperation,
): string {
  for (const provider of imageProviders.values()) {
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) continue;
    if (expectedOperation !== undefined && model.operation !== expectedOperation) {
      throw new GenerationError(
        provider.name,
        "model_not_found",
        `Image model ${modelId} performs "${model.operation}", not "${expectedOperation}"`,
      );
    }
    return provider.name;
  }
  throw new GenerationError(
    "unknown",
    "model_not_found",
    `No provider registered for image model: ${modelId}`,
  );
}

/** Resolves the provider name that handles a given video model ID. */
export function resolveVideoProviderName(modelId: string): string {
  for (const provider of videoProviders.values()) {
    if (provider.models.some((m) => m.id === modelId)) {
      return provider.name;
    }
  }
  throw new GenerationError(
    "unknown",
    "model_not_found",
    `No provider registered for video model: ${modelId}`,
  );
}

export function clearProviders(): void {
  imageProviders.clear();
  videoProviders.clear();
}
