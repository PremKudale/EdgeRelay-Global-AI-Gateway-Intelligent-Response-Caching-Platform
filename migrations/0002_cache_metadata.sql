-- This migration is only needed when upgrading an early EdgeCache deployment
-- whose request_events table was created before response_bytes was tracked.
ALTER TABLE request_events ADD COLUMN response_bytes INTEGER;
