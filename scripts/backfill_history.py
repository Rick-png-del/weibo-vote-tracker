#!/usr/bin/env python3
"""Recover local observations, then explicitly mark interpolated gap snapshots."""
import csv
import json
from datetime import datetime, timedelta
from pathlib import Path
from fetch_votes import atomic_write

ROOT = Path(__file__).resolve().parents[1]

def stamp(snapshot):
    return datetime.fromisoformat(snapshot['timestamp'])

def backfill(history, rows):
    observations = [s for s in history['snapshots'] if not s.get('estimated')]
    observations.sort(key=stamp)
    gaps = [(stamp(a), stamp(b)) for a, b in zip(observations, observations[1:])
            if (stamp(b)-stamp(a)).total_seconds() > 75*60]
    recovered = 0
    for row in rows:
        time = datetime.fromisoformat(row['collected_at'])
        if not any(a < time < b for a,b in gaps):
            continue
        observations.append({'timestamp':row['collected_at'],
            'votes':[int(row[i]) if row.get(i) else None for i in history['candidate_order']],
            'voters':[None]*len(history['candidate_order']), 'source':'local_csv'})
        recovered += 1
    observations = sorted({s['timestamp']:s for s in observations}.values(), key=stamp)
    result = []
    intervals = []
    for a,b in zip(observations, observations[1:]):
        result.append(a)
        span = (stamp(b)-stamp(a)).total_seconds()
        if span <= 75*60:
            continue
        t = stamp(a)+timedelta(minutes=30)
        count = 0
        while t < stamp(b):
            ratio = (t-stamp(a)).total_seconds()/span
            snapshot = {'timestamp':t.isoformat(timespec='seconds'), 'estimated':True,
                        'source':'linear_interpolation', 'bounds':[a['timestamp'], b['timestamp']]}
            for field in ('votes','voters'):
                snapshot[field] = [round(x+(y-x)*ratio) if x is not None and y is not None else None
                                   for x,y in zip(a[field],b[field])]
            result.append(snapshot)
            count += 1
            t += timedelta(minutes=30)
        intervals.append({'from':a['timestamp'],'to':b['timestamp'],'estimated_count':count})
    result.append(observations[-1])
    history['snapshots'] = result
    history['backfill'] = {'method':'linear_interpolation','interval_minutes':30,
                          'gaps':intervals,'note':'估算值不代表实际历史投票，真实采集值保持不变。'}
    return recovered, sum(i['estimated_count'] for i in intervals)

if __name__ == '__main__':
    path = ROOT/'docs/data/history.json'
    history = json.loads(path.read_text())
    backup = ROOT/'data/history_before_backfill.json'
    if not backup.exists():
        atomic_write(backup,history)
    with (ROOT/'data/vote_history.csv').open(encoding='utf-8-sig') as handle:
        rows = list(csv.DictReader(handle))
    recovered, estimated = backfill(history,rows)
    atomic_write(path,history)
    print(json.dumps({'recovered':recovered,'estimated':estimated,'snapshots':len(history['snapshots'])}))
