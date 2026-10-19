CREATE TABLE "bulk_deletions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"filter" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer,
	"deleted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "bulk_deletions_kind_check" CHECK ("bulk_deletions"."kind" IN ('events', 'integration')),
	CONSTRAINT "bulk_deletions_status_check" CHECK ("bulk_deletions"."status" IN ('queued', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "bulk_deletions" ADD CONSTRAINT "bulk_deletions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulk_deletions_user_id_idx" ON "bulk_deletions" USING btree ("user_id");