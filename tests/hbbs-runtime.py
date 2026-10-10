"""Verify the locked hbbs-only process, private persistent identity and real sockets on Linux."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "ghcr.io/rustdesk/rustdesk-server:1.1.16@sha256:8ecdab65deb7c84652a626380e31d11a8f1fbafd97916d57f95c20628f943c00"
PREP = "ghcr.io/zhanry/home-tunnel-frps:0.70.1-r4@sha256:69dd1e9a05dbef35f44436db77f88e266a2772d57a86f889ffbd982ca7798ddb"


def run(*args):
    return subprocess.check_output(args, text=True, timeout=120).strip()


def main():
    name = "homedesk-hbbs-" + uuid.uuid4().hex[:12]
    volume = name + "-state"
    restored_volume = name + "-restored"
    restored_container = name + "-restored"
    report = {"image": IMAGE, "repository_revision": run("git", "rev-parse", "HEAD"),
              "scope": "isolated hbbs startup, sockets and persistent key; no media/NAT acceptance"}
    run("docker", "volume", "create", volume)
    try:
        run("docker", "run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
            "--entrypoint", "/bin/sh", "-v", volume + ":/state", PREP, "-ec", "chmod 700 /state; test $(stat -c %a /state) = 700")
        run("docker", "run", "--detach", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m",
            "--tmpfs", "/tmp:size=8m,noexec,nosuid,nodev", "-v", volume + ":/root", IMAGE, "hbbs", "-k", "_")
        with tempfile.TemporaryDirectory() as scratch:
            key = Path(scratch) / "public.key"
            deadline = time.monotonic() + 40
            while True:
                result = subprocess.run(["docker", "cp", name + ":/root/id_ed25519.pub", str(key)], capture_output=True)
                if result.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("hbbs failed to create its public identity")
                time.sleep(0.2)
            public = key.read_text().strip()
            assert len(base64.b64decode(public, validate=True)) == 32
            identity = hashlib.sha256(public.encode()).hexdigest()
            state = json.loads(run("docker", "inspect", name))[0]
            assert state["State"]["Running"] and not state["State"]["OOMKilled"]
            assert state["Config"]["Cmd"] == ["hbbs", "-k", "_"]
            pid = state["State"]["Pid"]
            deadline = time.monotonic() + 30
            while True:
                tcp = run("sudo", "cat", f"/proc/{pid}/net/tcp", f"/proc/{pid}/net/tcp6").splitlines()
                udp = run("sudo", "cat", f"/proc/{pid}/net/udp", f"/proc/{pid}/net/udp6").splitlines()
                tcp = [line for line in tcp if line.strip() and line.split()[0] != "sl"]
                udp = [line for line in udp if line.strip() and line.split()[0] != "sl"]
                listening = {int(line.split()[1].split(":")[1], 16) for line in tcp if line.split()[3] == "0A"}
                datagrams = {int(line.split()[1].split(":")[1], 16) for line in udp}
                if {21115, 21116} <= listening and 21116 in datagrams:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("hbbs failed to open its rendezvous sockets")
                time.sleep(0.2)
            assert {21115, 21116} <= listening and 21116 in datagrams
            assert not {21117, 21119} & listening, "Unexpected relay listener"
            run("docker", "restart", name)
            time.sleep(1)
            run("docker", "cp", name + ":/root/id_ed25519.pub", str(key))
            assert hashlib.sha256(key.read_text().strip().encode()).hexdigest() == identity
            passphrase = Path(scratch) / "passphrase"
            passphrase.write_text(uuid.uuid4().hex)
            passphrase.chmod(0o600)
            encrypted = Path(scratch) / "identity.gpg"
            helper = str(ROOT / "deploy/scripts/hbbs-identity.py")
            shared = ["--file", str(encrypted), "--passphrase-file", str(passphrase)]
            run(sys.executable, helper, "backup", "--container", name, *shared)
            run(sys.executable, helper, "verify", *shared)
            refused = subprocess.run([sys.executable, helper, "restore", "--volume", volume, *shared], capture_output=True)
            assert refused.returncode != 0, "Existing identity volume must never be overwritten"
            run(sys.executable, helper, "restore", "--volume", restored_volume, *shared)
            run("docker", "run", "--detach", "--name", restored_container, "--network", "none", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "64m",
                "-v", restored_volume + ":/root", IMAGE, "hbbs", "-k", "_")
            time.sleep(1)
            run("docker", "cp", restored_container + ":/root/id_ed25519.pub", str(key))
            assert hashlib.sha256(key.read_text().strip().encode()).hexdigest() == identity
            report.update(status="passed", public_key_sha256=identity, tcp_ports=sorted(listening), udp_ports=sorted(datagrams),
                          hbbr_running=False, state_directory_mode="0700", restart_identity="unchanged",
                          encrypted_identity_restore="same public key", overwrite_existing_identity="rejected")
    finally:
        subprocess.run(["docker", "rm", "--force", restored_container], capture_output=True)
        subprocess.run(["docker", "volume", "rm", restored_volume], capture_output=True)
        subprocess.run(["docker", "rm", "--force", name], capture_output=True)
        subprocess.run(["docker", "volume", "rm", volume], capture_output=True)
    output = ROOT / os.environ.get("HBBS_EVIDENCE_PATH", "outputs/hbbs-runtime.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
