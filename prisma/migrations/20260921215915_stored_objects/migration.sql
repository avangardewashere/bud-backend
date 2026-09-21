-- CreateTable
CREATE TABLE "stored_objects" (
    "key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "body" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_objects_pkey" PRIMARY KEY ("key")
);
