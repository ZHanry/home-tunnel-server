"""One-time, hash-bound restoration of reviewed server source. Remove after use."""
from pathlib import Path
import hashlib
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REPOSITORY = 'ZHanry/home-tunnel-server'
BRANCH = 'codex/windows-v10-1'
PARENT = 'ef072a5d88717b42e1e61d8d91d03a368d29b6d6'
PATCHED = {
    'control-center/public/app.js',
    'control-center/public/modules/locale.js',
    'control-center/public/modules/remote/view.js',
    'control-center/src/rd/service.ts',
}
GENERATED = {
    'contracts/openapi.v1.json', 'contracts/api.schema.json',
    'control-center/public/openapi.json', 'control-center/public/api-schema.json',
}
ALLOWED = PATCHED | GENERATED


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recover():
    manifest = json.loads((HERE / 'manifest.json').read_text())
    assert manifest['schema_version'] == 1
    assert manifest['repository'] == REPOSITORY and manifest['branch'] == BRANCH
    assert manifest['expected_parent'] == PARENT
    records = manifest['files']
    assert len(records) == len(ALLOWED) and {item['path'] for item in records} == ALLOWED
    patch = HERE / 'source.patch'
    assert digest(patch) == manifest['patch_sha256'], 'Recovery patch digest differs'
    patch_paths = {
        line.removeprefix('+++ b:').removeprefix('+++ b/')
        for line in patch.read_text().splitlines() if line.startswith('+++ b/')
    }
    assert patch_paths == PATCHED, 'Patch paths differ from the fixed whitelist'
    assert not run('git', 'status', '--porcelain'), 'Checkout is not clean'
    for item in records:
        path = ROOT / item['path']
        assert path.is_file() and not path.is_symlink()
        assert digest(path) == item['before_sha256'], 'Before hash differs: ' + item['path']
    subprocess.run(['git', 'apply', '--check', '--whitespace=error-all', str(patch)], cwd=ROOT, check=True)
    subprocess.run(['git', 'apply', '--whitespace=error-all', str(patch)], cwd=ROOT, check=True)
    subprocess.run(['python3', 'scripts/generate-api-spec.py'], cwd=ROOT, check=True)
    subprocess.run(['python3', 'scripts/generate-api-spec.py', '--check'], cwd=ROOT, check=True)
    for item in records:
        path = ROOT / item['path']
        assert digest(path) == item['after_sha256'], 'After hash differs: ' + item['path']
        assert path.stat().st_size == item['after_bytes'], 'After size differs: ' + item['path']
    changed = set(run('git', 'diff', '--name-only').splitlines())
    assert changed == ALLOWED, 'Generated changes escape the fixed whitelist'
    assert not run('git', 'ls-files', '--others', '--exclude-standard'), 'Unexpected untracked outputs'
    return records


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_EVENT_NAME') == 'push'
    assert os.environ.get('GITHUB_REPOSITORY') == REPOSITORY
    assert os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH
    source = os.environ['GITHUB_SHA']
    assert run('git', 'rev-parse', 'HEAD') == source, 'Checkout identity differs'
    assert run('git', 'rev-parse', 'HEAD^') == PARENT, 'Recovery parent differs'
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    assert event['before'] == PARENT and event['after'] == source, 'Push event identity differs'
    expected_ref = 'refs/heads/' + BRANCH
    assert run('git', 'ls-remote', 'origin', expected_ref).split()[0] == source, 'Branch advanced before recovery'
    records = recover()
    run('git', 'add', '--', *sorted(ALLOWED))
    assert set(run('git', 'diff', '--cached', '--name-only').splitlines()) == ALLOWED
    assert not run('git', 'diff', '--name-only'), 'Unstaged outputs remain'
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run('git', 'commit', '-m', 'fix: reconstruct reviewed v10.1 server source and API contracts')
    assert run('git', 'ls-remote', 'origin', expected_ref).split()[0] == source, 'Branch advanced; refusing to push'
    # checkout owns authentication with the existing ephemeral job token. Never
    # inspect, extract, print or persist a token ourselves. Never force or tag.
    subprocess.run(['git', 'push', '--porcelain', 'origin', 'HEAD:' + expected_ref], cwd=ROOT, check=True)
    revision = run('git', 'rev-parse', 'HEAD')
    assert run('git', 'ls-remote', 'origin', expected_ref).split()[0] == revision, 'Pushed ref not verified'
    print(json.dumps({'status': 'reconstructed', 'revision': revision,
        'files': [{'path': item['path'], 'sha256': item['after_sha256']} for item in records]}, indent=2))


if __name__ == '__main__':
    main()
