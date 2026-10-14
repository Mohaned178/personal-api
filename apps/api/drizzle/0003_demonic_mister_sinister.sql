ALTER TABLE "integrations" DROP CONSTRAINT "integrations_kind_check";--> statement-breakpoint
UPDATE "integrations" SET "kind" = 'browser-extension' WHERE "kind" = 'chrome-extension';--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_kind_check" CHECK ("integrations"."kind" IN ('browser-extension', 'http'));
