"""Current documentation must never reuse retired product screenshots."""
from pathlib import Path
import hashlib, json, re, struct, unittest
ROOT=Path(__file__).resolve().parents[1]
class UiScreenshotTests(unittest.TestCase):
    def test_current_capture_manifest_and_original_bytes(self):
        manifest=json.loads((ROOT/'docs/assets/14.0.0/manifest.json').read_text())
        self.assertEqual(manifest['product_version'],'14.0.0')
        self.assertEqual(manifest['source_repository'],'https://github.com/ZHanry/home-tunnel-server')
        self.assertEqual(manifest['data_scope'],'local UI preview with synthetic account/device/service fixtures; no runtime acceptance claim')
        self.assertEqual(manifest['ui_source_hash_encoding'],'UTF-8 text with CRLF normalized to LF; matches committed Git blobs')
        self.assertGreaterEqual(len(manifest['ui_source_files']), 20)
        for item in manifest['ui_source_files']:
            source=(ROOT/item['file']).read_bytes().replace(b'\r\n',b'\n')
            self.assertEqual(hashlib.sha256(source).hexdigest(),item['sha256'],item['file'])
        captures=manifest['captures']
        self.assertGreaterEqual(len(captures), 6)
        self.assertEqual(len({item['file'] for item in captures}),len(captures))
        for item in captures:
            data=(ROOT/'docs/assets/14.0.0'/item['file']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),item['sha256'])
            self.assertEqual(data[:8],b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack('>II',data[16:24]),(item['width'],item['height']))
        raster={p.resolve() for p in (ROOT/'docs').rglob('*') if p.suffix.lower() in ('.png','.jpg','.jpeg','.webp','.gif')}
        self.assertEqual(raster,{(ROOT/'docs/assets/14.0.0'/item['file']).resolve() for item in captures})
    def test_documentation_image_links_do_not_refer_to_old_versions(self):
        for doc in (ROOT/'docs').rglob('*.md'):
            for target in re.findall(r'!\[[^\]]*\]\(([^)]+)\)',doc.read_text(encoding='utf-8')):
                self.assertNotRegex(target,r'v10|rc12|desktop\.jpg|connections\.jpg|dashboard\.jpg')
                if not target.startswith(('https://','http://')):
                    self.assertTrue((doc.parent/target).is_file(),target)
if __name__=='__main__':unittest.main()
