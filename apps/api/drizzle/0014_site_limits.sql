CREATE TABLE "site_limits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"pattern" text NOT NULL,
	"minutes" integer NOT NULL,
	"strict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_limits_pattern_key" UNIQUE("user_id","pattern"),
	CONSTRAINT "site_limits_minutes_check" CHECK ("site_limits"."minutes" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
ALTER TABLE "site_limits" ADD CONSTRAINT "site_limits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;