from pathlib import Path
import importlib.util
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("landing_smoke_contract", ROOT / "deploy/scripts/e2e_smoke.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LandingContractTest(unittest.TestCase):
    def test_current_console_satisfies_the_release_landing_contract(self):
        page = (ROOT / "control-center/public/index.html").read_text(encoding="utf-8")
        module.validate_landing_page(page)

    def test_broken_download_destinations_are_rejected(self):
        page = (ROOT / "control-center/public/index.html").read_text(encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "download destination"):
            module.validate_landing_page(page.replace("home-tunnel-client/releases/latest", "home-tunnel-client#readme"))

if __name__ == "__main__":
    unittest.main()
