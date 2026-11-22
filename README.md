# Local Chromium Web Search for pi-web-ui

A dependency-free pi-web-ui plugin that exposes focused web-search tools backed by a locally launched headless Chromium. Google is the default engine; the model can explicitly select Baidu, Bing, DuckDuckGo, Sogou, Yandex, Naver, or Yahoo Japan.

No hosted search API, API key, external MCP service, Playwright install, or manually managed browser process is required. The plugin registers native pi-web-ui agent tools and manages Chromium itself.

## Requirements

- pi-web-ui with plugin API v2
- Node.js 22.19+
- A Chromium-based browser executable installed on the host (Chromium, Chrome, or Edge)

The plugin discovers common executable paths automatically. Set `chromiumPath` in plugin settings if discovery does not find your binary.

## Install

Install directly from GitHub:

```bash
pi-web-ui install phil2sat/websearch-for-pi-web-ui --name websearch
```

Alternatively, clone it into `<dataDir>/plugins/websearch` and reload plugins.

## Agent tools

### `search_web`

Searches the selected engine and returns structured results (rank, title, URL, snippet).

Parameters:
- `query` (required)
- `engine` (optional): `google` (default), `bing`, `duckduckgo`, `baidu`, `sogou`, `yandex`, `naver`, `yahoo_japan`
- `limit` (optional, 1–20; default 10)
- `language` and `region` (optional hints)

The model should select Baidu or Sogou for Chinese-language sites, Naver for Korean sources, Yahoo Japan for Japanese sources, and Yandex for Russian sources. Explicit engine requests always take precedence.

### `read_url`

Opens a public HTTP(S) page in Chromium and returns its title, final URL, and readable body text. Local/private network destinations are rejected.

### `browser_status`

Reports whether Chromium is running, its executable, profile directory, and CDP readiness. It starts Chromium lazily if needed.

## Runtime behavior

- Chromium starts on the first tool call, not when pi-web-ui boots.
- A private ephemeral CDP port is allocated by Chromium using `--remote-debugging-port=0`.
- The browser profile is persistent under `<dataDir>/websearch-for-pi-web-ui/chromium-profile`.
- Search and read operations use isolated tabs and close them after extraction.
- The Chromium process is stopped when the plugin is deactivated.
- Chromium stderr is retained only as a short diagnostic tail; page content is returned as bounded text.
- CAPTCHA / bot-check pages are reported as blocked; the plugin does not claim they are search results.

## Notes

Search-engine HTML changes over time. The extractor uses engine-specific selectors with a generic fallback. Google remains the default; selecting another engine is a model decision through the `engine` parameter.

This plugin automates ordinary browser navigation. Respect each search engine's terms, access controls, and rate limits.
