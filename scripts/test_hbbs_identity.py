"""Identity recovery must reject mismatched keys, tampering and arbitrary tar paths."""
import base64
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location("hbbs_identity", Path(__file__).resolve().parents[1] / "deploy/scripts/hbbs-identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        public = bytes(range(32))
        self.files = {"id_ed25519": base64.b64encode(bytes(32) + public), "id_ed25519.pub": base64.b64encode(public)}

    def test_round_trip_preserves_exact_trust_identity(self):
        self.assertEqual(identity.verify(identity.archive(self.files)), self.files)

    def test_mismatched_private_public_rejected(self):
        self.files["id_ed25519.pub"] = base64.b64encode(bytes(32))
        with self.assertRaisesRegex(ValueError, "mismatched"):
            identity.archive(self.files)

    def test_unexpected_path_and_links_rejected(self):
        for name, kind in (("../id_ed25519", tarfile.REGTYPE), ("id_ed25519", tarfile.SYMTYPE)):
            with self.subTest(name=name), io.BytesIO() as data:
                with tarfile.open(fileobj=data, mode="w:gz") as bundle:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    bundle.addfile(member)
                with self.assertRaises(ValueError):
                    identity.verify(data.getvalue())


if __name__ == "__main__":
    unittest.main()
