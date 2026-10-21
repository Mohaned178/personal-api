-- Read keys and saved-query endpoints are removed (M9-01). Delete every read key first, so the
-- ingest-only constraints added below hold on a database that had some. Ingest keys are untouched.
DELETE FROM "api_keys" WHERE "kind" <> 'ingest';--> statement-breakpoint
ALTER TABLE "endpoints" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- CASCADE also drops the foreign key from api_keys.endpoint_id.
DROP TABLE "endpoints" CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_endpoint_read_check";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_kind_check";--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_ingest_integration_check";--> statement-breakpoint
DROP INDEX "api_keys_endpoint_id_idx";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "endpoint_id";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "scopes";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "restriction";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" = 'ingest');--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_ingest_integration_check" CHECK ("api_keys"."integration_id" IS NOT NULL);