import {env} from 'cloudflare:test';
import {test,expect} from 'vitest';
import schema from '../schema.sql?raw';
import migrations from '../migrations.sql?raw';
import {markRead} from '../src/channels.js';

test('deploying read revisions preserves existing positions and starts the next mutation at one',async()=>{
 await env.DB.exec('DROP TABLE channel_reads');
 await env.DB.exec('CREATE TABLE channel_reads(org_id TEXT NOT NULL,login TEXT NOT NULL,channel TEXT NOT NULL,last_read_at TEXT NOT NULL,PRIMARY KEY(org_id,login,channel))');
 const at='2020-01-01T00:00:00.000Z';
 await env.DB.prepare('INSERT INTO channel_reads VALUES(?,?,?,?)').bind('legacy','person','b:room',at).run();
 await env.DB.exec(schema.replace(/\n/g,' '));
 for(const statement of migrations.split('\n').filter(line=>/^(ALTER TABLE|CREATE )/.test(line))){
  try{await env.DB.exec(statement)}catch(error){if(!/duplicate column name/i.test(String(error)))throw error}
 }
 expect(await env.DB.prepare('SELECT last_read_at,read_version FROM channel_reads').first()).toEqual({last_read_at:at,read_version:0});
 expect(await markRead(env.DB,'legacy','person','b:room',at,true)).toEqual({lastReadAt:at,readVersion:1});
});
