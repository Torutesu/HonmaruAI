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
CREATE INDEX IF NOT EXISTS hx_document_jobs_history ON hx_document_jobs(org_id,created_by,scope,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS hx_document_nodes (gateway_id TEXT PRIMARY KEY,org_id TEXT NOT NULL,last_seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hx_document_export_artifacts (org_id TEXT NOT NULL,job_id TEXT NOT NULL,object_key TEXT NOT NULL,content_hash TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>=0),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(org_id,job_id));
CREATE INDEX IF NOT EXISTS idx_hx_document_export_artifacts_expiry ON hx_document_export_artifacts(org_id,expires_at,job_id);
CREATE TABLE IF NOT EXISTS hx_document_export_links (org_id TEXT NOT NULL,token_hash TEXT NOT NULL,job_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(org_id,token_hash));
CREATE INDEX IF NOT EXISTS idx_hx_document_export_links_expiry ON hx_document_export_links(org_id,expires_at,job_id);
