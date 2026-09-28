"""Negative tests for candidate identity, acceptance gates, and immutable publication.

Records in this file are synthetic inputs for the policy. They are not acceptance evidence.
"""

from pathlib import Path
import hashlib
import io
import json
import unittest
import zipfile

import release_candidate

ROOT = Path(__file__).resolve().parents[1]


def sha40(label):
    return hashlib.sha1(label.encode()).hexdigest()


def digest(label):
    return hashlib.sha256(label.encode()).hexdigest()


def finish(gate):
    gate["evidence_sha256"] = release_candidate.evidence_digest(gate)
    return gate


def gate(name, source_sha, **extra):
    value = {
        "status": "passed",
        "result": "passed",
        "source_sha": source_sha,
        "environment": "isolated-lab",
        "command": "lab " + name,
        "measured_result": "measured " + name,
        "evidence_path": name + ".json",
        "observed_at": "2026-09-27T01:00:00Z",
    }
    value.update(extra)
    return finish(value)


def acceptance_bundle():
    version = "9.0.0"
    repository = "ZHanry/home-tunnel-test"
    source_sha = sha40("server-source")
    run_id = "123456789"
    sources = {}
    for name, repo in release_candidate.REPOSITORIES.items():
        sources[name] = {"repository": repo, "sha": sha40("source-" + name)}
    sources["server"]["sha"] = source_sha
    images = {}
    for name in ("control-center", "traffic-gateway"):
        images[name] = {"image": f"ghcr.io/example/{name}", "digest": "sha256:" + digest("image-" + name), "revision": source_sha}
    deployment = {
        "compose.release.yaml": digest("compose"),
        "home-tunnel-server-9.0.0.tar.gz": digest("bundle"),
    }
    artifacts = {}
    for name in release_candidate.COMPONENTS:
        artifacts[name] = [{"filename": name + "-9.0.0.bin", "sha256": digest("artifact-" + name), "size_bytes": 2048}]
    batch_gates = {}
    owners = {
        "vm_windows_pair": "client",
        "vm_web_to_windows": "server",
        "vm_android_x64": "android",
        "network_direct_udp": "server",
        "network_blocked_udp": "server",
        "network_ipv6": "server",
        "migration_9_to_10": "server",
        "repeat_30": "client",
        "input_release_2s": "client",
        "network_restore_30s": "client",
        "active_2h": "client",
        "online_24h": "client",
    }
    for name, owner in owners.items():
        extra = {
            "source_component": owner,
            "artifact_filename": owner + "-9.0.0.bin",
            "artifact_sha256": digest("artifact-" + owner),
        }
        if name == "repeat_30":
            extra.update(successes=30, attempts=30)
        elif name == "active_2h":
            extra["duration_seconds"] = 7200
        elif name == "online_24h":
            extra["duration_seconds"] = 86400
        elif name == "input_release_2s":
            extra["release_ms"] = 1500
        elif name == "network_restore_30s":
            extra["restore_seconds"] = 20
        elif name == "network_blocked_udp":
            extra["payload_fallback"] = False
        elif name == "network_ipv6":
            extra["address_family"] = "ipv6"
        elif name == "migration_9_to_10":
            extra.update(from_version="9.0.0", to_version=version)
        batch_gates[name] = gate(name, sources[owner]["sha"], **extra)
    batch = {
        "schema_version": 1,
        "product": "Home Tunnel",
        "version": version,
        "stage": "candidate",
        "source_frozen_at": "2026-09-27T00:00:00Z",
        "frp": "0.70.1",
        "sources": sources,
        "contract": {
            "ref": "api-v1.4.0",
            "revision": sha40("contract"),
            "sha256": digest("contract"),
            "immutable": True,
        },
        "artifacts": artifacts,
        "ui_coverage": {
            "status": "passed",
            "reviewer": "gemini",
            "applicable_cases": 1,
            "reviewed_cases": 1,
            "blocking_findings": 0,
            "source_sha": sources["hub"]["sha"],
            "screenshot_manifest_sha256": digest("ui-manifest"),
            "cases": [{"id": "console-home", "result": "passed", "screenshot_sha256": digest("shot-home")}],
        },
        "gates": batch_gates,
    }
    batch["batch_id"] = release_candidate.batch_id_for(batch)
    backup = digest("backup-bytes")
    server_gates = {
        "server": gate(
            "server",
            source_sha,
            arches=["amd64", "arm64"],
            images={name: {"digest": record["digest"]} for name, record in images.items()},
        ),
        "server_ui": gate(
            "server_ui",
            source_sha,
            reviewer="gemini",
            blocking_findings=0,
            applicable_cases=1,
            reviewed_cases=1,
            cases=[{"id": "console-login", "result": "passed", "screenshot_sha256": digest("shot-login")}],
        ),
        "server_migration": gate("server_migration", source_sha, from_version="9.0.0", to_version=version, backup_sha256=backup),
        "server_backup": gate("server_backup", source_sha, backup_sha256=backup, restore_verified=True),
        "server_network": gate("server_network", source_sha, direct_udp="passed", payload_fallback=False, ipv6="passed"),
        "server_stability": gate(
            "server_stability",
            source_sha,
            active_duration_seconds=7200,
            online_duration_seconds=86400,
            successes=30,
            attempts=30,
            release_ms=1200,
            restore_seconds=15,
        ),
    }
    acceptance = {
        "schema": "home-tunnel-server-acceptance/1",
        "schema_version": 1,
        "component": "server",
        "product": "Home Tunnel",
        "version": version,
        "source_sha": source_sha,
        "repository": repository,
        "status": "passed",
        "candidate_run": {
            "id": run_id,
            "repository": repository,
            "workflow": release_candidate.APPROVED_CANDIDATE_CALLER,
            "signer_workflow": release_candidate.APPROVED_CANDIDATE_SIGNER,
            "event": "workflow_dispatch",
            "head_sha": source_sha,
        },
        "images": images,
        "deployment_sha256": deployment,
        "batch": batch,
        "server_gates": server_gates,
    }
    context = {
        "source_sha": source_sha,
        "version": version,
        "repository": repository,
        "images": images,
        "deployment_hashes": deployment,
        "run_id": run_id,
    }
    return acceptance, context


def origin_record():
    repository = "ZHanry/home-tunnel-server"
    sha = sha40("origin")
    run_id = "987654321"
    branch = "codex/v10-overhaul"
    payload = b"candidate-artifact-bytes"
    manifest = {
        "revision": sha,
        "repository": repository,
        "release_contract": release_candidate.RELEASE_CONTRACT,
        "run_id": run_id,
        "caller_workflow": release_candidate.APPROVED_CANDIDATE_CALLER,
        "signer_workflow": release_candidate.APPROVED_CANDIDATE_SIGNER,
    }
    run = {
        "id": int(run_id),
        "repository": {"full_name": repository},
        "head_repository": {"full_name": repository, "fork": False},
        "path": release_candidate.APPROVED_CANDIDATE_CALLER,
        "event": "workflow_dispatch",
        "status": "completed",
        "conclusion": "success",
        "head_sha": sha,
        "head_branch": branch,
        "triggering_actor": {"login": "maintainer", "type": "User"},
    }
    artifact = {
        "name": "candidate-assets",
        "expired": False,
        "digest": release_candidate.artifact_digest(payload),
        "size_in_bytes": len(payload),
    }
    return {
        "run": run,
        "artifact": artifact,
        "zip_bytes": payload,
        "manifest": manifest,
        "signature_identity": release_candidate.candidate_signer_identity(repository, branch),
        "repository": repository,
        "run_id": run_id,
        "permission": "maintain",
    }


class CandidatePolicyTests(unittest.TestCase):
    def test_branch_candidate_keeps_a_stable_version_without_main(self):
        branch = release_candidate.validate_candidate_request(
            "workflow_dispatch", "refs/heads/codex/v10-overhaul", sha40("head"), "10.0.0"
        )
        self.assertEqual(branch, "codex/v10-overhaul")
        with self.assertRaisesRegex(SystemExit, "pull_request"):
            release_candidate.validate_candidate_request("pull_request", "refs/pull/1/merge", sha40("head"), "10.0.0")
        with self.assertRaisesRegex(SystemExit, "not an rc"):
            release_candidate.validate_candidate_request("workflow_dispatch", "refs/heads/codex/v10-overhaul", sha40("head"), "10.0.0-rc.1")
        with self.assertRaisesRegex(SystemExit, "do not build"):
            release_candidate.refuse_stable_server_rebuild("server", None)
        release_candidate.refuse_stable_server_rebuild("server", "1")

    def test_security_dispatch_is_required_for_the_same_repository(self):
        sha = sha40("secured")
        runs = []
        for name, path in release_candidate.APPROVED_SECURITY.items():
            runs.append({
                "name": name,
                "path": path,
                "head_sha": sha,
                "conclusion": "success",
                "event": "workflow_dispatch",
                "head_repository": {"full_name": "ZHanry/home-tunnel-server"},
            })
        self.assertEqual(release_candidate.security_gate_errors(runs, sha, "ZHanry/home-tunnel-server"), [])
        runs[0]["event"] = "pull_request"
        self.assertTrue(release_candidate.security_gate_errors(runs, sha, "ZHanry/home-tunnel-server"))

    def test_complete_synthetic_acceptance_matches_its_candidate(self):
        acceptance, context = acceptance_bundle()
        self.assertEqual(release_candidate.acceptance_errors(acceptance, **context), [])

    def test_origin_rejects_wrong_run_workflow_repo_sha_digest_and_signature(self):
        valid = origin_record()
        self.assertEqual(release_candidate.origin_errors(**valid), [])
        wrong_run = origin_record()
        wrong_run["run_id"] = "42"
        self.assertTrue(any("run" in item for item in release_candidate.origin_errors(**wrong_run)))
        wrong_workflow = origin_record()
        wrong_workflow["run"]["path"] = ".github/workflows/publish-stable.yml"
        self.assertTrue(any("workflow" in item for item in release_candidate.origin_errors(**wrong_workflow)))
        wrong_repo = origin_record()
        wrong_repo["run"]["head_repository"] = {"full_name": "example/fork", "fork": True}
        self.assertTrue(any("repository" in item for item in release_candidate.origin_errors(**wrong_repo)))
        wrong_sha = origin_record()
        wrong_sha["manifest"]["revision"] = sha40("forged-manifest")
        with self.assertRaisesRegex(SystemExit, "SHA"):
            release_candidate.trusted_sha(wrong_sha["run"], wrong_sha["manifest"])
        self.assertTrue(any("SHA" in item for item in release_candidate.origin_errors(**wrong_sha)))
        wrong_digest = origin_record()
        wrong_digest["artifact"]["digest"] = "sha256:" + digest("other-zip")
        self.assertTrue(any("digest" in item for item in release_candidate.origin_errors(**wrong_digest)))
        wrong_signature = origin_record()
        wrong_signature["signature_identity"] = wrong_signature["signature_identity"].replace("server-candidate.yml", "publish-stable.yml")
        self.assertTrue(any("signature" in item for item in release_candidate.origin_errors(**wrong_signature)))
        wrong_caller = origin_record()
        wrong_caller["permission"] = "write"
        self.assertTrue(any("caller" in item for item in release_candidate.origin_errors(**wrong_caller)))

    def test_summary_status_and_missing_gates_fail_closed(self):
        acceptance, context = acceptance_bundle()
        acceptance["server_gates"].pop("server_ui")
        self.assertTrue(any("server_ui" in item for item in release_candidate.acceptance_errors(acceptance, **context)))
        acceptance, context = acceptance_bundle()
        acceptance["server_gates"].pop("server_migration")
        self.assertTrue(any("server_migration" in item for item in release_candidate.acceptance_errors(acceptance, **context)))
        acceptance, context = acceptance_bundle()
        acceptance["server_gates"]["server_stability"]["active_duration_seconds"] = 7199
        acceptance["server_gates"]["server_stability"] = finish(acceptance["server_gates"]["server_stability"])
        self.assertTrue(any("duration" in item for item in release_candidate.acceptance_errors(acceptance, **context)))
        acceptance, context = acceptance_bundle()
        acceptance["server_gates"]["server_ui"]["observed_at"] = "2026-09-26T23:00:00Z"
        acceptance["server_gates"]["server_ui"] = finish(acceptance["server_gates"]["server_ui"])
        self.assertTrue(any("stale" in item for item in release_candidate.acceptance_errors(acceptance, **context)))
        acceptance, context = acceptance_bundle()
        acceptance["status"] = "passed"
        acceptance["server_gates"]["server_network"]["status"] = "not_run"
        self.assertTrue(any("summary status cannot replace" in item for item in release_candidate.acceptance_errors(acceptance, **context)))
        acceptance, context = acceptance_bundle()
        acceptance["fixture"] = True
        self.assertTrue(any("fixture" in item for item in release_candidate.acceptance_errors(acceptance, **context)))

    def test_publication_refuses_replacement_and_accepts_the_frozen_tree(self):
        self.assertEqual(release_candidate.publication_tag("10.0.0"), "v10.0.0")
        with self.assertRaisesRegex(SystemExit, "non-final"):
            release_candidate.publication_tag("9.0.0")
        with self.assertRaisesRegex(SystemExit, "existing tag"):
            release_candidate.assert_tag_unpublished({"ref": "refs/tags/v10.0.0"})
        with self.assertRaisesRegex(SystemExit, "published assets"):
            release_candidate.assert_assets_unpublished(["home-tunnel-server-10.0.0.tar.gz"])
        ready = {
            "rebuilt": False,
            "origin_verified": True,
            "acceptance_errors": [],
            "original_seal_changed": False,
            "version": "10.0.0",
            "contract_status": "frozen",
            "contract_ref": "api-v1.4.0",
            "on_main": True,
            "tag_exists": False,
            "assets_exist": False,
            "event": "workflow_dispatch",
        }
        self.assertEqual(release_candidate.promotion_blockers(ready), [])
        tagged = dict(ready, tag_exists=True)
        self.assertTrue(any("existing tag" in item for item in release_candidate.promotion_blockers(tagged)))
        replaced = dict(ready, assets_exist=True)
        self.assertTrue(any("published assets" in item for item in release_candidate.promotion_blockers(replaced)))
        package = json.loads((ROOT / "control-center/package.json").read_text(encoding="utf-8"))
        compatibility = json.loads((ROOT / "compatibility.json").read_text(encoding="utf-8"))
        current = dict(ready, version=package["version"], contract_status=compatibility["contract_status"], contract_ref=compatibility["contract_ref"])
        # The checked-in source is the final 10.0.0 version with api-v1.4.0 frozen.
        self.assertEqual(release_candidate.promotion_blockers(current), [])
        stale = dict(ready, version="9.0.0", contract_status="proposed")
        blockers = release_candidate.promotion_blockers(stale)
        self.assertTrue(any("10.0.0" in item for item in blockers))
        self.assertTrue(any("frozen" in item for item in blockers))

    def test_original_seal_and_artifact_paths_stay_intact(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            release = Path(temporary) / "release"
            release.mkdir()
            (release / "SHA256SUMS.txt").write_bytes(b"original-sums")
            (release / "SHA256SUMS.txt.sigstore.json").write_bytes(b"original-bundle")
            snapshot = release_candidate.seal_snapshot(release)
            acceptance = Path(temporary) / "acceptance"
            record, _context = acceptance_bundle()
            release_candidate.write_acceptance_bundle(acceptance, json.dumps(record), record)
            release_candidate.assert_seal_preserved(release, snapshot)
            (release / "SHA256SUMS.txt.sigstore.json").write_bytes(b"replacement-bundle")
            with self.assertRaisesRegex(SystemExit, "replace original build seal"):
                release_candidate.assert_seal_preserved(release, snapshot)
            slipped = io.BytesIO()
            with zipfile.ZipFile(slipped, "w") as bundle:
                bundle.writestr("../outside.txt", b"nope")
            with self.assertRaisesRegex(SystemExit, "artifact path"):
                release_candidate.safe_extract(slipped.getvalue(), Path(temporary) / "extract")

    def test_schema_and_workflows_keep_the_publication_boundary(self):
        schema = json.loads((ROOT / "docs/server-acceptance.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(tuple(schema["x-required-server-gates"]), release_candidate.SERVER_GATES)
        self.assertEqual(tuple(schema["x-required-batch-gates"]), release_candidate.BATCH_GATES)
        self.assertFalse((ROOT / "server-acceptance.json").exists())
        self.assertFalse((ROOT / "docs/release/server-acceptance.json").exists())
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        head, jobs = ci.split("jobs:", 1)
        self.assertIn("contents: read", head)
        self.assertNotIn("id-token", head)
        self.assertNotIn("packages:", head)
        self.assertIn("build_candidate", ci)
        self.assertIn("github.event_name == 'workflow_dispatch'", jobs)
        self.assertNotIn("pull_request_target", ci)
        candidate = (ROOT / ".github/workflows/server-candidate.yml").read_text(encoding="utf-8")
        candidate_on, _candidate_jobs = candidate.split("jobs:", 1)
        self.assertNotIn("workflow_dispatch", candidate_on)
        self.assertNotIn("contents: write", candidate)
        self.assertNotIn("pull_request", candidate)
        publish = (ROOT / ".github/workflows/publish-stable.yml").read_text(encoding="utf-8")
        self.assertIn("actions: read", publish)
        self.assertNotIn("build-push-action", publish)
        self.assertNotIn("docker build", publish)
        self.assertNotIn("GITHUB_SHA", publish)
        self.assertNotIn("cosign sign --yes", publish)
        self.assertNotIn("release-manifest.json", publish)

    def test_publisher_contract_rejects_a_stale_candidate_copy(self):
        current = Path(release_candidate.__file__).read_text(encoding="utf-8")
        release_candidate.assert_same_contract(current, current)
        stale = current.replace(f'RELEASE_CONTRACT = "{release_candidate.RELEASE_CONTRACT}"', 'RELEASE_CONTRACT = "server-candidate/0"', 1)
        with self.assertRaisesRegex(SystemExit, "release contract"):
            release_candidate.assert_same_contract(current, stale)


if __name__ == "__main__":
    unittest.main()
