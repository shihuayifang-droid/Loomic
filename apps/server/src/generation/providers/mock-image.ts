import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageModelInfo,
  ImageProvider,
} from "../types.js";

/**
 * A fixed 1x1 PNG. Every mock generation returns exactly these bytes, so two
 * calls with the same input are byte-identical and no network is involved.
 */
const MOCK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Result of a mock generation: the normal shape plus a checkable marker. */
export type MockGeneratedImage = GeneratedImage & {
  providerMeta: { mock: true; replaces: string };
};

/**
 * Offline stand-in for a real image provider (HAHART_IMAGE_PROVIDER_MOCK).
 *
 * It takes over the NAME and the declared MODELS of the provider it replaces, so
 * the model catalogue, minTier, price rules and billing all behave exactly as for
 * the real thing; only the "call the upstream" step is swapped for a
 * deterministic fake image.
 */
export class MockImageProvider implements ImageProvider {
  readonly name: string;
  readonly models: readonly ImageModelInfo[];

  constructor(replaced: ImageProvider) {
    this.name = replaced.name;
    this.models = replaced.models;
  }

  async generate(params: ImageGenerateParams): Promise<MockGeneratedImage> {
    return {
      url: `data:image/png;base64,${MOCK_PNG_BASE64}`,
      mimeType: "image/png",
      width: params.size?.width ?? 1024,
      height: params.size?.height ?? 1024,
      providerMeta: { mock: true, replaces: this.name },
    };
  }
}
