"""Component release gates: build RC assets once, then promote the verified bytes."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
PROJECT = json.loads((ROOT / "compatibility.json").read_text())
COMPONENT = PROJECT["component"]
REPO = os.environ["GITHUB_REPOSITORY"]
SHA = os.environ["GITHUB_SHA"]
TAG = os.environ["GITHUB_REF_NAME"]

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
    match = re.fullmatch(r"v(\d+\.\d+\.\d+)(?:-rc\.(\d+))?", tag)
    if not match:
        raise SystemExit("Release tags must be vX.Y.Z or vX.Y.Z-rc.N")
    version, candidate = match.groups()
    if version != source_version:
        raise SystemExit("Tag does not match this component's source version")
    if stage == "internal-testing" and candidate is None:
        raise SystemExit("Internal testing publishes prereleases only; use vX.Y.Z-rc.N")
    return version, candidate

def metadata():
    version, candidate = validate_release_tag(TAG, local_version(), PROJECT.get("stage"))
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
    if not candidate:
        released = []
        for tag in run("git", "tag", "--list", f"v{version}-rc.*", capture=True).splitlines():
            if not re.fullmatch(re.escape(f"v{version}-rc.") + r"\d+", tag):
                continue
            revision = run("git", "rev-parse", tag + "^{commit}", capture=True).strip()
            if revision != SHA:
                continue
            found = subprocess.run(["gh", "release", "view", tag, "--repo", REPO, "--json", "isPrerelease,isDraft"], text=True, capture_output=True)
            if found.returncode == 0:
                release = json.loads(found.stdout)
                if release["isPrerelease"] and not release["isDraft"]:
                    released.append(tag)
        if not released:
            raise SystemExit("Stable must promote an already published RC from the identical commit")
        rc_tag = max(released, key=lambda t:int(t.rsplit('.',1)[1]))
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
        expected = ["image-control-center.json", "image-traffic-gateway.json", "home-tunnel.v1.json"]
        for name in ("control-center", "traffic-gateway"):
            record = json.loads((directory / f"image-{name}.json").read_text())
            if record["revision"] != SHA or not re.fullmatch(r"sha256:[a-f0-9]{64}", record["digest"]):
                raise SystemExit("Invalid server image identity")
    for name in expected:
        if not (directory/name).is_file() or not (directory/name).stat().st_size:
            raise SystemExit(f"Missing release asset: {name}")

def seal():
    directory = ROOT / "release"
    required_assets(directory)
    manifest={"component":COMPONENT,"version":local_version(),"repository":REPO,"revision":SHA,"api_major":1,"rc_tag":TAG}
    (directory/'release-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    if COMPONENT == 'server':
        records = [json.loads((directory/f'image-{name}.json').read_text()) for name in ('control-center','traffic-gateway')]
        lines = ['services:']
        for record in records:
            lines += [f"  {record['name']}:", f"    image: {record['image']}@{record['digest']}"]
        (directory/'compose.release.yaml').write_text('\n'.join(lines)+'\n')
    lines=[]
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.name not in ('SHA256SUMS.txt','SHA256SUMS.txt.sigstore.json'):
            lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
    (directory/'SHA256SUMS.txt').write_text(''.join(lines), encoding='utf-8')

def verify(directory, rc_tag):
    identity = f"https://github.com/{REPO}/.github/workflows/release.yml@refs/tags/{rc_tag}"
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
    actual={p.name for p in directory.iterdir() if p.is_file()}-{'SHA256SUMS.txt','SHA256SUMS.txt.sigstore.json'}
    if actual != listed:
        raise SystemExit('Unsealed or missing release assets')
    manifest=json.loads((directory/'release-manifest.json').read_text())
    for key,value in {'repository':REPO,'revision':SHA,'version':local_version(),'component':COMPONENT,'rc_tag':rc_tag}.items():
        if manifest.get(key)!=value: raise SystemExit(f'Release manifest mismatch: {key}')
    required_assets(directory)
    return identity

def publish(stable=False):
    directory=ROOT/'release'
    if stable:
        directory.mkdir(exist_ok=True)
        rc_tag=os.environ['RC_TAG']
        run('gh','release','download',rc_tag,'--repo',REPO,'--dir',str(directory))
    else:
        rc_tag=TAG
    identity=verify(directory,rc_tag)
    if COMPONENT=='server' and stable:
        for name in ('control-center','traffic-gateway'):
            record=json.loads((directory/f'image-{name}.json').read_text())
            reference=f"{record['image']}@{record['digest']}"
            run('cosign','verify',reference,'--certificate-identity',identity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com',capture=True)
            run('docker','buildx','imagetools','create','--tag',f"{record['image']}:{local_version()}",reference)
    title=f'Home Tunnel {COMPONENT} {local_version()}' + ('' if stable else f' ({TAG.rsplit("-",1)[1]})')
    notes=ROOT/'release-notes.md'
    notes.write_text(f'{title}\n\nIndependent {COMPONENT} release. API v1 compatibility is recorded in compatibility.json.\n\nBuilt once from {SHA}; checksums, release manifest and signing evidence are attached. Stable promotes identical RC bytes.\n',encoding='utf-8')
    created=False
    try:
        run('gh','release','create',TAG,'--repo',REPO,'--verify-tag','--target',SHA,'--draft','--title',title,'--notes-file',str(notes))
        created=True
        run('gh','release','upload',TAG,'--repo',REPO,*[str(p) for p in sorted(directory.iterdir()) if p.is_file()])
        flags=['--draft=false','--latest=true'] if stable else ['--draft=false','--prerelease','--latest=false']
        run('gh','release','edit',TAG,'--repo',REPO,*flags)
    except BaseException:
        if created:
            current=json.loads(run('gh','release','view',TAG,'--repo',REPO,'--json','isDraft',capture=True))
            if current['isDraft']: run('gh','release','delete',TAG,'--repo',REPO,'--yes')
        raise

if __name__=='__main__':
    action=sys.argv[1]
    if action=='metadata': metadata()
    elif action=='seal': seal()
    elif action=='rc': publish()
    elif action=='stable': publish(stable=True)
    else: raise SystemExit('Unknown release action')
