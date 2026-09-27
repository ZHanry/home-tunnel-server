"""Release-stage regressions; these tests do not contact GitHub or publish artifacts."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch

script = Path(__file__).with_name("release.py")
spec = importlib.util.spec_from_file_location("release_policy_under_test", script)
module = importlib.util.module_from_spec(spec)
previous_directory = Path.cwd()
try:
    with patch.dict(os.environ, {"GITHUB_REPOSITORY": "ZHanry/home-tunnel-test", "GITHUB_SHA": "test-commit", "GITHUB_REF_NAME": "v0.1.0-rc.1"}):
        spec.loader.exec_module(module)
finally:
    os.chdir(previous_directory)

class ReleasePolicyTests(unittest.TestCase):
    def test_first_project_version_is_allowed_as_a_test_build(self):
        self.assertEqual(module.validate_release_tag("v0.1.0-rc.1", "0.1.0-rc.1", "internal-testing"), ("0.1.0", "1"))

    def test_candidate_requires_exact_source_suffix(self):
        for source in ("8.0.0", "8.0.0-rc.2"):
            with self.assertRaisesRegex(SystemExit, "source version"):
                module.validate_release_tag("v8.0.0-rc.1", source, "internal-testing")
        self.assertEqual(module.validate_release_tag("v8.0.0-rc.1", "8.0.0-rc.1", "internal-testing"), ("8.0.0", "1"))

    def test_candidate_number_is_positive_and_canonical(self):
        for candidate in ("0", "01"):
            with self.assertRaises(SystemExit):
                module.validate_release_tag("v8.0.0-rc."+candidate, "8.0.0-rc."+candidate, "internal-testing")

    def test_internal_testing_cannot_publish_a_stable_tag(self):
        with self.assertRaisesRegex(SystemExit, "prereleases only"):
            module.validate_release_tag("v0.1.0", "0.1.0", "internal-testing")

    def test_stable_8_release_requires_matching_non_candidate_source(self):
        self.assertEqual(module.validate_release_tag("v8.0.0", "8.0.0", "public-release"), ("8.0.0", None))
        for source in ("8.0.0-rc.1", "7.0.0"):
            with self.subTest(source=source), self.assertRaisesRegex(SystemExit, "source version"):
                module.validate_release_tag("v8.0.0", source, "public-release")

    def test_source_version_must_match(self):
        with self.assertRaisesRegex(SystemExit, "source version"):
            module.validate_release_tag("v0.2.0-rc.1", "0.1.0", "internal-testing")

    def test_public_release_requires_an_explicit_stage(self):
        self.assertEqual(module.validate_release_tag("v1.0.0", "1.0.0", "public-release"), ("1.0.0", None))
        with self.assertRaisesRegex(SystemExit, "Unknown release stage"):
            module.validate_release_tag("v1.0.0", "1.0.0", "publc-release")

    def test_public_asset_list_keeps_only_installable_deliverables(self):
        self.assertEqual(module.public_asset_names("android", "6.0.0"), ["HomeTunnel-Android-6.0.0-arm64-v8a.apk"])
        client = module.public_asset_names("client", "6.0.0")
        self.assertEqual(len(client), 6)
        self.assertTrue(all(name.endswith((".exe", ".zip", ".tar.gz")) for name in client))
        self.assertEqual(module.public_asset_names("server", "6.0.0"), ["home-tunnel-server-6.0.0.tar.gz", "compose.release.yaml"])

    def test_public_asset_list_keeps_only_installable_deliverables(self):
        self.assertEqual(module.public_asset_names("android", "6.0.0"), ["HomeTunnel-Android-6.0.0-arm64-v8a.apk"])
        client = module.public_asset_names("client", "6.0.0")
        self.assertEqual(len(client), 6)
        self.assertTrue(all(name.endswith((".exe", ".zip", ".tar.gz")) for name in client))
        self.assertEqual(module.public_asset_names("server", "6.0.0"), ["home-tunnel-server-6.0.0.tar.gz", "compose.release.yaml"])

    def candidate_directory(self, digest="sha256:" + ("ab" * 32)):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        records = {}
        for name in ("control-center", "traffic-gateway"):
            records[name] = {"name": name, "image": f"ghcr.io/example/{name}", "digest": digest, "revision": "test-commit", "version": "9.0.0"}
            (directory / f"image-{name}.json").write_text(json.dumps(records[name]), encoding="utf-8")
        compose = "services:\n" + "".join(f"  {name}:\n    image: {record['image']}@{record['digest']}\n" for name, record in records.items())
        (directory / "compose.release.yaml").write_text(compose, encoding="utf-8")
        bundle = directory / "home-tunnel-server-9.0.0.tar.gz"
        bundle.write_bytes(b"candidate-bytes")
        manifest = {"component": "server", "version": "9.0.0", "repository": "ZHanry/home-tunnel-test", "revision": "test-commit", "images": {name: {"image": record["image"], "digest": record["digest"], "revision": "test-commit"} for name, record in records.items()}}
        (directory / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return directory, records, compose, bundle

    def test_candidate_binding_rejects_a_mismatched_digest(self):
        directory, records, _, _ = self.candidate_directory()
        module.assert_candidate_bound(directory)
        records["control-center"]["digest"] = "sha256:" + ("cd" * 32)
        (directory / "image-control-center.json").write_text(json.dumps(records["control-center"]), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "digest"):
            module.assert_candidate_bound(directory)

    def test_stable_acceptance_must_match_the_candidate_identity(self):
        directory, records, compose, bundle = self.candidate_directory()
        acceptance = {
            "component": "server",
            "status": "passed",
            "source_sha": "test-commit",
            "images": {name: {"image": record["image"], "digest": record["digest"], "revision": "test-commit"} for name, record in records.items()},
            "deployment_sha256": {
                "compose.release.yaml": hashlib.sha256((directory / "compose.release.yaml").read_bytes()).hexdigest(),
                "home-tunnel-server-9.0.0.tar.gz": hashlib.sha256(bundle.read_bytes()).hexdigest(),
            },
        }
        with self.assertRaisesRegex(SystemExit, "real acceptance"):
            module.require_acceptance(directory)
        (directory / "server-acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
        self.assertEqual(module.require_acceptance(directory)["source_sha"], "test-commit")
        acceptance["source_sha"] = "f" * 40
        (directory / "server-acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "source SHA"):
            module.require_acceptance(directory)
        acceptance["source_sha"] = "test-commit"
        acceptance["images"]["traffic-gateway"]["digest"] = "sha256:" + ("11" * 32)
        (directory / "server-acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "digest"):
            module.require_acceptance(directory)
        acceptance["images"]["traffic-gateway"]["digest"] = records["traffic-gateway"]["digest"]
        acceptance["deployment_sha256"]["compose.release.yaml"] = "00" * 32
        (directory / "server-acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "hash mismatch"):
            module.require_acceptance(directory)

    def test_historical_release_identity_and_contract_tags_stay_unchanged(self):
        self.assertEqual(
            module.signing_identity("v9.0.0"),
            "https://github.com/ZHanry/home-tunnel-test/.github/workflows/release.yml@refs/tags/v9.0.0",
        )
        with self.assertRaises(SystemExit):
            module.validate_release_tag("api-v1.4.0", "9.0.0", "public-release")
        with self.assertRaisesRegex(SystemExit, "prereleases only"):
            module.validate_release_tag("v9.0.0", "9.0.0", "internal-testing")

if __name__ == "__main__":
    unittest.main()
