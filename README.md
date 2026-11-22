# Local Chromium Web Search for pi-web-ui

A native pi-web-ui plugin that registers its tools and browser lifecycle directly with the plugin host. Google is the default search engine. Other search engines are used only when explicitly selected.


No hosted search API, API key, external MCP service, Playwright install, or separately managed browser process is required.

## Requirements

- pi-web-ui with plugin API v2
- Node.js 22.19+
- Python 3 with `venv` and `pip`
- A Chromium-based browser supported by DrissionPage

On first use, the plugin creates a local `.venv` and installs DrissionPage if it is not available in the active Python interpreter.

## Install

```bash
pi-web-ui install phil2sat/websearch-for-pi-web-ui --name websearch
```

Alternatively, clone it into `<dataDir>/plugins/websearch` and reload plugins.

## Agent tools

### `search_web`

Searches only the selected engine. Google is the default; blocked or empty results are reported without silently switching engines. The agent receives plain text only: numbered title, original result URL, and page description/snippet. The **Debug output** plugin setting switches between plain-text results (default) and complete JSON diagnostics, including engine responses, attempts, and parser details.

Parameters:
- `query` (required)
- `engine` (optional): `google` (default), `bing`, `duckduckgo`, `baidu`, `sogou`, `so`, `brave`, `yahoo`
- `limit` (optional, 1–20; default 10)

### `read_url`

Uses the vendored upstream `browser_use` `read_page` command to open a public HTTP(S) page and extract its title, final URL, and readable body text. Local/private network destinations are rejected.

### `browser_status`

Reports Chromium process state, CDP readiness, port, profile directory, and headless mode. It starts Chromium lazily if needed.

## Browser lifecycle

Browser lifecycle management is implemented in `runtime.mjs` using the same `browser_use` host lifecycle pattern:

- `resolvePython()` selects the plugin virtual environment, configured Python, or system Python.
- `runPythonScript()` executes the DrissionPage backend with `execFile()`.
- `buildBrowserEnv()` supplies `DP_BROWSER_PORT`, `DP_USER_DATA`, and `DP_HEADLESS`.
- `syncBackgroundTask()` registers the persistent browser task with the actual pi-web-ui host.
- `recordActivity()`, `armIdleTimer()`, and `closeBrowserDueToIdle()` maintain the idle timeout.
- `quitBrowser()` stops the DrissionPage browser and removes its background task.
- The task uses the stable ID `browser-instance`, a 3-second health interval, and two consecutive failures before removal.

The plugin entry point exports `runtime.mjs` directly. There is no MCP child process, proxy host, synthetic host object, or secondary lifecycle boundary. Consequently, `host.registerBackgroundTask` is called in the same plugin activation context as the native `browser_use` plugin.

## Runtime behavior

- Chromium starts on the first browser tool call.
- DrissionPage manages Chromium on port `9333`.
- The persistent profile is `<dataDir>/browser-use-chrome-data`.
- Search and read operations run through the vendored upstream `dp_browser.py` commands. Search uses the upstream search-tab isolation behavior; `read_url` uses the upstream `read_page` extractor.
- The host background task monitors the Chromium port every 3 seconds.
- Chromium is stopped on idle timeout or plugin deactivation.
- Browser requests are intercepted through CDP; non-HTTP(S), local, and DNS-resolved private network destinations are blocked.
- CAPTCHA and bot-check pages are reported as blocked.

## Notes

Search-engine HTML changes over time. The extractor uses engine-specific selectors with a generic fallback. Respect each search engine's terms, access controls, and rate limits.


## Search implementation

Search execution, result extraction, engine-specific selectors, and browser connection use the vendored `scripts/dp_browser.py` implementation from `pi-web-ui` `browser_use` (reference revision `33c3f6c2d49f9f0a3c437df3bfe5e41d09bba355`). Google is the default. The selected engine is passed explicitly with `--no-fallback`, so the plugin never silently switches search engines. The browser lifecycle invokes the same script's `tabs` and `quit` commands; `search_web` invokes `search`, and `read_url` invokes `read_page`. These operations use the upstream browser-control implementation.

### Debug output setting fix (0.1.37)

The `debugOutput` setting is read through the plugin settings API (`host.getSettings()`), not the plugin storage API. The current value is refreshed for every search invocation, so switching the setting reliably changes the output mode without relying on stale in-memory state.


### Output mode behavior (0.1.38)

The **Debug output** setting selects the actual `search_web` tool payload. Disabled returns only formatted result text. Enabled returns the complete diagnostic JSON as a text content block, and the agent instructions require that JSON to be reproduced verbatim rather than summarized or converted back to plain text. The setting is refreshed for each search invocation.
