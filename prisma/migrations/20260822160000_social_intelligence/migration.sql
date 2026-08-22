-- Phase 4 Social Intelligence: canonical content + metric time series.

CREATE TABLE "SocialCreator" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "profileUrl" TEXT,
    "externalId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialCreator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialCreator_organisationId_platform_handle_key"
  ON "SocialCreator"("organisationId", "platform", "handle");
CREATE INDEX "SocialCreator_organisationId_platform_idx"
  ON "SocialCreator"("organisationId", "platform");

ALTER TABLE "SocialCreator"
  ADD CONSTRAINT "SocialCreator_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialContent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "externalId" TEXT,
    "creatorId" TEXT,
    "title" TEXT,
    "body" TEXT,
    "publishedAt" TIMESTAMP(3),
    "format" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "researchSourceId" TEXT,
    "socialPostId" TEXT,
    "rawMetadata" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialContent_organisationId_platform_url_key"
  ON "SocialContent"("organisationId", "platform", "url");
CREATE INDEX "SocialContent_organisationId_platform_publishedAt_idx"
  ON "SocialContent"("organisationId", "platform", "publishedAt");
CREATE INDEX "SocialContent_organisationId_creatorId_idx"
  ON "SocialContent"("organisationId", "creatorId");
CREATE INDEX "SocialContent_organisationId_lastSeenAt_idx"
  ON "SocialContent"("organisationId", "lastSeenAt");
CREATE INDEX "SocialContent_organisationId_format_idx"
  ON "SocialContent"("organisationId", "format");

ALTER TABLE "SocialContent"
  ADD CONSTRAINT "SocialContent_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialContent"
  ADD CONSTRAINT "SocialContent_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "SocialCreator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SocialMetricSnapshot" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "socialContentId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "score" DOUBLE PRECISION,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialMetricSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SocialMetricSnapshot_organisationId_socialContentId_capturedAt_idx"
  ON "SocialMetricSnapshot"("organisationId", "socialContentId", "capturedAt");
CREATE INDEX "SocialMetricSnapshot_organisationId_capturedAt_idx"
  ON "SocialMetricSnapshot"("organisationId", "capturedAt");
CREATE INDEX "SocialMetricSnapshot_socialContentId_capturedAt_idx"
  ON "SocialMetricSnapshot"("socialContentId", "capturedAt");

ALTER TABLE "SocialMetricSnapshot"
  ADD CONSTRAINT "SocialMetricSnapshot_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialMetricSnapshot"
  ADD CONSTRAINT "SocialMetricSnapshot_socialContentId_fkey"
  FOREIGN KEY ("socialContentId") REFERENCES "SocialContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
