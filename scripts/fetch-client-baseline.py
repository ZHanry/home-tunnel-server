from pathlib import Path
import hashlib, json, os, re, subprocess, sys, tarfile, tempfile, urllib.request
root = Path(__file__).resolve().parents[1]
baseline = json.loads((root / "tests/client-baseline.json").read_text())
destination = Path(sys.argv[2]); destination.mkdir(parents=True, exist_ok=True)
if baseline.get("source_build"):
    arch = sys.argv[1]
    revision = baseline["revision"]
    repository = baseline["repository"]
    if arch not in ("amd64", "arm64") or repository != "ZHanry/home-tunnel-client" or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise SystemExit("Invalid pinned current-source Agent identity")
    target = destination / f'home-tunnel-linux-{baseline["version"]}-{arch}.tar.gz'
    with tempfile.TemporaryDirectory(prefix="nestlink-agent-source-") as scratch:
        checkout = Path(scratch) / "source"
        subprocess.run(["git", "clone", "--no-checkout", "--filter=blob:none", "--depth=1", f"https://github.com/{repository}.git", str(checkout)], check=True)
        subprocess.run(["git", "fetch", "--depth=1", "origin", revision], cwd=checkout, check=True)
        subprocess.run(["git", "checkout", "--detach", revision], cwd=checkout, check=True)
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
        source_version = json.loads((checkout / "compatibility.json").read_text())["version"]
        if actual != revision or source_version != baseline["version"]:
            raise SystemExit("Pinned Agent source/version mismatch")
        agent = Path(scratch) / "home-tunnel-agent"
        env = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": arch, "GOTOOLCHAIN": "local"}
        subprocess.run(["go", "build", "-mod=readonly", "-trimpath", "-ldflags", "-s -w", "-o", str(agent), "."], cwd=checkout / "agent", env=env, check=True)
        with tarfile.open(target, "w:gz") as archive:
            archive.add(agent, arcname="lib/home-tunnel-agent")
        evidence = {"repository": repository, "revision": revision, "version": source_version, "architecture": arch,
                    "agent_sha256": hashlib.sha256(agent.read_bytes()).hexdigest(),
                    "package_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "go_version": subprocess.check_output(["go", "version"], text=True).strip()}
        (destination / f"client-baseline-{arch}.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print("Built pinned current-source Agent " + revision + " / " + arch)
    raise SystemExit(0)
package = baseline["packages"][sys.argv[1]]
target = destination / package["file"]
if not target.exists():
    with urllib.request.urlopen(package["url"], timeout=120) as response:
        target.write_bytes(response.read())
if hashlib.sha256(target.read_bytes()).hexdigest() != package["sha256"]:
    raise SystemExit("Pinned client package checksum mismatch")
print("Verified client baseline " + baseline["version"] + " / " + sys.argv[1])
