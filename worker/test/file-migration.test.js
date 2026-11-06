import {env} from 'cloudflare:test';
import {test,expect} from 'vitest';
import migration from '../migrations.sql?raw';
import source from '../workspace-files.sql?raw';

const statements=migration.split('\n').filter(line=>/^CREATE .*\bhx_(workspace_file|file_account)/.test(line));
test('production file migration creates all tables and immutable history on an existing database and is replayable',async()=>{
 for(const trigger of ['hx_workspace_file_share_events_linked','hx_workspace_file_share_events_purge'])await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
 for(const table of ['hx_workspace_file_share_events','hx_workspace_file_share_requests','hx_workspace_file_share_items','hx_workspace_file_share_revisions','hx_workspace_file_shares','hx_workspace_file_public_urls','hx_workspace_file_origins','hx_workspace_file_purges','hx_workspace_file_versions','hx_workspace_file_uploads','hx_workspace_files','hx_file_account_erasures'])await env.DB.prepare(`DROP TABLE ${table}`).run();
 expect(statements).toHaveLength(25);
 for(let attempt=0;attempt<2;attempt++)for(const statement of statements)await env.DB.exec(statement);
 const objects=(await env.DB.prepare("SELECT name,type FROM sqlite_master WHERE name LIKE 'hx_workspace_file%' OR name LIKE 'hx_file_account%' ORDER BY name").all()).results;
 expect(objects.filter(row=>row.type==='table')).toHaveLength(12);
 expect(objects.some(row=>row.name==='hx_workspace_file_version_immutable'&&row.type==='trigger')).toBe(true);
 expect(objects.some(row=>row.name==='hx_workspace_file_share_revision_immutable'&&row.type==='trigger')).toBe(true);
 expect(objects.some(row=>row.name==='hx_workspace_file_share_events_purge'&&row.type==='trigger')).toBe(true);
 const normalized=source.replace(/\s+/g,'').toLowerCase();
 for(const statement of statements){expect(normalized).toContain(statement.replace(/\s+/g,'').toLowerCase())}
 const columns=(await env.DB.prepare('PRAGMA table_info(hx_workspace_files)').all()).results;
 expect(columns.map(row=>row.name)).toEqual(expect.arrayContaining(['created_login','scope','path','current_version']));
 const insertEvent=(id,shareId)=>env.DB.prepare(`INSERT INTO hx_workspace_file_share_events(org_id,id,share_id,event,details_json,created_at) VALUES('team:events',?1,?2,'published','{}','2026-11-05T00:00:00.000Z')`).bind(id,shareId).run();
 await expect(insertEvent('event-null',null)).rejects.toThrow('File share events require a live share');
 await expect(insertEvent('event-orphan','missing-share')).rejects.toThrow('File share events require a live share');
});
