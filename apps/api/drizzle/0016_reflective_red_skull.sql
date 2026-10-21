CREATE TABLE "category_goals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_goals_category_key" UNIQUE("user_id","category"),
	CONSTRAINT "category_goals_category_check" CHECK ("category_goals"."category" IN ('distracting', 'neutral')),
	CONSTRAINT "category_goals_minutes_check" CHECK ("category_goals"."minutes" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "site_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"pattern" text NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_categories_pattern_key" UNIQUE("user_id","pattern"),
	CONSTRAINT "site_categories_category_check" CHECK ("site_categories"."category" IN ('productive', 'neutral', 'distracting'))
);
--> statement-breakpoint
ALTER TABLE "category_goals" ADD CONSTRAINT "category_goals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_categories" ADD CONSTRAINT "site_categories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;