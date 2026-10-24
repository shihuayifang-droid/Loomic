/**
 * Centralized provider registration.
 *
 * Both the HTTP server (app.ts) and the background worker (worker.ts) need the
 * same set of image/video generation providers. This module is the single
 * source of truth so that adding a new provider only requires a change here.
 */
import type { ServerEnv } from "../../config/env.js";
import type { ImageProvider } from "../types.js";
import { GoogleImageProvider } from "./google-image.js";
import { GoogleVertexImageProvider } from "./google-vertex-image.js";
import { GoogleVertexVideoProvider } from "./google-vertex-video.js";
import { GoogleVideoProvider } from "./google-video.js";
import { MetasoVideoProvider } from "./metaso-video.js";
import { MockImageProvider } from "./mock-image.js";
import { OpenAIImageProvider } from "./openai-image.js";
import { registerImageProvider, registerVideoProvider } from "./registry.js";
import { ReplicateImageProvider } from "./replicate-image.js";
import { ReplicateVideoProvider } from "./replicate-video.js";
import { VolcesImageProvider } from "./volces-image.js";

/**
 * Register all available generation providers based on the provided env config.
 *
 * Each provider is only registered when its required API key is present,
 * keeping the behaviour identical to the previous inline registration while
 * ensuring every process gets the full set.
 */
export function registerAllProviders(env: ServerEnv): void {
  // HAHART_IMAGE_PROVIDER_MOCK: every image provider that WOULD be registered is
  // replaced by an offline mock with the same name and models (video untouched).
  const registerImage = (provider: ImageProvider): void => {
    registerImageProvider(
      env.hahartImageProviderMock ? new MockImageProvider(provider) : provider,
    );
  };

  // Metaso — MiniMax H3 V2 video
  if (env.metasoApiKey) {
    registerVideoProvider(
      new MetasoVideoProvider(env.metasoApiKey, env.metasoApiBase),
    );
  }

  // Replicate — image + video
  if (env.replicateApiToken) {
    registerImage(new ReplicateImageProvider(env.replicateApiToken));
    registerVideoProvider(new ReplicateVideoProvider(env.replicateApiToken));
  }

  // Google Developer API — image + video.
  // googleApiBase lets this point at a Gemini-compatible gateway (e.g. kwjm)
  // instead of generativelanguage.googleapis.com. Going through the native
  // Gemini endpoint rather than the gateway's OpenAI-style image API preserves
  // multi-reference-image input (up to 14 on Gemini 3 Pro), aspect ratio and
  // 1K/2K/4K sizing, none of which the OpenAI-style path supports here.
  if (env.googleApiKey) {
    registerImage(new GoogleImageProvider(env.googleApiKey, env.googleApiBase));
    registerVideoProvider(new GoogleVideoProvider(env.googleApiKey));
  }

  // Google Vertex AI — image + video (coexists with Developer API)
  // Image/LLM models use the default location (global), while video models
  // require a separate regional endpoint (us-central1).
  if (env.googleVertexProject && env.googleVertexLocation) {
    const vertexConfig = {
      project: env.googleVertexProject,
      location: env.googleVertexLocation,
    };
    registerImage(new GoogleVertexImageProvider(vertexConfig));

    const videoLocation =
      env.googleVertexVideoLocation ?? env.googleVertexLocation;
    registerVideoProvider(
      new GoogleVertexVideoProvider({
        project: env.googleVertexProject,
        location: videoLocation,
      }),
    );
  }

  // OpenAI — image only
  if (env.openAIApiKey) {
    registerImage(new OpenAIImageProvider(env.openAIApiKey, env.openAIApiBase));
  }

  // Volces — image only
  if (env.volcesApiKey) {
    registerImage(new VolcesImageProvider(env.volcesApiKey, env.volcesBaseUrl));
  }
}
