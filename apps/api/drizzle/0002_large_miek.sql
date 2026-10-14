CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"integration_id" uuid,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" IN ('ingest', 'read')),
	CONSTRAINT "api_keys_ingest_integration_check" CHECK ("api_keys"."kind" <> 'ingest' OR "api_keys"."integration_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"integration_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"type" text NOT NULL,
	"type_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"client_occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin" text DEFAULT 'collected' NOT NULL,
	"data" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"trace" jsonb,
	"expires_at" timestamp with time zone,
	CONSTRAINT "events_dedupe_key" UNIQUE("user_id","integration_id","client_event_id"),
	CONSTRAINT "events_origin_check" CHECK ("events"."origin" IN ('collected', 'imported', 'derived'))
);
--> statement-breakpoint
CREATE TABLE "ingestion_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"integration_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"duplicate" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"by_reason" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ingestion_log_bucket_key" UNIQUE("user_id","integration_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"default_policy" text DEFAULT 'deny' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_heartbeat" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_kind_check" CHECK ("integrations"."kind" IN ('chrome-extension', 'http')),
	CONSTRAINT "integrations_default_policy_check" CHECK ("integrations"."default_policy" IN ('deny', 'allow')),
	CONSTRAINT "integrations_status_check" CHECK ("integrations"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_log" ADD CONSTRAINT "ingestion_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_log" ADD CONSTRAINT "ingestion_log_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_user_occurred_idx" ON "events" USING btree ("user_id","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "events_user_type_occurred_idx" ON "events" USING btree ("user_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_expires_at_idx" ON "events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "integrations_user_id_idx" ON "integrations" USING btree ("user_id");