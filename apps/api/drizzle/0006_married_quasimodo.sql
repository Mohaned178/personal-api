ALTER TABLE "api_keys" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "restriction" jsonb;