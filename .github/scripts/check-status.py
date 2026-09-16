"""Record external observations, not inferred uptime between scheduled checks."""
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request

origin = os.environ['STATUS_ORIGIN'].rstrip('/')
now = datetime.datetime.now(datetime.timezone.utc)
checks = []
for name, path in [('website', '/'), ('api', '/api/v1/ready')]:
    start = time.monotonic()
    healthy = False
    try:
        request = urllib.request.Request(origin + path, headers={'User-Agent': 'NoteColab-status/1.0'})
        with urllib.request.urlopen(request, timeout=15) as response:
            healthy = response.status == 200
            if name == 'api':
                healthy = healthy and json.load(response).get('status') == 'ok'
    except Exception:
        pass
    checks.append({'service': name, 'ok': healthy, 'durationMs': round((time.monotonic() - start) * 1000)})

history = []
fetch = subprocess.run(['git', 'fetch', 'origin', 'status'], capture_output=True)
if fetch.returncode == 0:
    previous = subprocess.run(['git', 'show', 'FETCH_HEAD:history.json'], capture_output=True, text=True, check=True)
    history = json.loads(previous.stdout)['observations']
cutoff = (now - datetime.timedelta(days=30)).isoformat()
history = [entry for entry in history if entry['at'] >= cutoff]
history.append({'at': now.isoformat(), 'checks': checks})
with open(sys.argv[1], 'w') as output:
    json.dump({'schemaVersion': 1, 'intervalMinutes': 10, 'updatedAt': now.isoformat(),
               'notice': 'Successful scheduled checks, not continuous monitoring or an uptime guarantee. Missing checks are unknown.',
               'observations': history}, output, indent=2)
    output.write('\n')
