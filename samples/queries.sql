-- Queries to try after inserting samples/events.csv. Run one at a time (select it and press Run), or all at once as a
-- script: each gets its own tab. Switch a result to Chart to see it drawn.

-- Requests per host: bars
SELECT host, count() AS requests
FROM default.events
GROUP BY host
ORDER BY requests DESC;

-- Latency over time: a line
SELECT time, duration_ms
FROM default.events
ORDER BY time;

-- Error rate per host: two numeric columns (tick both to compare them)
SELECT host, countIf(status >= 500) AS errors, countIf(status >= 400 AND status < 500) AS not_found
FROM default.events
GROUP BY host
ORDER BY host;
