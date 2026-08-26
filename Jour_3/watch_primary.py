import sys
import time
import datetime
from pymongo import MongoClient

hostport = sys.argv[1] if len(sys.argv) > 1 else "localhost:27018"
uri = f"mongodb://{hostport}/?directConnection=true&serverSelectionTimeoutMS=2000"

client = MongoClient(uri)
start = time.monotonic()
last_primary = "<inconnu>"

print(f"Observation via {hostport} ; t=0 = {datetime.datetime.now().isoformat()}", flush=True)

while True:
    try:
        hello = client.admin.command("hello")
        primary = hello.get("primary")
    except Exception as e:
        primary = None
    if primary != last_primary:
        elapsed = time.monotonic() - start
        ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        print(f"[{ts}] (+{elapsed:7.2f}s) primary = {primary}", flush=True)
        last_primary = primary
    time.sleep(0.3)
