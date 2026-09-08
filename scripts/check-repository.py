"""Offline checks for component ownership, versioning and the vendored protocol."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

root = Path(__file__).resolve().parents[1]
compat = json.loads((root / "compatibility.json").read_text(encoding="utf-8"))
component = compat["component"]
assert compat["api_major"] == 1
for directory in ("linux-client", "windows-agent", "android-client"):
    assert not (root / directory).exists(), f"Legacy component directory: {directory}"

if component == "server":
    version = json.loads((root / "control-center/package.json").read_text())["version"]
    assert json.loads((root / "traffic-gateway/package.json").read_text())["version"] == version
    assert f'APP_VERSION = "{version}"' in (root / "control-center/src/version.ts").read_text()
    assert not (root / "control-center/browser-tests/desktop.spec.mjs").exists()
    assert not (root / "go.mod").exists()
else:
    lock = json.loads((root / "contracts/lock.json").read_text())
    fixture = root / lock["path"]
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == lock["sha256"], "Protocol fixture drift"
    assert lock["repository"] == "ZHanry/home-tunnel-server"
    assert re.fullmatch(r"api-v\d+\.\d+\.\d+", lock["ref"]), "Protocol source must use a versioned ref"
    if component == "client":
        assert (root / "go.mod").read_text().startswith("module github.com/ZHanry/home-tunnel-client\n")
        assert (root / "agent/go.mod").exists(), "The FRP source must be isolated from the GUI/CLI module"
        assert (root / "internal/app/app.go").exists()
        assert (root / "tests/browser/desktop.spec.mjs").exists()
    elif component == "android":
        build = (root / "app/build.gradle.kts").read_text()
        assert 'applicationId = "io.github.zhanry.hometunnel"' in build
        assert (root / "release-signing-cert.sha256").read_text().strip() == "d7779e338be1039acee6dda9a43417cbf2baf4b0c9995578d9708501e95af702"
        wrapper = root / "gradle/wrapper/gradle-wrapper.jar"
        assert hashlib.sha256(wrapper.read_bytes()).hexdigest() == "498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17"

files = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
for name in filter(None, files):
    path = root / name
    if path.suffix not in (".go", ".mjs", ".ps1", ".sh", ".yml", ".yaml") or not path.is_file():
        continue
    text = path.read_text(encoding="utf-8")
    if path.name == "check-repository.py":
        continue
    assert "github.com/ZHanry/home-tunnel/linux-client" not in text, f"Old Go module import in {name}"
    if ".github/workflows/" in name or name.startswith("packaging/"):
        assert not re.search(r"(?:linux-client|windows-agent|android-client)[/\\]", text), f"Sibling source dependency in {name}"
print(f"{component}: repository boundaries, local versions and API v1 fixture verified")
