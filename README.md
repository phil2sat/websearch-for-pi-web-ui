# Local Chromium Web Search for pi-web-ui

A dependency-free pi-web-ui plugin that supervises a local stdio MCP server and a locally launched headless Chromium. Google is the default engine; the model can explicitly select Baidu, Bing, DuckDuckGo, Sogou, Yandex, Naver, or Yahoo Japan.

No hosted search API, API key, external MCP service, Playwright install, or manually managed process is required. The plugin starts the MCP child process, proxies its tools into pi-web-ui, and the MCP runtime starts and manages Chromium on the first browser request.

## Requirements

- pi-web-ui with plugin API v2
- Node.js 22.19+
- Python 3 with `venv` and `pip`
- A Chromium-based browser supported by DrissionPage (Chromium or Chrome)

On first use, the plugin creates a local `.venv` and installs `DrissionPage` if it is not already available in the active Python interpreter. The browser is started through the same `ChromiumOptions().set_local_port(9333)` and `Chromium(options)` flow used by pi-web-ui `browser_use`.

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

## MCP integration

The plugin launches `mcp-server.mjs` with Node.js and connects over stdio JSON-RPC. The MCP server implements `initialize`, `tools/list`, and `tools/call`; pi-web-ui exposes the advertised tools as ordinary agent tools under the `mcp__websearch` namespace. The MCP process is supervised by the plugin lifecycle, so no `mcp.json` entry or separately started service is needed. The same MCP entry point can also be launched by another MCP host with Node.js.

## Runtime behavior

- The MCP stdio server starts when the plugin activates; Chromium starts on the first browser tool call.
- Chromium is managed by DrissionPage on the fixed local port `9333`, matching pi-web-ui `browser_use`.
- The browser profile is persistent under `<dataDir>/browser-use-chrome-data`, matching pi-web-ui `browser_use`.
- `DP_BROWSER_PORT`, `DP_USER_DATA`, and `DP_HEADLESS` are passed to the bootstrap process using the same environment contract as `browser_use`.
- Chromium is not spawned or discovered directly by the Node.js runtime; DrissionPage owns startup and shutdown.
- Search and read operations use isolated tabs and close them after extraction.
- The MCP child process and Chromium process are stopped when the plugin is deactivated.
- Chromium stderr is retained only as a short diagnostic tail; page content is returned as bounded text.
- Browser requests are intercepted through CDP; non-HTTP(S), local, and DNS-resolved private network destinations are blocked.
- CAPTCHA / bot-check pages are reported as blocked; the plugin does not claim they are search results.

## Notes

Search-engine HTML changes over time. The extractor uses engine-specific selectors with a generic fallback. Google remains the default; selecting another engine is a model decision through the `engine` parameter.

This plugin automates ordinary browser navigation. Respect each search engine's terms, access controls, and rate limits.
