"""Current documentation must never reuse retired product screenshots."""
from pathlib import Path
import hashlib, json, re, struct, unittest
ROOT=Path(__file__).resolve().parents[1]
class UiScreenshotTests(unittest.TestCase):
    def test_current_capture_manifest_and_original_bytes(self):
        version=json.loads((ROOT/'compatibility.json').read_text())['version']
        manifest=json.loads((ROOT/f'docs/assets/{version}/manifest.json').read_text())
        self.assertEqual(manifest['product_version'],version)
        self.assertEqual(manifest['source_repository'],'https://github.com/ZHanry/home-tunnel-server')
        self.assertEqual(manifest['data_scope'],'local UI preview with synthetic account/device/service fixtures; no runtime acceptance claim')
        self.assertEqual(manifest['capture_kind'],'component-preview')
        self.assertFalse(manifest['installed_application'])
        self.assertFalse(manifest['remote_session_verified'])
        self.assertEqual(manifest['ui_source_hash_encoding'],'UTF-8 text with CRLF normalized to LF; matches committed Git blobs')
        self.assertGreaterEqual(len(manifest['ui_source_files']), 20)
        for item in manifest['ui_source_files']:
            source=(ROOT/item['file']).read_bytes().replace(b'\r\n',b'\n')
            self.assertEqual(hashlib.sha256(source).hexdigest(),item['sha256'],item['file'])
        captures=manifest['captures']
        self.assertGreaterEqual(len(captures), 8)
        self.assertEqual(len({item['file'] for item in captures}),len(captures))
        for item in captures:
            self.assertEqual(Path(item['file']).name,item['file'])
            self.assertEqual(item['external_requests'],[])
            data=(ROOT/f'docs/assets/{version}'/item['file']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),item['sha256'])
            self.assertEqual(data[:8],b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack('>II',data[16:24]),(item['width'],item['height']))

    def test_historical_manifest_and_capture_bytes_remain_frozen(self):
        original=(ROOT/'docs/assets/14.0.0/manifest.json').read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(),'7eb72e66b664ff72c839024c9fe98db94c8889e38e49ddabb01519c6c457d7f2')
        manifest=json.loads(original)
        self.assertEqual(manifest['product_version'],'14.0.0')
        for item in manifest['captures']:
            data=(ROOT/'docs/assets/14.0.0'/item['file']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),item['sha256'])
            self.assertEqual(struct.unpack('>II',data[16:24]),(item['width'],item['height']))
        # Historical source digests describe the original capture; they must not
        # be rewritten or compared to a later maintenance source tree.

    def test_only_original_and_new_manifest_images_exist_in_documentation(self):
        version=json.loads((ROOT/'compatibility.json').read_text())['version']
        expected=set()
        for release in ('14.0.0',version):
            manifest=json.loads((ROOT/f'docs/assets/{release}/manifest.json').read_text())
            expected.update((ROOT/f'docs/assets/{release}'/item['file']).resolve() for item in manifest['captures'])
        raster={p.resolve() for p in (ROOT/'docs').rglob('*') if p.suffix.lower() in ('.png','.jpg','.jpeg','.webp','.gif')}
        self.assertEqual(raster,expected)
    def test_documentation_image_links_do_not_refer_to_old_versions(self):
        for doc in (ROOT/'docs').rglob('*.md'):
            for target in re.findall(r'!\[[^\]]*\]\(([^)]+)\)',doc.read_text(encoding='utf-8')):
                self.assertNotRegex(target,r'v10|rc12|desktop\.jpg|connections\.jpg|dashboard\.jpg')
                if not target.startswith(('https://','http://')):
                    self.assertTrue((doc.parent/target).is_file(),target)
        version=json.loads((ROOT/'compatibility.json').read_text())['version']
        for current in (ROOT/'README.md',ROOT/'README.en.md',ROOT/'docs/UI_TESTING.md'):
            for target in re.findall(r'!\[[^\]]*\]\(([^)]+)\)',current.read_text(encoding='utf-8')):
                self.assertIn(f'assets/{version}/',target)
if __name__=='__main__':unittest.main()
