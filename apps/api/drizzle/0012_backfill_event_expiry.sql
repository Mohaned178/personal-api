-- Events stored before M6-01 have no expires_at, and the purge only matches expires_at <= now, so
-- they would never be deleted. Give them the 90-day default (RETENTION_DEFAULT_DAYS). No policy
-- can exist before M6-01, and events set by set_retention or a policy already have a value.
-- Exact seconds, like ingest and the recompute job, so a DST change cannot shift the date.
UPDATE "events" SET "expires_at" = "received_at" + make_interval(secs => 7776000::float8) WHERE "expires_at" IS NULL;
