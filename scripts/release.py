"""Build, verify and publish a component; preserve sealed engineering evidence in Releases."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import release_candidate

ROOT = Path(os.environ["HOME_TUNNEL_ROOT"]).resolve() if os.environ.get("HOME_TUNNEL_ROOT") else SCRIPTS.parent
os.chdir(ROOT)
PROJECT = json.loads((ROOT / "compatibility.json").read_text())
COMPONENT = PROJECT["component"]
REPO = os.environ["GITHUB_REPOSITORY"]
SHA = os.environ["GITHUB_SHA"]
TAG = os.environ["GITHUB_REF_NAME"]


def release_dir():
    override = os.environ.get("HOME_TUNNEL_RELEASE_DIR")
    return Path(override) if override else ROOT / "release"


def bound_path():
    path = os.environ.get("HOME_TUNNEL_BOUND_ORIGIN")
    if not path:
        raise SystemExit("HOME_TUNNEL_BOUND_ORIGIN is required")
    return Path(path)

def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None).stdout

def api(endpoint):
    return json.loads(run("gh", "api", endpoint, capture=True))

def local_version():
    if COMPONENT == "server":
        return json.loads((ROOT / "control-center/package.json").read_text())["version"]
    if COMPONENT == "client":
        return re.search(r'const Version = "([^"]+)"', (ROOT / "internal/model/model.go").read_text()).group(1)
    return re.search(r'^HOME_TUNNEL_VERSION_NAME=(.+)$', (ROOT / "gradle.properties").read_text(), re.M).group(1)

def validate_release_tag(tag, source_version, stage):
    if stage not in ("internal-testing", "public-release"):
        raise SystemExit("Unknown release stage; set compatibility.json explicitly")
    match = re.fullmatch(r"v(\d+\.\d+\.\d+)(?:-rc\.([1-9]\d*))?", tag)
    if not match:
        raise SystemExit("Release tags must be vX.Y.Z or vX.Y.Z-rc.N")
    version, candidate = match.groups()
    if tag.removeprefix("v") != source_version:
        raise SystemExit("Tag does not match this component's source version")
    if stage == "internal-testing" and candidate is None:
        raise SystemExit("Internal testing publishes prereleases only; use vX.Y.Z-rc.N")
    return version, candidate

def metadata():
    version, candidate = validate_release_tag(TAG, local_version(), PROJECT.get("stage"))
    release_candidate.refuse_stable_server_rebuild(COMPONENT, candidate)
    run("python3", "scripts/check-repository.py")
    run("git", "fetch", "--tags", "origin", "main")
    run("git", "merge-base", "--is-ancestor", SHA, "origin/main")
    checks = api(f"repos/{REPO}/commits/{SHA}/check-runs?per_page=100")["check_runs"]
    gates = [c for c in checks if c["name"] == "Quality Gate" and c.get("app", {}).get("slug") == "github-actions"]
    if not gates or max(gates, key=lambda c:c["id"])["conclusion"] != "success":
        raise SystemExit("The tagged commit must first pass its component CI Quality Gate on main")
    security_runs = api(f"repos/{REPO}/actions/runs?head_sha={SHA}&per_page=100")["workflow_runs"]
    for workflow_name in ("CodeQL", "Secret scan"):
        matching = [r for r in security_runs if r["name"] == workflow_name and r["head_sha"] == SHA]
        if not matching or max(matching, key=lambda r:r["id"])["conclusion"] != "success":
            raise SystemExit(f"The tagged commit must pass {workflow_name} before release")
    rc_tag = TAG
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for key, value in {"version":TAG.removeprefix('v'),"base-version":version,
                           "stable":str(not candidate).lower(),"rc-version":rc_tag.removeprefix('v'),"rc-tag":rc_tag}.items():
            output.write(f"{key}={value}\n")

def required_assets(directory):
    version = local_version()
    if COMPONENT == "client":
        expected = [f"HomeTunnel-Setup-{version}-x64.exe", f"HomeTunnel-Windows-{version}-x64.zip"]
        expected += [f"home-tunnel-{platform}-{version}-{arch}.tar.gz" for platform in ("linux","macos") for arch in ("amd64","arm64")]
        expected += ["agent-provenance.json"]
    elif COMPONENT == "android":
        expected = [f"HomeTunnel-Android-{version}-arm64-v8a.apk", f"HomeTunnel-Android-{version}.aab", "android-release-evidence.json"]
    else:
        expected = ["image-control-center.json", "image-traffic-gateway.json", "home-tunnel.v1.json", "openapi.v1.json", "api.schema.json",
                    "remote-desktop.v1.json", "remote-authorization-vectors.json", "REMOTE_PROTOCOL.md"]
        for name in ("control-center", "traffic-gateway"):
            record = json.loads((directory / f"image-{name}.json").read_text())
            if record["revision"] != SHA or not re.fullmatch(r"sha256:[a-f0-9]{64}", record["digest"]):
                raise SystemExit("Invalid server image identity")
    for name in expected:
        if not (directory/name).is_file() or not (directory/name).stat().st_size:
            raise SystemExit(f"Missing release asset: {name}")

def image_records(directory):
    records = {}
    for name in ("control-center", "traffic-gateway"):
        path = directory / f"image-{name}.json"
        if not path.is_file():
            raise SystemExit(f"Missing candidate image record: {name}")
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("name") != name or record.get("revision") != SHA or not re.fullmatch(r"sha256:[a-f0-9]{64}", record.get("digest", "")):
            raise SystemExit("Invalid server image identity")
        records[name] = record
    return records

def assert_candidate_bound(directory):
    if COMPONENT != "server":
        return {}
    records = image_records(directory)
    manifest_path = directory / "release-manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("Candidate manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("revision") != SHA or manifest.get("component") != COMPONENT or manifest.get("repository") != REPO:
        raise SystemExit("Candidate manifest is not bound to this source SHA")
    compose = (directory / "compose.release.yaml").read_text(encoding="utf-8")
    for name, record in records.items():
        pinned = manifest.get("images", {}).get(name, {})
        if pinned.get("digest") != record["digest"] or pinned.get("revision") != SHA or pinned.get("image") != record["image"]:
            raise SystemExit(f"Candidate manifest digest mismatch: {name}")
        if f"{record['image']}@{record['digest']}" not in compose:
            raise SystemExit(f"Deployment file is not pinned to {name}")
    return records

def evidence_dir(directory):
    for candidate in (directory, directory.parent / "evidence"):
        if (candidate / "stun-runtime-amd64.json").is_file():
            return candidate
    return directory

def assert_candidate_evidence(directory):
    if COMPONENT != "server":
        return
    directory = evidence_dir(directory)
    records = image_records(ROOT / "release" if not (directory / "image-control-center.json").is_file() else directory)
    for arch in ("amd64", "arm64"):
        stun_path = directory / f"stun-runtime-{arch}.json"
        smoke_path = directory / f"server-smoke-{arch}.json"
        if not stun_path.is_file() or not smoke_path.is_file():
            raise SystemExit(f"Candidate is missing {arch} acceptance evidence")
        stun = json.loads(stun_path.read_text(encoding="utf-8"))
        smoke = json.loads(smoke_path.read_text(encoding="utf-8"))
        if stun.get("status") != "passed" or stun.get("repository_revision") != SHA:
            raise SystemExit(f"Candidate STUN evidence does not match this source for {arch}")
        if smoke.get("status") != "passed" or records["control-center"]["digest"] not in smoke.get("control_image", "") or records["traffic-gateway"]["digest"] not in smoke.get("gateway_image", ""):
            raise SystemExit(f"Candidate smoke evidence does not match image digests for {arch}")

def require_acceptance(directory):
    records = assert_candidate_bound(directory)
    path = directory / "server-acceptance.json"
    if not path.is_file():
        raise SystemExit("Stable publication requires a real acceptance record for this candidate")
    acceptance = json.loads(path.read_text(encoding="utf-8"))
    deployment = {}
    for name in ("compose.release.yaml", f"home-tunnel-server-{local_version()}.tar.gz"):
        target = directory / name
        if target.is_file():
            deployment[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    release_candidate.require(release_candidate.acceptance_errors(
        acceptance,
        source_sha=SHA,
        version=local_version(),
        repository=REPO,
        images={name: {"image": record["image"], "digest": record["digest"], "revision": record["revision"]} for name, record in records.items()},
        deployment_hashes=deployment,
        run_id=os.environ.get("CANDIDATE_RUN_ID", ""),
    ))
    return acceptance

def signing_identity(rc_tag):
    stable = re.fullmatch(r"v\d+\.\d+\.\d+", rc_tag) is not None
    workflow = os.environ.get("HOME_TUNNEL_RELEASE_WORKFLOW", "release.yml")
    if workflow == "release.yml":
        return f"https://github.com/{REPO}/.github/workflows/release.yml@refs/tags/{rc_tag}"
    if workflow == "publish-stable.yml" and stable:
        ref = os.environ.get("HOME_TUNNEL_RELEASE_REF", "")
        if not ref.startswith("refs/heads/"):
            raise SystemExit("Stable acceptance workflow identity is invalid")
        return f"https://github.com/{REPO}/.github/workflows/publish-stable.yml@{ref}"
    raise SystemExit("Unknown release workflow identity")

def seal():
    directory = release_dir()
    required_assets(directory)
    manifest={"component":COMPONENT,"version":local_version(),"repository":REPO,"revision":SHA,"api_major":1,"rc_tag":TAG}
    if os.environ.get("HOME_TUNNEL_CANDIDATE") == "1":
        manifest.update({
            "rc_tag": "",
            "channel": "candidate",
            "release_contract": release_candidate.RELEASE_CONTRACT,
            "caller_workflow": release_candidate.APPROVED_CANDIDATE_CALLER,
            "signer_workflow": release_candidate.APPROVED_CANDIDATE_SIGNER,
            "run_id": os.environ["GITHUB_RUN_ID"],
            "event_name": os.environ.get("GITHUB_EVENT_NAME", ""),
            "ref": os.environ.get("GITHUB_REF", ""),
        })
    if COMPONENT == 'server':
        records = image_records(directory)
        manifest["images"] = {name: {"image": record["image"], "digest": record["digest"], "revision": record["revision"]} for name, record in records.items()}
        lines = ['services:']
        for name, record in records.items():
            lines += [f"  {name}:", f"    image: {record['image']}@{record['digest']}"]
        (directory/'compose.release.yaml').write_text('\n'.join(lines)+'\n')
    (directory/'release-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    if COMPONENT == 'server':
        import tarfile
        archive = directory/f'home-tunnel-server-{local_version()}.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for entry in ['compose.yaml', '.env.example', 'README.md', 'README.en.md', 'LICENSE', 'compatibility.json', 'control-center/package.json', 'control-center/migrations', 'deploy', 'docs', 'contracts']:
                bundle.add(ROOT/entry, arcname=entry, filter=lambda item: None if '__pycache__' in item.name or item.name.endswith('.pyc') or item.name.startswith(('deploy/turn/', 'deploy/stun/')) or item.name in ('deploy/compose.rd.yaml', 'deploy/compose.turn.yaml', 'deploy/compose.stun.yaml', 'deploy/compose.rd-keyset.yaml') else item)
            bundle.add(directory/'compose.release.yaml',arcname='compose.release.yaml')
    lines=[]
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.name not in ('SHA256SUMS.txt','SHA256SUMS.txt.sigstore.json','server-acceptance.json'):
            lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
    (directory/'SHA256SUMS.txt').write_text(''.join(lines), encoding='utf-8')

def verify(directory, rc_tag):
    identity = signing_identity(rc_tag)
    run("cosign","verify-blob","--bundle",str(directory/'SHA256SUMS.txt.sigstore.json'),
        "--certificate-identity",identity,"--certificate-oidc-issuer","https://token.actions.githubusercontent.com",str(directory/'SHA256SUMS.txt'))
    listed = set()
    for line in (directory/'SHA256SUMS.txt').read_text().splitlines():
        checksum, name = line.split('  ',1)
        if Path(name).name != name or not re.fullmatch(r'[a-f0-9]{64}',checksum):
            raise SystemExit('Invalid checksum manifest path or hash')
        if hashlib.sha256((directory/name).read_bytes()).hexdigest() != checksum:
            raise SystemExit(f'Checksum mismatch: {name}')
        listed.add(name)
    actual={p.name for p in directory.iterdir() if p.is_file()}-{'SHA256SUMS.txt','SHA256SUMS.txt.sigstore.json','server-acceptance.json'}
    if actual != listed:
        raise SystemExit('Unsealed or missing release assets')
    manifest=json.loads((directory/'release-manifest.json').read_text())
    for key,value in {'repository':REPO,'revision':SHA,'version':local_version(),'component':COMPONENT,'rc_tag':rc_tag}.items():
        if manifest.get(key)!=value: raise SystemExit(f'Release manifest mismatch: {key}')
    required_assets(directory)
    assert_candidate_bound(directory)
    return identity

def public_asset_names(component, version):
    if component == "android":
        return [f"HomeTunnel-Android-{version}-arm64-v8a.apk"]
    if component == "client":
        return [f"HomeTunnel-Setup-{version}-x64.exe", f"HomeTunnel-Windows-{version}-x64.zip"] + [
            f"home-tunnel-{platform}-{version}-{arch}.tar.gz"
            for platform in ("linux", "macos") for arch in ("amd64", "arm64")]
    return [f"home-tunnel-server-{version}.tar.gz", "compose.release.yaml"]

def publish(stable=False):
    directory=release_dir()
    stable = re.fullmatch(r"v\d+\.\d+\.\d+", TAG) is not None
    if stable:
        require_acceptance(directory)
        assert_candidate_evidence(directory)
    identity=verify(directory,TAG)
    if COMPONENT == 'server':
        evidence = evidence_dir(directory)
        for arch in ('amd64', 'arm64'):
            report = json.loads((evidence / f'stun-runtime-{arch}.json').read_text())
            if report.get('status') != 'passed' or report.get('repository_revision') != SHA:
                raise SystemExit('The exact tagged STUN deployment must pass its isolated runtime check')
    if COMPONENT=='server' and stable:
        for name in ('control-center','traffic-gateway'):
            record=json.loads((directory/f'image-{name}.json').read_text())
            reference=f"{record['image']}@{record['digest']}"
            run('cosign','verify',reference,'--certificate-identity',identity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com',capture=True)
    import shutil
    public = ROOT/'release-public'
    public.mkdir(exist_ok=True)
    # Publish the exact sealed set, including SBOMs, scan results and signatures.
    # Keeping the signed checksum manifest unchanged makes evidence independently verifiable.
    selected=sorted(path.name for path in directory.iterdir() if path.is_file() and path.name != "server-acceptance.json")
    missing=set(public_asset_names(COMPONENT,local_version()))-set(selected)
    if missing: raise SystemExit(f'Missing public deliverables: {missing}')
    for name in selected:
        shutil.copyfile(directory/name,public/name)
    packages=public_asset_names(COMPONENT,local_version())
    downloads='\n'.join(f'- [{name}](https://github.com/{REPO}/releases/download/{TAG}/{name})' for name in packages)
    checksums=''.join(f"{hashlib.sha256((public/name).read_bytes()).hexdigest()}  {name}\n" for name in packages)
    title=f'Home Tunnel {COMPONENT} {local_version()}'
    notes=ROOT/'release-notes.md'
    summary=(ROOT/'docs/RELEASE_NOTES.md').read_text(encoding='utf-8')
    run_url=f"https://github.com/{REPO}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    notes.write_text(summary + "\n\n## Downloads\n\n" + downloads + "\n\n```text\n" + checksums + "```\n" + f"\n\nSource: `{SHA}`. [Build, verification and signing evidence]({run_url}).\n\n" +
        "Packages and durable verification evidence are covered by SHA256SUMS.txt and its Sigstore bundle.\n",encoding='utf-8')
    created=False
    try:
        run('gh','release','create',TAG,'--repo',REPO,'--verify-tag','--target',SHA,'--draft','--title',title,'--notes-file',str(notes))
        created=True
        run('gh','release','upload',TAG,'--repo',REPO,*[str(p) for p in sorted(public.iterdir()) if p.is_file()])
        flags=['--draft=false','--latest=true'] if stable else ['--draft=false','--prerelease','--latest=false']
        run('gh','release','edit',TAG,'--repo',REPO,*flags)
    except BaseException:
        if created:
            current=json.loads(run('gh','release','view',TAG,'--repo',REPO,'--json','isDraft',capture=True))
            if current['isDraft']: run('gh','release','delete',TAG,'--repo',REPO,'--yes')
        raise

def api_json(endpoint):
    result = subprocess.run(["gh", "api", endpoint], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0:
        return json.loads(result.stdout)
    combined = f"{result.stderr}\n{result.stdout}"
    if "404" in combined or "Not Found" in combined:
        return None
    raise SystemExit(f"GitHub metadata request failed: {endpoint}")


def download_artifact_zip(artifact_id):
    release_candidate.validate_run_id(str(artifact_id))
    result = subprocess.run(
        ["gh", "api", "--method", "GET", "-H", "Accept: application/vnd.github+json", f"repos/{REPO}/actions/artifacts/{artifact_id}/zip"],
        check=True,
        stdout=subprocess.PIPE,
    )
    return result.stdout


def verify_blob_signature(bundle, payload, identity):
    try:
        run(
            "cosign", "verify-blob", "--bundle", str(bundle),
            "--certificate-identity", identity,
            "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
            str(payload),
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit("candidate signature does not match the approved signer") from exc


def sha_is_on_main(sha):
    if re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise SystemExit("candidate SHA is invalid")
    run("git", "fetch", "--no-tags", "origin", "main")
    result = subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"])
    return result.returncode == 0


def load_release_files(directory):
    records = {}
    for name in ("control-center", "traffic-gateway"):
        records[name] = json.loads((directory / f"image-{name}.json").read_text(encoding="utf-8"))
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    compose = (directory / "compose.release.yaml").read_text(encoding="utf-8")
    return records, manifest, compose


def deployment_hashes(directory, version):
    hashes = {}
    for name in ("compose.release.yaml", f"home-tunnel-server-{version}.tar.gz"):
        path = directory / name
        if not path.is_file():
            raise SystemExit(f"Acceptance must bind {name}")
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def verify_publication_origin():
    run_id = release_candidate.validate_run_id(os.environ["CANDIDATE_RUN_ID"])
    if re.fullmatch(r"[0-9a-f]{40}", SHA) is None:
        raise SystemExit("publisher SHA is invalid")
    run_meta = api(f"repos/{REPO}/actions/runs/{run_id}")
    artifacts = api(f"repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100").get("artifacts") or []
    matches = [item for item in artifacts if item.get("name") == "candidate-assets" and item.get("expired") is not True]
    if len(matches) != 1:
        raise SystemExit("candidate artifact identity is missing")
    artifact = matches[0]
    zip_bytes = download_artifact_zip(artifact.get("id"))
    directory = release_dir()
    if directory.exists():
        import shutil
        shutil.rmtree(directory)
    release_candidate.safe_extract(zip_bytes, directory)
    records, manifest, compose = load_release_files(directory)
    login = release_candidate.actor_login(run_meta)
    try:
        permission_payload = api(f"repos/{REPO}/collaborators/{login}/permission")
    except subprocess.CalledProcessError as exc:
        raise SystemExit("workflow caller is not an approved maintainer") from exc
    permission = permission_payload.get("permission") if isinstance(permission_payload, dict) else ""
    release_candidate.require(release_candidate.origin_errors(
        run=run_meta,
        artifact=artifact,
        zip_bytes=zip_bytes,
        manifest=manifest,
        signature_identity=release_candidate.candidate_signer_identity(REPO, str(run_meta.get("head_branch") or "")),
        repository=REPO,
        run_id=run_id,
        permission=permission,
    ))
    candidate_sha = release_candidate.trusted_sha(run_meta, manifest)
    release_candidate.require(release_candidate.image_binding_errors(records, manifest, compose, candidate_sha, REPO))
    identity = release_candidate.candidate_signer_identity(REPO, str(run_meta.get("head_branch") or ""))
    verify_blob_signature(directory / "SHA256SUMS.txt.sigstore.json", directory / "SHA256SUMS.txt", identity)
    release_candidate.verify_artifact_files(directory)
    for name in ("control-center", "traffic-gateway"):
        reference = f"{records[name]['image']}@{records[name]['digest']}"
        try:
            run(
                "cosign", "verify", reference,
                "--certificate-identity", identity,
                "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
                capture=True,
            )
        except subprocess.CalledProcessError as exc:
            raise SystemExit("candidate signature does not match the approved signer") from exc
    bound = {
        "release_contract": release_candidate.RELEASE_CONTRACT,
        "candidate_sha": candidate_sha,
        "candidate_run_id": run_id,
        "repository": REPO,
        "signer_identity": identity,
        "head_branch": run_meta.get("head_branch"),
        "artifact_digest": artifact.get("digest"),
        "seal": release_candidate.seal_snapshot(directory),
        "version": manifest.get("version"),
        "origin_verified": True,
    }
    path = bound_path()
    path.write_text(json.dumps(bound, indent=2) + "\n", encoding="utf-8")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"candidate_sha={candidate_sha}\n")


def print_bound_sha():
    bound = json.loads(bound_path().read_text(encoding="utf-8"))
    sha = str(bound.get("candidate_sha", ""))
    if re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise SystemExit("candidate SHA is invalid")
    print(sha)


def assert_release_contract():
    publisher = Path(release_candidate.__file__).read_text(encoding="utf-8")
    candidate = (ROOT / "scripts" / "release_candidate.py").read_text(encoding="utf-8")
    release_candidate.assert_same_contract(publisher, candidate)
    sha = json.loads(bound_path().read_text(encoding="utf-8"))["candidate_sha"]
    head = subprocess.run(["git", "rev-parse", "HEAD"], check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
    if head != sha:
        raise SystemExit("checked out source does not match the candidate SHA")


def acceptance_context(bound):
    directory = release_dir()
    records, _manifest, _compose = load_release_files(directory)
    version = local_version()
    if version != bound.get("version"):
        raise SystemExit("checked out source version does not match the sealed candidate")
    images = {name: {"image": record["image"], "digest": record["digest"], "revision": record["revision"]} for name, record in records.items()}
    return version, images, deployment_hashes(directory, version)


def prepare_acceptance():
    bound = json.loads(bound_path().read_text(encoding="utf-8"))
    if bound.get("origin_verified") is not True or bound.get("release_contract") != release_candidate.RELEASE_CONTRACT:
        raise SystemExit("candidate origin is not verified")
    directory = release_dir()
    release_candidate.assert_seal_preserved(directory, bound["seal"])
    version, images, hashes = acceptance_context(bound)
    acceptance_text = os.environ["ACCEPTANCE_JSON"]
    acceptance = json.loads(acceptance_text)
    release_candidate.require(release_candidate.acceptance_errors(
        acceptance,
        source_sha=bound["candidate_sha"],
        version=version,
        repository=REPO,
        images=images,
        deployment_hashes=hashes,
        run_id=bound["candidate_run_id"],
    ))
    acceptance_dir = Path(os.environ["HOME_TUNNEL_ACCEPTANCE_DIR"])
    release_candidate.write_acceptance_bundle(acceptance_dir, acceptance_text, acceptance)
    identity = release_candidate.publish_signer_identity(REPO, os.environ["HOME_TUNNEL_RELEASE_REF"])
    sums = acceptance_dir / "server-acceptance.SHA256SUMS.txt"
    bundle = acceptance_dir / "server-acceptance.SHA256SUMS.txt.sigstore.json"
    run("cosign", "sign-blob", "--yes", "--bundle", str(bundle), str(sums))
    release_candidate.assert_seal_preserved(directory, bound["seal"])
    bound["acceptance_prepared"] = True
    bound["publish_identity"] = identity
    bound_path().write_text(json.dumps(bound, indent=2) + "\n", encoding="utf-8")


def publish_accepted():
    bound = json.loads(bound_path().read_text(encoding="utf-8"))
    if bound.get("acceptance_prepared") is not True:
        raise SystemExit("acceptance evidence is not sealed")
    directory = release_dir()
    release_candidate.assert_seal_preserved(directory, bound["seal"])
    version, images, hashes = acceptance_context(bound)
    acceptance_dir = Path(os.environ["HOME_TUNNEL_ACCEPTANCE_DIR"])
    acceptance = json.loads((acceptance_dir / "server-acceptance.json").read_text(encoding="utf-8"))
    errors = release_candidate.acceptance_errors(
        acceptance,
        source_sha=bound["candidate_sha"],
        version=version,
        repository=REPO,
        images=images,
        deployment_hashes=hashes,
        run_id=bound["candidate_run_id"],
    )
    tag = "v" + version
    existing = api_json(f"repos/{REPO}/git/ref/tags/{tag}") if re.fullmatch(r"v\d+\.\d+\.\d+", tag) else {"ref": tag}
    assets = []
    if existing:
        release_payload = api_json(f"repos/{REPO}/releases/tags/{tag}") or {}
        assets = [item.get("name") for item in release_payload.get("assets") or [] if item.get("name")]
    facts = {
        "rebuilt": False,
        "origin_verified": bound.get("origin_verified") is True,
        "acceptance_errors": errors,
        "original_seal_changed": False,
        "version": version,
        "contract_status": PROJECT.get("contract_status"),
        "contract_ref": PROJECT.get("contract_ref"),
        "on_main": sha_is_on_main(bound["candidate_sha"]),
        "tag_exists": existing is not None,
        "assets_exist": bool(assets),
        "event": os.environ.get("GITHUB_EVENT_NAME", ""),
    }
    release_candidate.require(release_candidate.promotion_blockers(facts))
    release_candidate.assert_tag_unpublished(existing)
    release_candidate.assert_assets_unpublished(assets)
    identity = release_candidate.publish_signer_identity(REPO, os.environ.get("HOME_TUNNEL_RELEASE_REF", ""))
    if identity != bound.get("publish_identity"):
        raise SystemExit("acceptance signature identity does not match the approved publisher")
    verify_blob_signature(
        acceptance_dir / "server-acceptance.SHA256SUMS.txt.sigstore.json",
        acceptance_dir / "server-acceptance.SHA256SUMS.txt",
        identity,
    )
    release_candidate.assert_seal_preserved(directory, bound["seal"])
    created_tag = False
    created_release = False
    try:
        run(
            "gh", "api", "--method", "POST", f"repos/{REPO}/git/refs",
            "-f", f"ref=refs/tags/{release_candidate.publication_tag(version)}",
            "-f", f"sha={bound['candidate_sha']}",
        )
        created_tag = True
        notes = ROOT / "release-notes.md"
        packages = public_asset_names(COMPONENT, version)
        downloads = "\n".join(f"- [{name}](https://github.com/{REPO}/releases/download/{tag}/{name})" for name in packages)
        checksums = "".join(
            f"{hashlib.sha256((directory / name).read_bytes()).hexdigest()}  {name}\n" for name in packages
        )
        summary = (ROOT / "docs/RELEASE_NOTES.md").read_text(encoding="utf-8")
        run_url = f"https://github.com/{REPO}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
        # List unverified coverage without altering the sealed acceptance records.
        waivers = release_candidate.waiver_notes(acceptance)
        notes.write_text(
            summary + ("\n\n" + waivers.rstrip("\n") if waivers else "")
            + "\n\n## Downloads\n\n" + downloads + "\n\n```text\n" + checksums + "```\n"
            + f"\n\nSource: `{bound['candidate_sha']}`. Candidate run `{bound['candidate_run_id']}`.\n\n"
            + "Original package bytes remain covered by SHA256SUMS.txt and its candidate Sigstore bundle. "
            + "server-acceptance.SHA256SUMS.txt is a separate acceptance seal.\n"
            + f"\n[Publication checks]({run_url}).\n",
            encoding="utf-8",
        )
        title = f"Home Tunnel {COMPONENT} {version}"
        run("gh", "release", "create", tag, "--repo", REPO, "--verify-tag", "--target", bound["candidate_sha"], "--draft", "--title", title, "--notes-file", str(notes))
        created_release = True
        upload = [str(path) for path in sorted(directory.iterdir()) if path.is_file()]
        upload += [str(path) for path in sorted(acceptance_dir.rglob("*")) if path.is_file()]
        names = [Path(item).name for item in upload]
        if len(names) != len(set(names)):
            raise SystemExit("acceptance filenames collide with candidate artifacts")
        run("gh", "release", "upload", tag, "--repo", REPO, *upload)
        run("gh", "release", "edit", tag, "--repo", REPO, "--draft=false", "--latest=true")
    except BaseException:
        if created_release:
            current = json.loads(run("gh", "release", "view", tag, "--repo", REPO, "--json", "isDraft", capture=True))
            if current["isDraft"]:
                run("gh", "release", "delete", tag, "--repo", REPO, "--yes")
        if created_tag:
            subprocess.run(["gh", "api", "--method", "DELETE", f"repos/{REPO}/git/refs/tags/{tag}"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        raise


def candidate_preflight():
    release_candidate.validate_candidate_request(os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("GITHUB_REF", ""), SHA, local_version())
    runs = []
    for page in (1, 2, 3):
        payload = api(f"repos/{REPO}/actions/runs?head_sha={SHA}&per_page=100&page={page}")
        batch = payload.get("workflow_runs") or []
        runs.extend(batch)
        if len(batch) < 100:
            break
    release_candidate.require(release_candidate.security_gate_errors(runs, SHA, REPO))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"version={local_version()}\n")


if __name__=='__main__':
    action=sys.argv[1]
    if action=='metadata': metadata()
    elif action=='seal': seal()
    elif action=='seal-candidate':
        os.environ["HOME_TUNNEL_CANDIDATE"] = "1"
        seal()
        assert_candidate_evidence(release_dir())
    elif action=='candidate-preflight': candidate_preflight()
    elif action=='verify-candidate':
        assert_candidate_bound(release_dir())
        assert_candidate_evidence(release_dir())
    elif action=='verify-publication-origin': verify_publication_origin()
    elif action=='print-bound-sha': print_bound_sha()
    elif action=='assert-release-contract': assert_release_contract()
    elif action=='prepare-acceptance': prepare_acceptance()
    elif action=='publish-accepted': publish_accepted()
    elif action=='rc': publish()
    elif action=='stable': publish(stable=True)
    elif action=='publish': publish()
    else: raise SystemExit('Unknown release action')
