#!/usr/bin/env python3
"""Synthetic local SQLite query comparison, never contacts D1/production."""
import json, re, sqlite3, statistics, subprocess, time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=(root/'src/channels.js').read_text()
sql=re.search(r'db.prepare\(`(WITH replies AS (?:MATERIALIZED )?\(.*?)`\)',source,re.S).group(1).replace('${marks}','?2').replace('${requested}','(?2)').replace('${people}','?3')
old="SELECT parent_id, author_login, kind, created_at FROM channel_messages WHERE org_id=?1 AND deleted_at IS NULL AND parent_id IN (?2) ORDER BY created_at"
output={'scope':'synthetic local SQLite; not Cloudflare D1 or production latency','sqlite':sqlite3.sqlite_version,'cases':[]}
for count in [10,1000,10000]:
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
 db.executescript('CREATE TABLE channel_messages(id TEXT PRIMARY KEY,org_id TEXT,channel TEXT,parent_id TEXT,author_login TEXT,kind TEXT,created_at TEXT,deleted_at TEXT); CREATE INDEX idx_channel_messages_parent ON channel_messages(org_id,parent_id);')
 db.execute("INSERT INTO channel_messages VALUES('parent','org','b:room',NULL,'alice','message','0',NULL)")
 db.executemany("INSERT INTO channel_messages VALUES(?,'org','b:room','parent',?,'message',?,NULL)",[(f'r{i}',f'user{i%7}',f'{i:09}') for i in range(count)])
 entry={'replies':count}
 for name,query,args in [('before',old,('org','parent')),('after',sql,('org','parent',None))]:
  timings=[];cpu=[]
  for i in range(12):
   start=time.perf_counter();cpu_start=time.process_time();rows=[dict(r) for r in db.execute(query,args)];elapsed=(time.perf_counter()-start)*1000
   if i>=2:timings.append(elapsed);cpu.append((time.process_time()-cpu_start)*1000)
  entry[name]={'returnedRows':len(rows),'returnedBytes':len(json.dumps(rows,separators=(',',':'))),'p50Ms':statistics.median(timings),'p95Ms':sorted(timings)[-1],'queryFetchCpuP50Ms':statistics.median(cpu),'queryFetchCpuP95Ms':sorted(cpu)[-1], 'queryPlan':[dict(r) for r in db.execute('EXPLAIN QUERY PLAN '+query,args)]}
  if name=='after': assert len(rows)==1 and rows[0]['reply_count']==count and len(json.loads(rows[0]['reply_logins']))==5
 output['cases'].append(entry)
print(json.dumps(output,indent=2))
