from pathlib import Path
import hashlib, json, sys, urllib.request
root = Path(__file__).resolve().parents[1]
baseline = json.loads((root / "tests/client-baseline.json").read_text())
package = baseline["packages"][sys.argv[1]]
destination = Path(sys.argv[2]); destination.mkdir(parents=True, exist_ok=True)
target = destination / package["file"]
if not target.exists():
    with urllib.request.urlopen(package["url"], timeout=120) as response:
        target.write_bytes(response.read())
if hashlib.sha256(target.read_bytes()).hexdigest() != package["sha256"]:
    raise SystemExit("Pinned client package checksum mismatch")
print("Verified client baseline " + baseline["version"] + " / " + sys.argv[1])
