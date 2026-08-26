import sys
import time
import datetime
from pymongo import MongoClient
from pymongo.errors import PyMongoError

if len(sys.argv) < 2:
    print("Usage: python writer.py <uri> [duree_secondes]")
    sys.exit(1)

uri = sys.argv[1]
duration = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0

client = MongoClient(uri, serverSelectionTimeoutMS=5000)
db = client.census

success = 0
failure = 0
i = 0
start = time.monotonic()

print(f"Demarrage writer.py, duree={duration}s, uri={uri}", flush=True)

while time.monotonic() - start < duration:
    i += 1
    ts = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
    t0 = time.monotonic()
    try:
        db.heartbeat.insert_one({"seq": i, "ts": datetime.datetime.utcnow()})
        dt = time.monotonic() - t0
        success += 1
        try:
            primary = client.primary
        except Exception:
            primary = None
        print(f"{ts} seq={i} OK   primary={primary} dt={dt:.3f}s", flush=True)
    except PyMongoError as e:
        dt = time.monotonic() - t0
        failure += 1
        try:
            primary = client.primary
        except Exception:
            primary = None
        print(f"{ts} seq={i} FAIL primary={primary} dt={dt:.3f}s error={type(e).__name__}: {e}", flush=True)
    time.sleep(1)

print(f"\nTotal: success={success} failure={failure} (attendues={i})", flush=True)
from pymongo import ReadPreference
real_count = None
for attempt in range(10):
    try:
        real_count = db.heartbeat.with_options(read_preference=ReadPreference.PRIMARY_PREFERRED).count_documents({})
        break
    except PyMongoError:
        time.sleep(1)
if real_count is not None:
    print(f"count_documents reel dans census.heartbeat: {real_count}", flush=True)
else:
    print("count_documents impossible apres 10 tentatives", flush=True)
