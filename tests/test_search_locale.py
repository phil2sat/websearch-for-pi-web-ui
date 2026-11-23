import importlib.util
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "dp_browser.py"
SPEC = importlib.util.spec_from_file_location("dp_browser", SCRIPT)
dp_browser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dp_browser)

class SearchLocaleTests(unittest.TestCase):
    def params(self, url):
        return parse_qs(urlparse(url).query)

    def test_google_defaults_to_german(self):
        params = self.params(dp_browser._build_search_url("test", "google"))
        self.assertEqual(params["hl"], ["de"])
        self.assertEqual(params["gl"], ["DE"])

    def test_google_japan(self):
        params = self.params(dp_browser._build_search_url("日本語検索", "google", language="ja", region="JP"))
        self.assertEqual(params["hl"], ["ja"])
        self.assertEqual(params["gl"], ["JP"])

    def test_bing_japan(self):
        params = self.params(dp_browser._build_search_url("日本語検索", "bing", language="ja", region="JP"))
        self.assertEqual(params["setlang"], ["ja"])
        self.assertEqual(params["cc"], ["JP"])

    def test_duckduckgo_japan(self):
        params = self.params(dp_browser._build_search_url("日本語検索", "duckduckgo", language="ja", region="JP"))
        self.assertEqual(params["kl"], ["jp-ja"])

    def test_invalid_language_is_rejected(self):
        with self.assertRaises(ValueError):
            dp_browser._build_search_url("test", "google", language="ja-JP", region="JP")

    def test_invalid_region_is_rejected(self):
        with self.assertRaises(ValueError):
            dp_browser._build_search_url("test", "google", language="ja", region="ja_JP")

if __name__ == "__main__":
    unittest.main()
