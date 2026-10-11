"""Retag two accepted/public14 application manifests, with no build or deploy.

Default mode is review. Designed only for a reviewed, isolated GitHub Actions
maintenance branch; it never obtains a local gh credential or writes auth files.
The registry has no compare-and-swap or two-tag atomic transaction. Partial
failure is retained as unknown/partial and never triggers an automatic rollback.
"""
from __future__ import annotations
import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'ZHanry/home-tunnel-server'
PAYLOAD = '299753a4c6580ac6bbc748cdee743489a3e17dba'
RELEASE = 'fa765744ce56076fcde364f1f11749cfe77a744a'
ORIGINAL_RUN = 38053932107
RELEASE_RUN = 38113333163
ORIGINAL_ARTIFACT_ID = 11670264094
ORIGINAL_ZIP_SHA = 'ba2b0ec646233160beaf1d54778b0eaf915a7dbe0c737b6fc2ae4a4b0a69972c'
ACCEPTANCE_SHA = '1f5f1eb8c842b2a5434749d27b9b21d59133a6ff36bebe19b7e7bd162161cb95'
DEPLOYMENT_NAME = 'NestLink-Server-14.0.0.tar.gz'
DEPLOYMENT_SHA = '1a42bc2e9520c9d4d7c641af6bc3fff42bd9833880423b767485779f4e8812a7'
MATERIALS_NAME = 'NestLink-server-Materials-14.0.0.zip'
MATERIALS_SHA = 'fe10b6bb580197338e430cebcdcbad70e1bdae3d295ce45dce8bc09c9ead3ac4'
IMAGES = {
    'control-center': {'image': 'ghcr.io/zhanry/home-tunnel-control-center', 'digest': 'sha256:b6e43b72494cca541c023b366e27504a46ac1acea0ec4c504adb4f15a6b0cb46', 'revision': PAYLOAD},
    'traffic-gateway': {'image': 'ghcr.io/zhanry/home-tunnel-traffic-gateway', 'digest': 'sha256:8c07824ea38e5cf2297ad0ff80711c90f688b1a82f7fe9dc62d406a9328515cb', 'revision': PAYLOAD},
}
MEDIA_TYPES = (
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
)
DOCS = {'docs/release/acceptance-14.0.0.json', 'docs/HOMEDESK_RELEASE.md', 'docs/RELEASE_NOTES.md'}
MAINTENANCE_FILES = {'.github/workflows/server-candidate.yml', 'scripts/retag-server-latest14.py'}
IMAGE_SIGNER = 'https://github.com/ZHanry/home-tunnel-server/.github/workflows/server-candidate.yml@refs/heads/main'
RELEASE_SIGNER = 'https://github.com/ZHanry/home-tunnel-server/.github/workflows/release.yml@refs/tags/v14.0.0'
ISSUER = 'https://token.actions.githubusercontent.com'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def unique_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'Duplicate JSON field refused')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


class NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(not req.has_header('Authorization'), 'Authenticated redirect refused')
        parsed = urllib.parse.urlparse(newurl)
        require(parsed.scheme == 'https' and not parsed.username and not parsed.password
                and (parsed.hostname == 'github.com' or (parsed.hostname or '').endswith('.githubusercontent.com')),
                'Public artifact redirect host refused')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Evidence:
    def __init__(self, path):
        self.path = path.resolve()
        require(not self.path.exists(), 'Use a fresh evidence directory; retain failed attempts')
        self.path.mkdir(parents=True)

    def raw(self, name, data):
        target = self.path / name
        require(target.parent == self.path and not target.exists(), 'Evidence name already exists or escaped its root')
        with target.open('xb') as stream:
            stream.write(data)
        return {'path': name, 'sha256': checksum(data), 'size_bytes': len(data)}

    def json(self, name, value):
        return self.raw(name, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf8'))


class HTTP:
    def __init__(self, token, evidence):
        self.token, self.evidence = token, evidence
        self.opener = urllib.request.build_opener(NoAuthRedirect())

    def api(self, path, evidence_name):
        require(path.startswith('repos/' + REPOSITORY + '/'), 'API repository scope refused')
        request = urllib.request.Request('https://api.github.com/' + path, headers={
            'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NestLink14-manifest-retag',
        })
        with self.opener.open(request, timeout=45) as response:
            require(response.status == 200, 'GitHub metadata request failed')
            raw = response.read(8 * 1024 * 1024 + 1)
        require(len(raw) <= 8 * 1024 * 1024, 'GitHub metadata size bound exceeded')
        self.evidence.raw(evidence_name, raw)
        return unique_json(raw)

    def public_asset(self, url, size_limit, name):
        prefix = 'https://github.com/' + REPOSITORY + '/releases/download/v14.0.0/'
        require(url.startswith(prefix) and '/' not in url[len(prefix):], 'Formal public download URL refused')
        request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'NestLink14-manifest-retag'})
        with self.opener.open(request, timeout=60) as response:
            require(response.status == 200, 'Public attachment request failed')
            raw = response.read(size_limit + 1)
        require(len(raw) <= size_limit, 'Public attachment size bound exceeded')
        self.evidence.raw(name, raw)
        return raw


class Registry:
    def __init__(self, token, actor, mode):
        self.token, self.actor, self.mode = token, actor, mode
        self.opener = urllib.request.build_opener(NoAuthRedirect())
        self.authorizations = {}

    def bearer(self, repository):
        require(repository in {item['image'].removeprefix('ghcr.io/') for item in IMAGES.values()}, 'Registry repository refused')
        if repository not in self.authorizations:
            scope = 'pull,push' if self.mode == 'apply' else 'pull'
            query = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + repository + ':' + scope})
            basic = base64.b64encode((self.actor + ':' + self.token).encode()).decode()
            request = urllib.request.Request('https://ghcr.io/token?' + query, headers={'Authorization': 'Basic ' + basic})
            with self.opener.open(request, timeout=30) as response:
                require(response.status == 200, 'Registry scoped token request failed')
                raw = response.read(128 * 1024 + 1)
            require(len(raw) <= 128 * 1024, 'Registry token size bound exceeded')
            authorization = unique_json(raw).get('token')
            require(isinstance(authorization, str) and authorization, 'Scoped registry token missing')
            self.authorizations[repository] = authorization
        return self.authorizations[repository]

    def manifest(self, repository, reference, missing=False):
        require(reference in {'14.0.0', 'latest'} or re.fullmatch(r'sha256:[a-f0-9]{64}', reference), 'Manifest reference refused')
        authorization = self.bearer(repository)
        request = urllib.request.Request('https://ghcr.io/v2/' + repository + '/manifests/' + reference, headers={
            'Authorization': 'Bearer ' + authorization, 'Accept': ', '.join(MEDIA_TYPES), 'Accept-Encoding': 'identity',
        })
        try:
            with self.opener.open(request, timeout=30) as response:
                require(response.status == 200, 'Manifest read failed')
                raw = response.read(8 * 1024 * 1024 + 1)
                content_type = response.headers.get('Content-Type', '').split(';', 1)[0]
                digest = response.headers.get('Docker-Content-Digest')
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return {'raw': None, 'digest': None, 'content_type': None}
            raise
        require(len(raw) <= 8 * 1024 * 1024 and raw, 'Registry manifest size bound exceeded')
        require(content_type in MEDIA_TYPES and digest == 'sha256:' + checksum(raw), 'Manifest content type or raw-byte digest mismatch')
        unique_json(raw)
        return {'raw': raw, 'digest': digest, 'content_type': content_type}

    def put_latest(self, repository, accepted):
        require(self.mode == 'apply', 'Review mode cannot write registry tags')
        require(repository in {item['image'].removeprefix('ghcr.io/') for item in IMAGES.values()}, 'PUT repository refused')
        expected = {item['image'].removeprefix('ghcr.io/'): item['digest'] for item in IMAGES.values()}
        require(accepted['digest'] == expected[repository], 'PUT repository-specific digest refused')
        require(accepted['digest'] == 'sha256:' + checksum(accepted['raw']), 'PUT original manifest bytes changed')
        request = urllib.request.Request('https://ghcr.io/v2/' + repository + '/manifests/latest', data=accepted['raw'], method='PUT', headers={
            'Authorization': 'Bearer ' + self.bearer(repository), 'Content-Type': accepted['content_type'],
        })
        # No retry: a failure after a committed write has an unknown outcome.
        with self.opener.open(request, timeout=30) as response:
            require(response.status == 201 and response.headers.get('Docker-Content-Digest') == accepted['digest'],
                    'PUT response did not confirm the accepted digest')
            return {'status': response.status, 'docker_content_digest': response.headers.get('Docker-Content-Digest')}


def git(checkout, *args):
    result = subprocess.run(['git', '-C', str(checkout), *args], capture_output=True, check=False)
    require(result.returncode == 0, 'Source Git validation failed')
    return result.stdout


def validate_sources(args, evidence):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Only isolated Actions dispatch is allowed')
    require(os.environ.get('GITHUB_WORKFLOW') == 'Retag accepted NestLink 14 application latest only'
            and os.environ.get('GITHUB_WORKFLOW_REF', '').startswith(REPOSITORY + '/.github/workflows/server-candidate.yml@refs/heads/maintenance/retag-latest14-'),
            'Only the reviewed direct retag workflow may execute this helper')
    require(os.environ.get('GITHUB_REF', '').startswith('refs/heads/maintenance/retag-latest14-'), 'Isolated maintenance branch required')
    require(re.fullmatch(r'[a-f0-9]{40}', args.expected_head or '') and os.environ.get('GITHUB_SHA') == args.expected_head,
            'Reviewed maintenance commit does not match this dispatch')
    checkout = args.checkout.resolve()
    require(Path(__file__).resolve() == checkout/'scripts/retag-server-latest14.py', 'Execute only the reviewed maintenance checkout script')
    require(git(checkout, 'rev-parse', 'HEAD').decode().strip() == args.expected_head, 'Checkout HEAD differs from reviewed maintenance commit')
    require(not git(checkout, 'status', '--porcelain').strip(), 'Maintenance checkout must be clean before evidence creation')
    git(checkout, 'merge-base', '--is-ancestor', RELEASE, args.expected_head)
    changes = set(git(checkout, 'diff', '--name-only', RELEASE, args.expected_head).decode().splitlines())
    require(changes == MAINTENANCE_FILES, 'Maintenance commit may change only this script and retag-only workflow')
    require(git(checkout, 'rev-parse', 'v14.0.0^{commit}').decode().strip() == RELEASE, 'Local formal tag differs')
    git(checkout, 'merge-base', '--is-ancestor', PAYLOAD, RELEASE)
    require(set(git(checkout, 'diff', '--name-only', PAYLOAD, RELEASE).decode().splitlines()) == DOCS, 'Accepted payload to formal source drift must be exactly the three release documents')
    acceptance_raw = git(checkout, 'show', RELEASE + ':docs/release/acceptance-14.0.0.json')
    require(checksum(acceptance_raw) == ACCEPTANCE_SHA, 'Frozen formal acceptance bytes differ')
    acceptance = unique_json(acceptance_raw)
    require(acceptance.get('version') == '14.0.0' and acceptance.get('component') == 'server'
            and acceptance.get('status') == 'passed_reproducible' and acceptance.get('source_revision') == PAYLOAD
            and acceptance.get('build_run') == ORIGINAL_RUN and acceptance.get('build_attempt') == 1
            and acceptance.get('images') == IMAGES and acceptance.get('deliverables') == {DEPLOYMENT_NAME: DEPLOYMENT_SHA},
            'Formal acceptance source/build/images/deployment binding differs')
    evidence.raw('acceptance-original.json', acceptance_raw)
    for name, path in [('execution-source.py', Path(__file__).resolve()), ('execution-workflow.yml', checkout/'.github/workflows/server-candidate.yml')]:
        evidence.raw(name, path.read_bytes())
    python_path = Path(sys.executable).resolve()
    version = subprocess.run([str(python_path), '--version'], capture_output=True, check=False)
    require(version.returncode == 0, 'Actual Python version readback failed')
    evidence.json('execution-tools-before.json', {'sealed_at': now(), 'command_argv': [sys.executable, *sys.argv],
                  'source_sha256': checksum(Path(__file__).read_bytes()),
                  'workflow_sha256': checksum((checkout/'.github/workflows/server-candidate.yml').read_bytes()),
                  'python_path': str(python_path), 'python_sha256': checksum(python_path.read_bytes()),
                  'python_version': (version.stdout + version.stderr).decode('utf8', 'replace').strip(),
                  'cosign_path': str(args.cosign.resolve()), 'cosign_sha256': checksum(args.cosign.resolve().read_bytes())})
    return acceptance


def cosign(args, evidence, name, arguments):
    executable = args.cosign.resolve()
    require(executable.is_file(), 'Cosign executable required')
    env = os.environ.copy()
    for key in ('GITHUB_TOKEN', 'GH_TOKEN', 'REGISTRY_AUTH_FILE', 'DOCKER_CONFIG'):
        env.pop(key, None)
    command = [str(executable), *arguments]
    result = subprocess.run(command, capture_output=True, check=False, env=env, timeout=180)
    evidence.raw(name + '.stdout', result.stdout)
    evidence.raw(name + '.stderr', result.stderr)
    evidence.json(name + '.json', {'command_argv': command, 'exit_code': result.returncode,
                                 'cosign_sha256': checksum(executable.read_bytes()), 'verified_at': now()})
    require(result.returncode == 0, 'Required public Sigstore verification failed')


def verify_public(args, http, evidence, acceptance):
    repo = 'repos/' + REPOSITORY + '/'
    tag = http.api(repo + 'commits/v14.0.0', 'formal-tag-api.json')
    require(tag.get('sha') == RELEASE, 'Remote formal tag changed')
    comparison = http.api(repo + 'compare/' + PAYLOAD + '...' + RELEASE, 'formal-lineage-api.json')
    require(comparison.get('status') == 'ahead' and comparison.get('merge_base_commit', {}).get('sha') == PAYLOAD
            and {item.get('filename') for item in comparison.get('files', [])} == DOCS,
            'Remote formal tag is not the accepted source plus exact release docs')
    for run_id, source, path, event, branch, name in (
        (ORIGINAL_RUN, PAYLOAD, '.github/workflows/ci.yml', 'workflow_dispatch', 'main', 'original-ci-api.json'),
        (RELEASE_RUN, RELEASE, '.github/workflows/release.yml', 'push', 'v14.0.0', 'formal-release-run-api.json'),
    ):
        run = http.api(repo + 'actions/runs/' + str(run_id), name)
        require(run.get('id') == run_id and run.get('head_sha') == source and run.get('path') == path
                and run.get('event') == event and run.get('head_branch') == branch
                and run.get('run_attempt') == 1 and run.get('status') == 'completed' and run.get('conclusion') == 'success',
                'Original build or formal release run identity/result changed')
    artifact = http.api(repo + 'actions/artifacts/' + str(ORIGINAL_ARTIFACT_ID), 'original-ci-artifact-api.json')
    require(artifact.get('id') == ORIGINAL_ARTIFACT_ID and artifact.get('name') == 'candidate-assets'
            and artifact.get('digest') == 'sha256:' + ORIGINAL_ZIP_SHA and not artifact.get('expired')
            and artifact.get('workflow_run', {}).get('id') == ORIGINAL_RUN
            and artifact.get('workflow_run', {}).get('head_sha') == PAYLOAD, 'Original CI artifact mapping changed')
    release = http.api(repo + 'releases/tags/v14.0.0', 'formal-release-api.json')
    latest = http.api(repo + 'releases/latest', 'github-latest-release-api.json')
    require(release.get('tag_name') == 'v14.0.0' and release.get('draft') is False and release.get('prerelease') is False
            and latest.get('id') == release.get('id'), 'Public formal v14.0.0 must remain GitHub latest')
    assets = release.get('assets', [])
    require(len(assets) == 3 and {item.get('name') for item in assets} == {DEPLOYMENT_NAME, MATERIALS_NAME, 'SHA256SUMS.txt'},
            'Public formal attachment set differs')
    downloaded = {}
    for item in assets:
        name = item['name']
        require(item.get('state') == 'uploaded' and isinstance(item.get('size'), int) and not isinstance(item['size'], bool)
                and 0 < item['size'] <= 32 * 1024 * 1024, 'Public asset metadata invalid')
        raw = http.public_asset(item['browser_download_url'], item['size'], name)
        require(len(raw) == item['size'] and item.get('digest') == 'sha256:' + checksum(raw), 'Public full attachment bytes differ from release metadata')
        downloaded[name] = raw
    require(checksum(downloaded[DEPLOYMENT_NAME]) == DEPLOYMENT_SHA and checksum(downloaded[MATERIALS_NAME]) == MATERIALS_SHA,
            'Public deployment/material package differs from accepted/reviewed exact bytes')
    expected_checksums = {DEPLOYMENT_NAME: DEPLOYMENT_SHA, MATERIALS_NAME: MATERIALS_SHA}
    listed = {}
    for line in downloaded['SHA256SUMS.txt'].decode('utf8').splitlines():
        digest, name = line.split('  ', 1)
        require(name not in listed and PurePosixPath(name).name == name and re.fullmatch(r'[a-f0-9]{64}', digest), 'Malformed public checksum list')
        listed[name] = digest
    require(listed == expected_checksums, 'Public checksum list does not cover exactly the two attachment hashes')
    materials = {}
    with zipfile.ZipFile(io.BytesIO(downloaded[MATERIALS_NAME])) as archive:
        infos = archive.infolist()
        require(len(infos) == len({item.filename for item in infos}) and sum(item.file_size for item in infos) <= 64 * 1024 * 1024,
                'Material archive duplicate/size limits violated')
        for info in infos:
            path = PurePosixPath(info.filename)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in info.filename and not info.is_dir()
                    and not stat.S_ISLNK(info.external_attr >> 16), 'Unsafe material archive member')
            materials[info.filename] = archive.read(info)
    build = unique_json(materials['BUILD.json'])
    require(all(build.get(key) == value for key, value in {
        'component': 'server', 'version': '14.0.0', 'revision': RELEASE, 'repository': REPOSITORY,
        'build_run': str(RELEASE_RUN), 'payload_source_revision': PAYLOAD,
        'deliverables': {DEPLOYMENT_NAME: DEPLOYMENT_SHA}, 'acceptance': acceptance,
        'policy': 'require_direct', 'relay_enabled': False,
    }.items()), 'Signed public BUILD source/build/acceptance binding differs')
    indexed = build.get('materials', {})
    require(isinstance(indexed, dict) and indexed and set(materials) == set(indexed) | {'BUILD.json', 'BUILD.json.sigstore.json', 'VERIFY.txt'},
            'Unexpected or missing public material archive members')
    for name, digest in indexed.items():
        require(re.fullmatch(r'[a-f0-9]{64}', digest) and checksum(materials[name]) == digest, 'Public material hash differs from signed BUILD')
    build_path = evidence.path/'public-BUILD.json'
    bundle_path = evidence.path/'public-BUILD.json.sigstore.json'
    evidence.raw(build_path.name, materials['BUILD.json'])
    evidence.raw(bundle_path.name, materials['BUILD.json.sigstore.json'])
    cosign(args, evidence, 'public-build-signature', ['verify-blob', '--bundle', str(bundle_path), '--certificate-identity', RELEASE_SIGNER,
           '--certificate-oidc-issuer', ISSUER, str(build_path)])
    candidate_sum = materials['evidence/SHA256SUMS.txt']
    candidate_list = {}
    for line in candidate_sum.decode('utf8').splitlines():
        digest, name = line.split('  ', 1)
        require(name not in candidate_list and PurePosixPath(name).name == name and re.fullmatch(r'[a-f0-9]{64}', digest), 'Malformed original candidate checksum list')
        candidate_list[name] = digest
    require(set(candidate_list) == {name.removeprefix('evidence/') for name in indexed if name.startswith('evidence/')} - {'SHA256SUMS.txt', 'SHA256SUMS.txt.sigstore.json'},
            'Original candidate checksum member set differs')
    for name, digest in candidate_list.items():
        require(checksum(materials['evidence/' + name]) == digest, 'Original candidate signed material differs')
    evidence.raw('candidate-SHA256SUMS.txt', candidate_sum)
    evidence.raw('candidate-SHA256SUMS.txt.sigstore.json', materials['evidence/SHA256SUMS.txt.sigstore.json'])
    cosign(args, evidence, 'candidate-checksum-signature', ['verify-blob', '--bundle', str(evidence.path/'candidate-SHA256SUMS.txt.sigstore.json'),
           '--certificate-identity', IMAGE_SIGNER, '--certificate-oidc-issuer', ISSUER, str(evidence.path/'candidate-SHA256SUMS.txt')])
    manifest = unique_json(materials['evidence/release-manifest.json'])
    require(all(manifest.get(k) == v for k, v in {'component': 'server', 'version': '14.0.0', 'repository': REPOSITORY,
            'revision': PAYLOAD, 'run_id': str(ORIGINAL_RUN), 'channel': 'candidate', 'images': IMAGES,
            'caller_workflow': '.github/workflows/ci.yml', 'signer_workflow': '.github/workflows/server-candidate.yml'}.items()),
            'Signed original candidate manifest binding differs')
    require(materials['evidence/' + DEPLOYMENT_NAME] == downloaded[DEPLOYMENT_NAME], 'Public deployment differs from signed original candidate bytes')
    for name, image in IMAGES.items():
        record = unique_json(materials['evidence/image-' + name + '.json'])
        require(all(record.get(k) == v for k, v in {**image, 'name': name, 'version': '14.0.0'}.items()), 'Signed accepted image record differs')
        require((image['image'] + '@' + image['digest']).encode() in materials['evidence/compose.release.yaml'], 'Signed compose does not use accepted immutable image')
        cosign(args, evidence, name + '-image-signature-pre', ['verify', '--certificate-identity', IMAGE_SIGNER,
               '--certificate-oidc-issuer', ISSUER, image['image'] + '@' + image['digest']])
    return {'release_id': release['id'], 'release_url': release['html_url'], 'public_downloads_sha256': {name: checksum(raw) for name, raw in downloaded.items()},
            'original_candidate_artifact_metadata_sha256': checksum((evidence.path/'original-ci-artifact-api.json').read_bytes())}


def same_manifest(left, right):
    return left['digest'] == right['digest'] and left['raw'] == right['raw'] and left['content_type'] == right['content_type']


def initial_digest(value):
    require(value == 'absent' or re.fullmatch(r'sha256:[a-f0-9]{64}', value or ''), 'Apply requires each latest digest from the completed review, or absent')
    return None if value == 'absent' else value


def recheck_execution_tools(args, evidence):
    sealed = unique_json((evidence.path/'execution-tools-before.json').read_bytes())
    require(checksum(Path(__file__).read_bytes()) == sealed['source_sha256']
            and checksum((args.checkout.resolve()/'.github/workflows/server-candidate.yml').read_bytes()) == sealed['workflow_sha256']
            and checksum(Path(sys.executable).resolve().read_bytes()) == sealed['python_sha256']
            and checksum(args.cosign.resolve().read_bytes()) == sealed['cosign_sha256']
            and git(args.checkout.resolve(), 'rev-parse', 'HEAD').decode().strip() == args.expected_head
            and not git(args.checkout.resolve(), 'status', '--porcelain').strip(), 'Execution source/runtime/checkout changed after pre-seal')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('review', 'apply', 'verify'), default='review')
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--expected-head', required=True)
    parser.add_argument('--cosign', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--expected-control-latest', default='')
    parser.add_argument('--expected-gateway-latest', default='')
    args = parser.parse_args()
    # Validate root before creating an output; its directory must be outside Git.
    checkout = args.checkout.resolve()
    require(not args.output_dir.resolve().is_relative_to(checkout), 'Keep evidence outside the clean maintenance checkout')
    expected_latest = {}
    if args.mode == 'apply':
        expected_latest = {'control-center': initial_digest(args.expected_control_latest), 'traffic-gateway': initial_digest(args.expected_gateway_latest)}
    token = os.environ.get('GITHUB_TOKEN', '')
    require(token and os.environ.get('GITHUB_ACTOR'), 'Ephemeral Actions GITHUB_TOKEN and actor required')
    evidence = Evidence(args.output_dir)
    record = {'version': '14.0.0', 'status': 'started', 'mode': args.mode, 'started_at': now(), 'server_source': PAYLOAD,
              'formal_release_source': RELEASE, 'maintenance_source': args.expected_head,
              'github_run_id': os.environ.get('GITHUB_RUN_ID'), 'github_run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
              'images': {}, 'production_deployed': False, 'registry_tag_pair_atomic': False,
              'concurrency_guard': 'Workflow static concurrency group serializes this retag workflow. Re-read the entire expected latest pair before each PUT. Registry has no compare-and-swap; external writers and two-tag atomicity cannot be guaranteed.',
              'scope': 'Only original accepted raw manifests for two application latest tags. No build, deployment, FRPS mutation, Release edit, new signature, tag/source rewrite or durable authentication file.'}
    evidence.json('execution.initial.json', record)
    stage = 'validate-maintenance-and-formal-sources'
    registry = None
    try:
        acceptance = validate_sources(args, evidence)
        http = HTTP(token, evidence)
        stage = 'verify-complete-formal-public-materials-and-signatures'
        record['public_binding'] = verify_public(args, http, evidence, acceptance)
        registry = Registry(token, os.environ['GITHUB_ACTOR'], args.mode)
        prepared, observed = {}, {}
        for name, image in IMAGES.items():
            stage = 'prepare-accepted-version-latest-' + name
            repository = image['image'].removeprefix('ghcr.io/')
            accepted = registry.manifest(repository, image['digest'])
            version = registry.manifest(repository, '14.0.0')
            latest = registry.manifest(repository, 'latest', missing=True)
            require(accepted['digest'] == image['digest'] and same_manifest(accepted, version), 'Version tag must preserve accepted immutable manifest bytes')
            document = unique_json(accepted['raw'])
            require({item.get('platform', {}).get('architecture') for item in document.get('manifests', [])
                     if item.get('platform', {}).get('os') == 'linux'} >= {'amd64', 'arm64'}, 'Accepted manifest must include both Linux architectures')
            evidence.raw(name + '-accepted-manifest.json', accepted['raw'])
            if latest['raw'] is not None:
                evidence.raw(name + '-previous-latest-manifest.json', latest['raw'])
            prepared[name], observed[name] = accepted, latest
            if args.mode == 'apply':
                require(latest['digest'] == expected_latest[name], 'Current latest differs from the explicit completed-review digest')
            if args.mode == 'verify':
                require(same_manifest(latest, accepted), 'Read-only verification requires actual latest raw bytes equal accepted target')
            record['images'][name] = {'image': image['image'], 'target_digest': image['digest'], 'previous_latest_digest': latest['digest'],
                                    'write_attempted': False, 'update_outcome': 'not_attempted', 'updated': False}
        evidence.json('review.json', record)
        if args.mode == 'apply':
            for name, image in IMAGES.items():
                stage = 'pair-current-latest-precheck-' + name
                recheck_execution_tools(args, evidence)
                # Check both old/updated states before each write, preserving the
                # expected raw bytes, not only a convenient digest string.
                for peer, peer_image in IMAGES.items():
                    current = registry.manifest(peer_image['image'].removeprefix('ghcr.io/'), 'latest', missing=True)
                    require(same_manifest(current, observed[peer]), 'Latest pair changed concurrently before PUT; retain evidence and re-review')
                accepted = prepared[name]
                if observed[name]['digest'] != accepted['digest']:
                    stage = 'put-original-latest-manifest-' + name
                    record['images'][name].update(write_attempted=True, update_outcome='unknown', updated=None)
                    evidence.json(name + '-put-attempt.json', {'status': 'attempting', 'outcome': 'unknown', 'at': now(),
                                  'image': image['image'], 'previous_latest_digest': observed[name]['digest'], 'target_latest_digest': accepted['digest'],
                                  'manifest_sha256': checksum(accepted['raw']), 'production_deployed': False})
                    response = registry.put_latest(image['image'].removeprefix('ghcr.io/'), accepted)
                    evidence.json(name + '-put-response.json', response)
                    record['images'][name].update(update_outcome='response_confirmed', updated=True)
                else:
                    record['images'][name]['update_outcome'] = 'already_target'
                stage = 'read-exact-latest-after-' + name
                after = registry.manifest(image['image'].removeprefix('ghcr.io/'), 'latest')
                require(same_manifest(after, accepted), 'Latest raw manifest bytes differ after PUT')
                evidence.raw(name + '-after-latest-manifest.json', after['raw'])
                observed[name] = after
                record['images'][name].update(update_outcome='verified_target', verified_latest_digest=after['digest'])
            stage = 'final-pair-byte-and-existing-signature-verification'
            for name, image in IMAGES.items():
                final = registry.manifest(image['image'].removeprefix('ghcr.io/'), 'latest')
                require(same_manifest(final, prepared[name]), 'Final latest pair raw bytes changed')
                evidence.raw(name + '-final-latest-manifest.json', final['raw'])
                cosign(args, evidence, name + '-image-signature-after', ['verify', '--certificate-identity', IMAGE_SIGNER,
                       '--certificate-oidc-issuer', ISSUER, image['image'] + '@' + image['digest']])
                record['images'][name]['signature_reverified_after'] = True
        recheck_execution_tools(args, evidence)
        evidence.json('execution-tools-closed.json', {'status': 'actual_tools_and_source_unchanged', 'closed_at': now(),
                      'pre_execution_record_sha256': checksum((evidence.path/'execution-tools-before.json').read_bytes())})
        status = {'apply': 'passed_manifest_retag', 'review': 'review_only_no_write', 'verify': 'passed_readonly_latest_verification'}[args.mode]
        record.update(status=status, finished_at=now())
        evidence.json('result.json', record)
        print(json.dumps({'status': record['status'], 'images': record['images'], 'production_deployed': False}, ensure_ascii=False))
        return 0
    except BaseException as error:
        # Response headers, HTTP bodies and auth material never enter failures.
        record.update(status='failed', stage=stage, error_type=type(error).__name__, finished_at=now())
        evidence.json('failure.json', record)
        print(json.dumps({'status': 'failed', 'stage': stage, 'error_type': type(error).__name__,
                          'production_deployed': False}, ensure_ascii=False))
        return 1
    finally:
        token = None
        if registry is not None:
            registry.token = None
            registry.authorizations.clear()


if __name__ == '__main__':
    raise SystemExit(main())
