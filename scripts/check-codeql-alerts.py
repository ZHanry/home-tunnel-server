"""A successful analysis upload is not the same as having no open alerts."""
import json
import os
import subprocess
import time
from urllib.parse import quote

repo=os.environ['GITHUB_REPOSITORY']
ref=os.environ['GITHUB_REF']
endpoint=f'repos/{repo}/code-scanning/alerts?state=open&ref={quote(ref,safe="")}&per_page=100'
alerts=[]
for attempt in range(12):
    result=subprocess.run(['gh','api','--paginate','--slurp',endpoint],check=True,capture_output=True,text=True)
    alerts=[alert for page in json.loads(result.stdout) for alert in page]
    if not alerts:
        print('No open CodeQL alerts for '+ref)
        break
    # Other categories in a matrix can still be completing their uploads.
    if attempt<11: time.sleep(5)
else:
    for alert in alerts:
        location=alert['most_recent_instance']['location']
        print(f'Open CodeQL alert #{alert["number"]}: {alert["rule"]["id"]} at {location["path"]}:{location["start_line"]}')
    raise SystemExit('Resolve or explicitly triage the findings before this security check can pass')
