import {env} from 'cloudflare:test';
import {test,expect} from 'vitest';
import migration from '../migrations.sql?raw';
import source from '../workspace-files.sql?raw';

const statements=migration.split('\n').filter(line=>/^CREATE .*\bhx_(workspace_file|file_account)/.test(line));
test('production file migration creates all tables and immutable history on an existing database and is replayable',async()=>{
 for(const table of ['hx_workspace_file_origins','hx_workspace_file_purges','hx_workspace_file_search','hx_workspace_file_versions','hx_workspace_file_uploads','hx_workspace_files','hx_file_account_erasures'])await env.DB.prepare(`DROP TABLE ${table}`).run();
 expect(statements).toHaveLength(12);
 for(let attempt=0;attempt<2;attempt++)for(const statement of statements)await env.DB.exec(statement);
 const objects=(await env.DB.prepare("SELECT name,type FROM sqlite_master WHERE name LIKE 'hx_workspace_file%' OR name LIKE 'hx_file_account%' ORDER BY name").all()).results;
 expect(objects.filter(row=>row.type==='table')).toHaveLength(7);
 expect(objects.some(row=>row.name==='hx_workspace_file_version_immutable'&&row.type==='trigger')).toBe(true);
 const normalize=sql=>sql.replace(/\s+/g,' ').replace(/\s*([(),;])\s*/g,'$1').trim();
 const normalized=normalize(source);
 for(const statement of statements){expect(normalized).toContain(normalize(statement))}
 const columns=(await env.DB.prepare('PRAGMA table_info(hx_workspace_files)').all()).results;
 expect(columns.map(row=>row.name)).toEqual(expect.arrayContaining(['created_login','scope','path','current_version']));
});
