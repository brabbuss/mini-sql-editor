-- A table for the sample files (samples/events.csv, .ndjson, .parquet). Paste into the editor and Run.
-- The DROP makes it start empty each time, and asks you to confirm first (the destructive-statement guard).
DROP TABLE IF EXISTS default.events;

CREATE TABLE default.events
(
    time DateTime,
    host LowCardinality(String),
    status UInt16,
    duration_ms Float64
)
ENGINE = MergeTree
ORDER BY time;

-- Then: Insert file → default.events → samples/events.csv (40 rows)
SELECT count() AS rows FROM default.events;
