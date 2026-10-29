#!/usr/bin/env python3
"""Synthetic in-memory SQLite SQL-row benchmark; never contacts production."""
import argparse
import hashlib
import json
import math
import platform
import re
import sqlite3
import statistics
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repetitions', type=int, default=15)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
assert args.repetitions > 0
repo = Path(__file__).resolve().parents[2]
source = (repo / 'worker/src/channels.js').read_text()
body = source.split('export async function listThread(', 1)[1].split('\n///', 1)[0]
sql = re.search(r'\.prepare\(\s*`([^`]+)`', body).group(1)
assert '${older}' in sql and 'LIMIT ?3' in sql

def query(paged):
    return (sql.replace('${older}', '')
            .replace('${page ? "DESC" : "ASC"}', 'DESC' if paged else 'ASC')
            .replace('${page ? "LIMIT ?3" : ""}', 'LIMIT ?3' if paged else ''))

legacy, bounded = query(False), query(True)
assert '${' not in legacy + bounded
schema = (repo / 'worker/schema.sql').read_text()

def stats(samples):
    ordered = sorted(samples)
    return {'p50_ms': statistics.median(samples), 'p95_ms': ordered[math.ceil(.95 * len(samples)) - 1], 'samples_ms': samples}

def measure(db, statement, params):
    for _ in range(3):
        db.execute(statement, params).fetchall()
    elapsed = []
    # VM instructions estimate SQL work, not billed D1 rows read. One callback
    # per instruction is deliberately measured outside latency sampling.
    instructions = [0]
    db.set_progress_handler(lambda: instructions.__setitem__(0, instructions[0] + 1) or 0, 1)
    rows = db.execute(statement, params).fetchall()
    db.set_progress_handler(None, 0)
    for _ in range(args.repetitions):
        start = time.perf_counter_ns()
        rows = db.execute(statement, params).fetchall()
        elapsed.append((time.perf_counter_ns() - start) / 1e6)
    return {'sql_rows': len(rows), 'sql_row_json_bytes': len(json.dumps([dict(row) for row in rows], separators=(',', ':')).encode()),
            'sqlite_vm_instructions': instructions[0], 'query_fetch': stats(elapsed),
            'plan': [dict(row) for row in db.execute('EXPLAIN QUERY PLAN ' + statement, params)]}

result = {'kind': 'synthetic local SQLite; SQL rows before hydration, not HTTP/network/rendering',
          'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
          'git_head': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
          'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version, 'platform': platform.platform(),
          'repetitions': args.repetitions, 'page_sql': bounded, 'legacy_sql': legacy, 'cases': []}
for count in (0, 1, 50, 1000, 10000):
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript(schema)
    now = '2026-10-01T00:00:00.000Z'
    rows = [(f'reply-{i:06}', 'fixture', 'b:test', 'reader', 'Synthetic body. ' * 32,
             f'2026-10-01T00:{i // 300:02}:{i // 5 % 60:02}.000Z', 'root', None) for i in range(count)]
    # Invisible rows exercise the soft-delete filter while keeping ties.
    rows += [(f'deleted-{i:06}', 'fixture', 'b:test', 'reader', '', now, 'root', now) for i in range(count // 20)]
    rows += [(f'other-{i:06}', f'org-{i % 5}', 'b:other', 'reader', '', now, f'other-{i % 200}', None) for i in range(10000)]
    db.executemany('INSERT INTO channel_messages(id,org_id,channel,author_login,body,created_at,parent_id,deleted_at) VALUES(?,?,?,?,?,?,?,?)', rows)
    db.execute('ANALYZE')
    current = measure(db, legacy, ('fixture', 'root'))
    page = measure(db, bounded, ('fixture', 'root', 51))
    assert current['sql_rows'] == count
    assert page['sql_rows'] == min(count, 51)
    assert all('TEMP B-TREE' not in row['detail'] for row in page['plan'])
    ids = [row['id'] for row in db.execute(legacy, ('fixture', 'root'))]
    newest = [row['id'] for row in db.execute(bounded, ('fixture', 'root', 51))][:50]
    assert newest == list(reversed(ids[-50:]))
    item = {'visible_replies': count, 'legacy': current, 'paged': page, 'presented_replies': min(count, 50)}
    result['cases'].append(item)
    print(json.dumps({'visible_replies': count, 'legacy_p50_ms': current['query_fetch']['p50_ms'], 'paged_p50_ms': page['query_fetch']['p50_ms'], 'legacy_rows': current['sql_rows'], 'paged_rows': page['sql_rows'], 'paged_vm_instructions': page['sqlite_vm_instructions']}), flush=True)
    db.close()
if args.output:
    args.output.write_text(json.dumps(result, indent=2) + '\n')
