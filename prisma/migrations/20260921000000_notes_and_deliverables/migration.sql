-- CreateTable
CREATE TABLE "notes" (
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "session_key" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("user_id","course_id","session_key")
);

-- CreateTable
CREATE TABLE "deliverables" (
    "user_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "session_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "comment" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deliverables_pkey" PRIMARY KEY ("user_id","course_id","session_key")
);

-- CreateIndex
CREATE INDEX "notes_user_id_updated_at_idx" ON "notes"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "deliverables_user_id_submitted_at_idx" ON "deliverables"("user_id", "submitted_at");

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
