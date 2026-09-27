"""Reject archive ambiguity and signed-manifest/content mismatches before publication."""
import hashlib
import io
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import release_candidate as policy


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        for name, data in entries:
            bundle.writestr(name, data)
    return stream.getvalue()


def sealed_files(directory):
    # The signature is intentionally synthetic: this tests file binding only.
    # Production verifies its Sigstore identity before calling the file checker.
    data = b"original candidate bytes"
    (directory / "package.tar.gz").write_bytes(data)
    (directory / "SHA256SUMS.txt").write_text(hashlib.sha256(data).hexdigest() + "  package.tar.gz\n")
    (directory / "SHA256SUMS.txt.sigstore.json").write_text("synthetic test signature")


class CandidateArchiveTests(unittest.TestCase):
    def test_only_flat_regular_files_are_extracted(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "fresh"
            policy.safe_extract(archive([("package.tar.gz", b"same bytes")]), destination)
            self.assertEqual((destination / "package.tar.gz").read_bytes(), b"same bytes")

    def test_invalid_member_rejects_whole_archive_before_any_writes(self):
        for name in ("../outside", "nested/file", r"nested\file", "/absolute", "C:stream", "aux.txt", "COM1", "file."):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                destination = Path(temp) / "fresh"
                with self.assertRaisesRegex(SystemExit, "artifact path"):
                    policy.safe_extract(archive([("valid.txt", b"first"), (name, b"bad")]), destination)
                self.assertFalse(destination.exists())

    def test_duplicate_case_names_and_links_are_rejected(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([('file', b'a'), ('FILE', b'b')], [(link, b'outside')]):
            with tempfile.TemporaryDirectory() as temp, self.assertRaises(SystemExit):
                policy.safe_extract(archive(entries), Path(temp) / 'fresh')

    def test_existing_evidence_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp)
            (destination / 'kept').write_bytes(b'original')
            with self.assertRaisesRegex(SystemExit, 'new directory'):
                policy.safe_extract(archive([('kept', b'replaced')]), destination)
            self.assertEqual((destination / 'kept').read_bytes(), b'original')

    def test_expansion_and_entry_counts_are_bounded(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(policy, 'MAX_EXTRACT_BYTES', 3), self.assertRaisesRegex(SystemExit, 'size limit'):
                policy.safe_extract(archive([('file', b'1234')]), Path(temp) / 'size')
            with self.assertRaisesRegex(SystemExit, 'excessive'):
                policy.safe_extract(archive([(f'f{i}', b'') for i in range(257)]), Path(temp) / 'count')

    def test_changed_package_fails_even_when_checksum_manifest_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            sealed_files(directory)
            self.assertEqual(set(policy.verify_artifact_files(directory)), {'package.tar.gz'})
            (directory / 'package.tar.gz').write_bytes(b'changed')
            with self.assertRaisesRegex(SystemExit, 'checksum mismatch'):
                policy.verify_artifact_files(directory)

    def test_extra_or_missing_assets_are_not_covered_by_a_valid_manifest(self):
        for change in ('extra', 'missing'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                sealed_files(directory)
                if change == 'extra':
                    (directory / 'extra.txt').write_bytes(b'unsealed')
                else:
                    (directory / 'package.tar.gz').unlink()
                with self.assertRaisesRegex(SystemExit, 'unsealed or missing'):
                    policy.verify_artifact_files(directory)

    def test_duplicate_manifest_rows_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            sealed_files(directory)
            manifest = directory / 'SHA256SUMS.txt'
            manifest.write_text(manifest.read_text() * 2)
            with self.assertRaisesRegex(SystemExit, 'duplicate'):
                policy.verify_artifact_files(directory)


if __name__ == '__main__':
    unittest.main()
