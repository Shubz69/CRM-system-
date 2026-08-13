export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export type ImageGenerateOptions = {
  organisationId: string;
  /** Optional reference image bytes for providers that support image-to-image. */
  referenceImage?: {
    bytes: Buffer;
    mimeType: string;
  };
  size?: ImageSize;
  /** Already safety-reviewed generation prompt. */
  prompt: string;
};

export type ImageResult = {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  /** Estimated billable cost in USD cents for this call. */
  costCents: number;
  rawMetadata?: Record<string, unknown>;
};

export type ImageProvider = {
  readonly name: string;
  generate(options: ImageGenerateOptions): Promise<ImageResult>;
};

export class ImageProviderNotConfiguredError extends Error {
  readonly code = "IMAGE_PROVIDER_NOT_CONFIGURED";
  constructor(message = "Image generation provider is not configured") {
    super(message);
    this.name = "ImageProviderNotConfiguredError";
  }
}

/** Plain-English safety refusal — never a raw stack trace for the user. */
export class ImageSafetyError extends Error {
  readonly code = "IMAGE_SAFETY";
  constructor(
    readonly userFacingMessage: string,
    readonly alternativeSuggestion: string,
  ) {
    super(userFacingMessage);
    this.name = "ImageSafetyError";
  }
}
