export type VideoGenerateOptions = {
  organisationId: string;
  prompt: string;
  title?: string;
  durationSeconds?: number;
  aspectRatio?: "9:16" | "16:9" | "1:1";
};

export type VideoResult = {
  bytes: Buffer;
  mimeType: string;
  provider: string;
  model: string;
  costCents: number;
  durationSeconds?: number;
};

export type VideoProvider = {
  readonly name: string;
  generate(options: VideoGenerateOptions): Promise<VideoResult>;
};

/**
 * Fail-closed when no video generation provider is wired.
 * code is AUTH_REQUIRED so Ask/UI can show the same honest missing-key pattern as research.
 */
export class VideoProviderNotConfiguredError extends Error {
  readonly code = "AUTH_REQUIRED";
  readonly reason = "VIDEO_PROVIDER_NOT_CONFIGURED";
  readonly userFacingMessage: string;
  constructor(
    message = "Example AI videos are not configured. Set VIDEO_PROVIDER and the matching API key.",
  ) {
    super(message);
    this.name = "VideoProviderNotConfiguredError";
    this.userFacingMessage = message;
  }
}
