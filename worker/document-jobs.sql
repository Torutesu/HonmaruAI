-- Dedicated document queue. Old JavaScript gateways cannot claim these jobs.
CREATE TABLE IF NOT EXISTS hx_document_jobs (
 id TEXT PRIMARY KEY,
 org_id TEXT NOT NULL,
 gateway_id TEXT NOT NULL,
 created_by TEXT NOT NULL,
 request_id TEXT NOT NULL,
 scope TEXT NOT NULL,
 path TEXT NOT NULL,
 payload TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 created_at INTEGER NOT NULL,
 finished_at INTEGER,
 file_id TEXT,
 file_version INTEGER,
 lease_hash TEXT,
 lease_until INTEGER,
 deadline INTEGER,
 UNIQUE(org_id,created_by,request_id)
);
CREATE INDEX IF NOT EXISTS hx_document_jobs_queue ON hx_document_jobs(gateway_id,status,created_at);

CREATE TABLE IF NOT EXISTS hx_document_nodes (gateway_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,last_seen_at INTEGER NOT NULL);
