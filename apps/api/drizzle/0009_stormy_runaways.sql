CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"target" text NOT NULL,
	"days" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_target_key" UNIQUE("user_id","scope","target"),
	CONSTRAINT "retention_policies_scope_check" CHECK ("retention_policies"."scope" IN ('source', 'type')),
	CONSTRAINT "retention_policies_days_check" CHECK ("retention_policies"."days" BETWEEN 1 AND 3650)
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;