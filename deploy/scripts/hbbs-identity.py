#!/usr/bin/env python3
"""Encrypt hbbs identity backups; restore only to an empty, new Docker volume."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import uuid

PREP_IMAGE = "ghcr.io/zhanry/home-tunnel-frps:0.70.1-r4@sha256:69dd1e9a05dbef35f44436db77f88e266a2772d57a86f889ffbd982ca7798ddb"
KEYS = ("id_ed25519", "id_ed25519.pub")


def identity(files):
    private = base64.b64decode(files[KEYS[0]].strip(), validate=True)
    public_text = files[KEYS[1]].strip()
    public = base64.b64decode(public_text, validate=True)
    if len(private) != 64 or len(public) != 32 or private[32:] != public:
        raise ValueError("Malformed or mismatched hbbs identity")
    return hashlib.sha256(public_text).hexdigest()


def archive(files):
    fingerprint = identity(files)
    contents = dict(files)
    contents["manifest.json"] = (json.dumps({"format": 1, "public_key_sha256": fingerprint,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}) + "\n").encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as bundle:
        for name, data in contents.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o600
            bundle.addfile(member, io.BytesIO(data))
    return stream.getvalue()


def verify(data):
    if len(data) > 16384:
        raise ValueError("Oversized identity archive")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
        members = bundle.getmembers()
        if len(members) != 3 or {m.name for m in members} != {*KEYS, "manifest.json"}:
            raise ValueError("Unexpected identity archive contents")
        if any(not m.isfile() or not 0 < m.size <= 4096 for m in members):
            raise ValueError("Unsafe identity archive member")
        contents = {m.name: bundle.extractfile(m).read() for m in members}
    manifest = json.loads(contents.pop("manifest.json"))
    if manifest.get("format") != 1 or manifest.get("files") != {
        name: hashlib.sha256(value).hexdigest() for name, value in contents.items()
    } or manifest.get("public_key_sha256") != identity(contents):
        raise ValueError("Identity archive verification failed")
    return contents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "verify", "restore"))
    parser.add_argument("--file", type=Path, required=True, help="Encrypted .gpg archive")
    parser.add_argument("--passphrase-file", type=Path, required=True)
    parser.add_argument("--container", help="Running hbbs container name or ID (backup)")
    parser.add_argument("--volume", help="New target Compose hbbs-data volume (restore)")
    args = parser.parse_args()
    if os.name == "posix":
        os.umask(0o077)
    secret = args.passphrase_file
    if secret.is_symlink() or not secret.is_file() or not secret.read_bytes().strip():
        parser.error("Passphrase must be a nonempty regular file")
    if os.name == "posix" and secret.stat().st_mode & 0o077:
        parser.error("Passphrase file must be private (chmod 600)")
    gpg = ["gpg", "--batch", "--quiet", "--pinentry-mode", "loopback", "--passphrase-file", str(secret)]
    if args.operation == "backup":
        if not args.container or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.container):
            parser.error("Specify a valid hbbs --container")
        if args.file.exists() or args.file.is_symlink():
            parser.error("Backup destination already exists")
        with tempfile.TemporaryDirectory(prefix="hbbs-identity-") as temporary:
            directory = Path(temporary)
            for name in KEYS:
                subprocess.run(["docker", "cp", f"{args.container}:/root/{name}", str(directory / name)], check=True,
                               stdout=subprocess.DEVNULL)
            files = {name: (directory / name).read_bytes() for name in KEYS}
            sealed = subprocess.run(gpg + ["--symmetric", "--cipher-algo", "AES256", "--compress-algo", "none"],
                                    input=archive(files), check=True, capture_output=True).stdout
            opened = subprocess.run(gpg + ["--decrypt"], input=sealed, check=True, capture_output=True).stdout
            if verify(opened) != files:
                raise ValueError("Encrypted identity round trip failed")
            with args.file.open("xb") as output:
                output.write(sealed)
        print("Encrypted hbbs identity backup verified; public-key SHA-256: " + identity(files))
        return
    if args.file.is_symlink() or not args.file.is_file() or args.file.stat().st_size > 32768:
        parser.error("Specify a regular encrypted identity archive")
    decrypted = subprocess.run(gpg + ["--decrypt", str(args.file)], check=True, capture_output=True).stdout
    files = verify(decrypted)
    if args.operation == "verify":
        print("Verified encrypted identity; public-key SHA-256: " + identity(files))
        return
    if not args.volume or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{2,127}", args.volume):
        parser.error("Specify a valid new --volume")
    existing = subprocess.check_output(["docker", "volume", "ls", "--format", "{{.Name}}"], text=True).splitlines()
    if args.volume in existing:
        parser.error("Target volume already exists; existing identities are never overwritten")
    nonce = uuid.uuid4().hex
    subprocess.run(["docker", "volume", "create", "--label", "homedesk.restore=" + nonce, args.volume], check=True,
                   stdout=subprocess.DEVNULL)
    record = json.loads(subprocess.check_output(["docker", "volume", "inspect", args.volume]))[0]
    if (record.get("Labels") or {}).get("homedesk.restore") != nonce:
        raise SystemExit("Target volume ownership changed")
    subprocess.run(["docker", "run", "--rm", "-i", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
                    "--security-opt", "no-new-privileges", "--entrypoint", "/bin/sh", "-v", args.volume + ":/target",
                    PREP_IMAGE, "-ec", 'test -z "$(ls -A /target)"; tar xz -C /target; chmod 700 /target; '
                    'chmod 600 /target/id_ed25519 /target/id_ed25519.pub; rm /target/manifest.json'],
                   input=archive(files), check=True)
    print("Restored identity into new volume. Review Compose project and HBBS public key before starting hbbs.")


if __name__ == "__main__":
    main()
