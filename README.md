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

Searches only the selected engine. Google is the default; blocked or empty results are reported without silently switching engines. The **Debug output** plugin setting selects one of two independent search generators:

- **Off — version 0.1.35 generator:** the Python backend writes numbered titles, original result URLs, and page descriptions/snippets as plain text. This path uses the original 0.1.35 formatting and does not emit a JSON wrapper.
- **On — version 0.1.28-style debug output:** the Python backend emits the original structured JSON payload, pretty-printed with two-space indentation. It includes `formatted_results`, engine metadata, fallback information, time range, page, result count, instant answer, related queries, extracted top content, result objects, and parser attempts. The original URL-resolution diagnostics are retained.

Both generators are separate output branches in `scripts/dp_browser.py`. The `--output json|text` argument selects exactly one branch. The runtime passes the selected stdout through unchanged; it does not convert, normalize, or reformat either output. The **Debug output** setting is read when each search starts, so changing the checkbox affects the next search without restarting the plugin.

Parameters:
- `query` (required)
- `engine` (optional): `google` (default), `bing`, `duckduckgo`, `baidu`, `sogou`, `so`, `brave`, `yahoo`
- `language` (optional): ISO 639-1 two-letter language code; default `de`.
- `region` (optional): ISO 3166-1 alpha-2 country/region code; default `DE`.
- `limit` (optional, 1–20; default 10)

Regional search example: `search_web(query="...", engine="google", language="ja", region="JP")` searches Google with Japanese language and Japan region preferences. The corresponding BCP 47 locale is `ja-JP`; the tool accepts the separate language and region codes.

Google receives `hl` and `gl`, Bing receives `setlang` and `cc`, and DuckDuckGo receives its `kl` locale parameter. Other engines receive the browser `Accept-Language` header where supported; unsupported engine-specific region parameters are not fabricated. Omitting both parameters preserves the German defaults.

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

### Debug output setting synchronization

The `debugOutput` setting is initialized from `host.getSettings()` during activation, updated through `host.onSettingsChanged()`, and re-read from `host.getSettings()` when each search starts. The persisted checkbox value selects the output branch for the next invocation.


