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
assert compat["stage"] in ("internal-testing", "public-release")
for directory in ("linux-client", "windows-agent", "android-client"):
    assert not (root / directory).exists(), f"Legacy component directory: {directory}"

if component == "server":
    version = json.loads((root / "control-center/package.json").read_text())["version"]
    assert json.loads((root / "traffic-gateway/package.json").read_text())["version"] == version
    assert f'APP_VERSION = "{version}"' in (root / "control-center/src/version.ts").read_text()
    for name in (".env.example", "deploy/scripts/new-selfhost-config.sh", "deploy/scripts/new-selfhost-config.ps1"):
        defaults = re.findall(r"^HOME_TUNNEL_VERSION=([^\r\n]+)$", (root / name).read_text(), re.M)
        assert defaults == [version], f"Deployment version differs from service packages: {name}"
    compose_defaults = re.findall(r"\$\{HOME_TUNNEL_VERSION:-([^}]+)\}", (root / "compose.yaml").read_text())
    assert compose_defaults == [version, version], "Root Compose must select the current control and gateway versions"
    local_images = re.findall(r"image: home-tunnel/(?:control-center|traffic-gateway):([^\s]+)", (root / "deploy/compose.yaml").read_text())
    assert local_images == [version + "-arm64", version + "-arm64"], "Local ARM64 deployment version drift"
    assert compat["version"] == version, "compatibility.json version differs from service packages"
    target = compat.get("target_combination", compat["tested_combination"])
    assert target.get("server") == version, "Target server version must name the current source"
    for combination in (target, compat["tested_combination"]):
        assert set(combination) == {"server", "client", "android", "agent"}, "Incomplete component combination"
        assert all(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[1-9][0-9]*)?", value) for value in combination.values()), "Invalid component version"
    if target != compat["tested_combination"]:
        assert compat.get("tested_combination_scope"), "Historical test versions require an explicit scope; target versions are not proof of testing"
    status = compat.get("contract_status")
    assert status in ("proposed", "frozen"), "Unknown contract status"
    assert compat.get("frozen_tag") == (compat["contract_ref"] if status == "frozen" else None), "frozen_tag must match a frozen contract_ref"
    for name in ("contracts/openapi.v1.json", "control-center/public/openapi.json"):
        openapi = json.loads((root / name).read_text(encoding="utf-8"))
        assert openapi.get("x-contract-ref") == compat["contract_ref"], f"Contract ref drift: {name}"
        assert openapi.get("x-contract-status") == status, f"Contract status drift: {name}"
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
# A flow sequence such as [/tmp:size=8m,noexec] splits at each comma into separate
# mounts, which Docker rejects at start. Mount options need a quoted block item.
for compose in sorted(root.glob("**/compose*.y*ml")):
    if "node_modules" in compose.parts:
        continue
    for number, line in enumerate(compose.read_text(encoding="utf-8").splitlines(), 1):
        assert not re.search(r"^\s*tmpfs:\s*\[[^\]]*,", line), f"Quote tmpfs mount options as a block item: {compose.relative_to(root)}:{number}"
print(f"{component}: repository boundaries, local versions and API v1 fixture verified")
