"""Keep documented product captures linked to their unchanged source evidence."""

from pathlib import Path
import hashlib
import json
import re
import struct
import unittest


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "docs/assets/v10.0.0"


class UiScreenshotTests(unittest.TestCase):
    def test_original_capture_identity_and_scope_are_explicit(self):
        manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["product_version"], "10.0.0")
        self.assertEqual(manifest["source_repository"], "https://github.com/ZHanry/home-tunnel-server")
        self.assertEqual(manifest["source_sha"], "9e5b4ff4e6381a42317c94618d1805b7398c558e")
        self.assertEqual(manifest["source_tag"], "v10.0.0")
        self.assertIs(manifest["actual_product_ui"], True)
        self.assertIs(manifest["synthetic_data"], True)
        self.assertIs(manifest["ui_source_modified"], False)
        self.assertIs(manifest["remote_session_verified"], False)
        self.assertIs(manifest["windows_capture"], False)

    def test_png_bytes_and_dimensions_match_the_original_manifest(self):
        manifest = json.loads((ASSETS / "manifest.json").read_text(encoding="utf-8"))
        captures = manifest["captures"]
        self.assertEqual({item["file"] for item in captures}, {
            "admin-console.png", "tunnel-wizard.png", "remote-entry.png",
        })
        self.assertEqual(len(captures), 3)
        for capture in captures:
            with self.subTest(file=capture["file"]):
                image = (ASSETS / capture["file"]).read_bytes()
                self.assertEqual(hashlib.sha256(image).hexdigest(), capture["sha256"])
                self.assertEqual(len(image), capture["bytes"])
                self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(image[12:16], b"IHDR")
                self.assertEqual(struct.unpack(">II", image[16:24]), (capture["width"], capture["height"]))

    def test_documentation_links_resolve_and_use_current_captures(self):
        document = ROOT / "docs/UI_TESTING.md"
        content = document.read_text(encoding="utf-8")
        self.assertNotIn("assets/connections.jpg", content)
        for name in ("admin-console.png", "tunnel-wizard.png", "remote-entry.png"):
            self.assertIn(f"](assets/v10.0.0/{name})", content)
        for path in (document, ASSETS / "README.md"):
            text = path.read_text(encoding="utf-8")
            for target in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", text):
                if target.startswith(("https://", "http://", "#")):
                    continue
                with self.subTest(document=path.name, target=target):
                    resolved = (path.parent / target.split("#", 1)[0]).resolve()
                    self.assertTrue(resolved.is_relative_to(ROOT))
                    self.assertTrue(resolved.is_file())


if __name__ == "__main__":
    unittest.main()
