import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const execAsync = promisify(exec);
const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const BROWSER_USE_SCRIPT_PATH = join(PLUGIN_DIR, "scripts", "dp_browser.py");
const DEFAULT_BROWSER_PORT = 9333;
const DEFAULT_BROWSER_TIMEOUT_MS = 60000;
const DEFAULT_IDLE_MINUTES = 15;

const ENGINES = { google: true, bing: true, duckduckgo: true, baidu: true, sogou: true, so: true, brave: true, yahoo: true, auto: true };

const ENGINE_GUIDANCE = [
  "Use Google by default for web searches. Only use another search engine when the engine parameter explicitly selects it.",
  "Choose Baidu or Sogou for Chinese-language websites and sources.",
  "Choose Naver for Korean sources, Yahoo Japan for Japanese sources, and Yandex for Russian sources.",
  "Honor the explicitly requested search engine. The engine parameter is optional and defaults to Google; never switch engines automatically.",
  "If an engine presents CAPTCHA, unusual-traffic, or bot-verification content, report the block; do not claim that no results exist.",
  "Use read_url to inspect promising result pages. Preserve the returned URLs as source references.",
  "For user-facing search answers, output formatted_results exactly as returned (numbered title, URL on the next line, blank line, description). Do not re-wrap it in JSON or code blocks, and do not call browser_status instead of reporting a failed or empty search.",
  "Do not expose internal attempts, parser diagnostics, debug fields, or raw JSON to the user unless they explicitly request diagnostics.",
];

const MAX_TEXT = 18000;

function clip(value, max = MAX_TEXT) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + "\n… [content truncated]" : text;
}

function resolvePython() {
  const isWindows = process.platform === "win32";
  const virtualenvPython = join(PLUGIN_DIR, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
  if (existsSync(virtualenvPython)) return virtualenvPython;
  if (process.env.PYTHON_PATH && existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  return isWindows ? "python.exe" : "python3";
}

function decode(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
}

function runPythonScript(pyExecutable, scriptArgs, { env = {}, timeout = DEFAULT_BROWSER_TIMEOUT_MS, signal, scriptPath = BROWSER_USE_SCRIPT_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      ...env,
    };
    execFile(
      pyExecutable,
      [scriptPath, ...scriptArgs],
      {
        encoding: "buffer",
        timeout,
        windowsHide: true,
        signal,
        env: childEnv,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const stdoutText = decode(stdout).trim();
        const stderrText = decode(stderr).trim();
        if (err) {
          if (stdoutText.startsWith("{")) {
            try {
              const parsed = JSON.parse(stdoutText);
              if (!parsed.ok) {
                resolve(parsed);
                return;
              }
            } catch {}
          }
          const tail = stderrText ? ` (${stderrText.slice(-300)})` : "";
          reject(new Error(`browser_use runtime failed: ${err.message}${tail}`));
          return;
        }
        if (!stdoutText) {
          if (stderrText) {
            reject(new Error(`browser_use runtime returned no output: ${stderrText.slice(-300)}`));
          } else {
            resolve({ ok: true });
          }
          return;
        }
        const startIdx = stdoutText.lastIndexOf("\n{");
        const jsonCandidate = startIdx >= 0 ? stdoutText.slice(startIdx + 1) : stdoutText;
        try {
          resolve(JSON.parse(jsonCandidate));
        } catch {
          resolve({ ok: true, raw: stdoutText });
        }
      },
    );
  });
}

async function waitForBrowser() {
  const deadline = Date.now() + DEFAULT_BROWSER_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + DEFAULT_BROWSER_PORT + "/json/version");
      if (response.ok) return await response.json();
      lastError = "HTTP " + response.status;
    } catch (error) { lastError = String(error?.message ?? error); }
    await delay(250);
  }
  throw new Error("DrissionPage started but Chromium CDP did not become ready on port " + DEFAULT_BROWSER_PORT + ": " + lastError);
}

function checkPortAlive(port = DEFAULT_BROWSER_PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function forceKillPort(port = DEFAULT_BROWSER_PORT) {
  const portStr = String(port ?? "");
  if (!/^\d{1,5}$/.test(portStr)) return;
  const portNum = Number(portStr);
  if (portNum < 1 || portNum > 65535) return;
  port = portNum;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.split(/\r?\n/).filter((line) => line.includes(`:${port}`) && line.includes("LISTENING"));
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0" && pid !== String(process.pid)) {
          try {
            await execAsync(`taskkill /F /PID ${pid}`);
          } catch {}
        }
      }
    } else {
      await execAsync(`fuser -k -n tcp ${port} 2>/dev/null || lsof -ti :${port} | xargs kill -9 2>/dev/null || true`);
    }
  } catch {}
}
function isPrivateAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
      /^fe[89ab]/.test(host) || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.");
  }
  return false;
}

function validatePublicUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? ""));
  } catch {
    throw new Error("A valid absolute URL is required.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if (isPrivateAddress(url.hostname)) throw new Error("Local and private network destinations are blocked.");
  return url.href;
}

async function isPublicNetworkUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol) || isPrivateAddress(url.hostname)) return false;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  activate(host) {
    const profileDir = join(host.dataDir || homedir(), "browser-use-chrome-data");
    mkdirSync(profileDir, { recursive: true });

    const cdpPort = DEFAULT_BROWSER_PORT;
    let browserActive = false;
    let lastActivityTime = Date.now();
    let idleTimer = null;
    let idleTimeoutMinutes = DEFAULT_IDLE_MINUTES;
    let headlessMode = true;
    let bgTaskHandle = null;
    let starting = null;
    let disposed = false;
    let stderrTail = "";

    try {
      const stored = host.storage?.get?.("settings");
      if (typeof stored?.idleTimeoutMinutes === "number") {
        idleTimeoutMinutes = Math.max(0, Math.floor(stored.idleTimeoutMinutes));
      }
      if (typeof stored?.headless === "boolean") {
        headlessMode = stored.headless;
      }
    } catch {}

    function buildBrowserEnv() {
      return {
        DP_BROWSER_PORT: String(DEFAULT_BROWSER_PORT),
        DP_USER_DATA: profileDir,
        DP_HEADLESS: headlessMode ? "1" : "0",
      };
    }

    function stopIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function syncBackgroundTask() {
      const labelText = `🌐 常驻 Chrome (${headlessMode ? "无头静默" : "实体窗口"})`;
      const statusText = `端口 ${DEFAULT_BROWSER_PORT} · 运行中`;
      if (!bgTaskHandle) {
        bgTaskHandle = host.registerBackgroundTask?.({
          id: "browser-instance",
          label: labelText,
          status: statusText,
          intervalMs: 3000,
          maxFailures: 2,
          check: async () => {
            return await checkPortAlive(DEFAULT_BROWSER_PORT);
          },
          onDead: () => {
            browserActive = false;
            stopIdleTimer();
            bgTaskHandle = null;
            host.log?.("info", "[browser-use] 检测到常驻 Chrome 已关闭，已自动移除后台任务记录。");
          },
          stop: async () => {
            await quitBrowser();
          },
        });
      } else {
        bgTaskHandle.update?.({
          label: labelText,
          status: statusText,
        });
      }
    }

    function removeBackgroundTask() {
      if (bgTaskHandle) {
        bgTaskHandle.unregister?.();
        bgTaskHandle = null;
      }
    }

    async function quitBrowser() {
      browserActive = false;
      stopIdleTimer();
      removeBackgroundTask();
      try {
        const py = resolvePython();
        const env = buildBrowserEnv();
        await runPythonScript(py, ["quit"], { env, timeout: 5000, scriptPath: BROWSER_USE_SCRIPT_PATH });
      } catch {}

      const stillAlive = await checkPortAlive(DEFAULT_BROWSER_PORT, 600);
      if (stillAlive) {
        await forceKillPort(DEFAULT_BROWSER_PORT);
      }
    }

    async function closeBrowserDueToIdle() {
      if (!browserActive) return;
      await quitBrowser();
      host.log?.("info", `[browser-use] 浏览器闲置已达 ${idleTimeoutMinutes} 分钟，已自动关闭以释放内存。`);
    }

    function armIdleTimer() {
      stopIdleTimer();
      if (idleTimeoutMinutes <= 0 || !browserActive) {
        return;
      }
      const timeoutMs = idleTimeoutMinutes * 60 * 1000;
      const elapsed = Date.now() - lastActivityTime;
      const remaining = Math.max(1000, timeoutMs - elapsed);

      idleTimer = setTimeout(async () => {
        const now = Date.now();
        if (now - lastActivityTime >= timeoutMs) {
          await closeBrowserDueToIdle();
        } else {
          armIdleTimer();
        }
      }, remaining);

      if (typeof idleTimer?.unref === "function") {
        idleTimer.unref();
      }
    }

    function recordActivity() {
      browserActive = true;
      lastActivityTime = Date.now();
      armIdleTimer();
      syncBackgroundTask();
    }

    const offSettings = host.onSettingsChanged?.((values) => {
      if (values) {
        if (typeof values.idleTimeoutMinutes === "number") {
          idleTimeoutMinutes = Math.max(0, Math.floor(values.idleTimeoutMinutes));
          armIdleTimer();
        }
        if (typeof values.headless === "boolean" && values.headless !== headlessMode) {
          headlessMode = values.headless;
          if (browserActive) {
            quitBrowser().catch(() => {});
          }
        }
      }
    });

    async function startBrowser() {
      if (disposed) throw new Error("The websearch plugin is deactivated.");
      if (starting) return starting;
      starting = (async () => {
        const py = resolvePython();
        const env = buildBrowserEnv();
        const response = await runPythonScript(py, ["tabs"], { env, scriptPath: BROWSER_USE_SCRIPT_PATH });
        if (!response?.ok) {
          throw new Error(response?.error || "DrissionPage could not start Chromium.");
        }
        await waitForBrowser();
        recordActivity();
      })();
      try {
        await starting;
      } finally {
        starting = null;
      }
    }
    const offSearch = host.registerAgentTool({
      name: "search_web",
      label: "Web Search",
      description: "Search the public web using locally managed headless Chromium. Google is the default. Select Baidu or Sogou for Chinese-language sources, Naver for Korean, Yahoo Japan for Japanese, and Yandex for Russian. Returns structured titles, URLs, and snippets. No search API is used.",
      promptSnippet: "search the public web through local headless Chromium and present each result as a link followed by its description",
      promptGuidelines: ENGINE_GUIDANCE,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          engine: { type: "string", enum: Object.keys(ENGINES), default: "google", description: "Search engine. Defaults to Google. Other engines are used only when explicitly selected." },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Maximum number of results." },
        },
        required: ["query"]
      },
      async execute(_toolCallId, params, signal) {
        const query = String(params.query ?? "").trim();
        if (!query) return { ok: false, error: "query is required" };
        const engine = String(params.engine ?? "google").toLowerCase();
        if (!ENGINES[engine]) return { ok: false, error: `Unsupported engine: ${engine}`, engines: Object.keys(ENGINES) };
        const limit = Math.min(20, Math.max(1, Number(params.limit) || 10));
        try {
          if (signal?.aborted) throw new Error("Search cancelled.");
          await startBrowser();
          const py = resolvePython();
          const env = { ...buildBrowserEnv(), DP_DEFAULT_ENGINE: engine };
          const args = ["search", query, "--engine", engine, "--no-fallback", "--limit", String(limit)];
          const response = await runPythonScript(py, args, { env, scriptPath: BROWSER_USE_SCRIPT_PATH });
          recordActivity();
          if (!response?.ok) {
            return { ...response, formatted_results: `Suche fehlgeschlagen: ${response?.error ?? "unbekannter Fehler"}` };
          }
          if (!response.formatted_results) {
            response.formatted_results = `Keine Ergebnisse für „${query}“ (${engine}).`;
          }
          return response;
        } catch (error) {
          return { ok: false, engine, query, formatted_results: `Suche fehlgeschlagen: ${String(error?.message ?? error)}`, error: String(error?.message ?? error), diagnostic: stderrTail.slice(-1000) };
        }
      }
    });

    const offRead = host.registerAgentTool({
      name: "read_url",
      label: "Read Web Page",
      description: "Read a public HTTP(S) web page using local headless Chromium. Returns the final URL, title, and readable page text. Literal local/private IP and local hostnames are blocked.",
      promptSnippet: "read and extract the main text of a public web page",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute public HTTP or HTTPS URL." },
          maxChars: { type: "integer", minimum: 1000, maximum: MAX_TEXT, default: MAX_TEXT, description: "Maximum returned text length." }
        },
        required: ["url"]
      },
      async execute(_toolCallId, params, signal) {
        try {
          const url = validatePublicUrl(params.url);
          if (signal?.aborted) throw new Error("Page read cancelled.");
          const py = resolvePython();
          const maxChars = Math.min(MAX_TEXT, Math.max(1000, Number(params.maxChars) || MAX_TEXT));
          const env = buildBrowserEnv();
          const response = await runPythonScript(py, ["read_page", url, String(maxChars)], {
            env,
            signal,
            scriptPath: BROWSER_USE_SCRIPT_PATH
          });
          if (!response?.ok) return response;
          recordActivity();
          return {
            ok: true,
            title: response.title ?? "",
            url: response.url ?? url,
            text: clip(response.content ?? "", maxChars)
          };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      }
    });

    const offStatus = host.registerAgentTool({
      name: "browser_status",
      label: "Search Browser Status",
      description: "Report the local Chromium process and CDP status. Starts Chromium lazily if it is not running.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        try {
          await startBrowser();
          const running = await checkPortAlive(DEFAULT_BROWSER_PORT);
          if (!running) throw new Error("Chromium CDP port is not accepting connections.");
          return { ok: true, running: true, browser: "DrissionPage Chromium", cdpPort: DEFAULT_BROWSER_PORT, profileDir, headless: headlessMode };
        } catch (error) {
          return { ok: false, running: false, error: String(error?.message ?? error), profileDir };
        }
      }
    });

    host.log("info", "Local Chromium Web Search registered; Chromium starts on the first tool call.");
    return async () => {
      disposed = true;
      for (const unregister of [offSearch, offRead, offStatus]) {
        try {
          unregister?.();
        } catch {}
      }
      try { await quitBrowser(); }
      catch (error) { host.log?.("warn", "Chromium shutdown failed: " + String(error?.message ?? error)); }
      try { offSettings?.(); } catch {}
    };
  }
};