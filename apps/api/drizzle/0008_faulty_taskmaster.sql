CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoints_user_slug_key" UNIQUE("user_id","slug")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_endpoint_id_idx" ON "api_keys" USING btree ("endpoint_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_endpoint_read_check" CHECK ("api_keys"."endpoint_id" IS NULL OR "api_keys"."kind" = 'read');