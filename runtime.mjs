import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const BOOTSTRAP_PATH = join(PLUGIN_DIR, "browser-bootstrap.py");
const DEFAULT_BROWSER_PORT = 9333;
const DEFAULT_BROWSER_TIMEOUT_MS = 60000;

const ENGINES = {
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  duckduckgo: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  baidu: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  sogou: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
  yandex: (query) => `https://yandex.com/search/?text=${encodeURIComponent(query)}`,
  naver: (query) => `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`,
  yahoo_japan: (query) => `https://search.yahoo.co.jp/search?p=${encodeURIComponent(query)}`,
};

const ENGINE_GUIDANCE = [
  "Use Google by default for general web searches.",
  "Choose Baidu or Sogou for Chinese-language websites and sources.",
  "Choose Naver for Korean sources, Yahoo Japan for Japanese sources, and Yandex for Russian sources.",
  "Honor an explicitly requested search engine. The engine parameter is optional and defaults to Google.",
  "If an engine presents CAPTCHA, unusual-traffic, or bot-verification content, report the block; do not claim that no results exist.",
  "Use read_url to inspect promising result pages. Preserve the returned URLs as source references.",
];

const MAX_TEXT = 18000;
const NAV_TIMEOUT_MS = 18000;
const CDP_TIMEOUT_MS = 12000;

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

async function runBrowserScript(action, profileDir) {
  const env = { ...process.env, DP_BROWSER_PORT: String(DEFAULT_BROWSER_PORT), DP_USER_DATA: profileDir, DP_HEADLESS: "1", PYTHONIOENCODING: "utf-8" };
  const { stdout, stderr } = await execFileAsync(resolvePython(), [BOOTSTRAP_PATH, action], {
    env, timeout: 180000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: "utf8"
  });
  const output = String(stdout || "").trim();
  if (!output) throw new Error("Chromium bootstrap returned no output. " + String(stderr || "").slice(-1200));
  let result;
  try { result = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1)); }
  catch { throw new Error("Invalid Chromium bootstrap response: " + output.slice(-1200)); }
  if (!result?.ok) throw new Error(result?.error || "DrissionPage could not start Chromium.");
  return { result, diagnostic: String(stderr || "").slice(-2000) };
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

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  on(eventName, handler) {
    const handlers = this.handlers.get(eventName) || new Set();
    handlers.add(handler);
    this.handlers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out.")), CDP_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Unable to connect to Chromium CDP."));
      }, { once: true });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) {
        for (const handler of this.handlers.get(message.method) || []) {
          try { handler(message.params || {}); } catch {}
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed."));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Chromium CDP connection closed."));
      }
      this.pending.clear();
    });
    return this;
  }

  command(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chromium CDP is not connected."));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

function extractorExpression(engine) {
  return `(() => {
    const engine = ${JSON.stringify(engine)};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const unwrap = (raw) => {
      try {
        const url = new URL(raw, location.href);
        if (url.hostname.endsWith("google.com") && url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || raw;
        if (url.hostname.endsWith("bing.com") && url.pathname === "/ck/a") return url.searchParams.get("u") || raw;
        return url.href;
      } catch {
        return raw;
      }
    };
    const bodyText = document.body?.innerText || "";
    const blocked = /unusual traffic|automated queries|captcha|verify you are human|robot check|访问异常|安全验证|请输入验证码|비정상적인 트래픽/i.test(bodyText);
    const found = [];
    const seen = new Set();
    const add = (anchor, card) => {
      if (!anchor) return;
      const title = clean(anchor.innerText || anchor.textContent);
      const url = unwrap(anchor.href || "");
      if (!title || !/^https?:/i.test(url) || seen.has(url)) return;
      const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
      if (!host || host === location.hostname || /^(accounts|support|policies)\\./i.test(host)) return;
      if (/google\\.com|bing\\.com|duckduckgo\\.com|baidu\\.com|sogou\\.com|yandex\\.com|naver\\.com|yahoo\\.co\\.jp/.test(host)) return;
      seen.add(url);
      const text = clean(card?.innerText || "");
      const snippet = text.startsWith(title) ? clean(text.slice(title.length)) : text;
      found.push({ title, url, snippet: snippet.slice(0, 700) });
    };
    const selectors = {
      google: ["div.MjjYud", "div.g"],
      bing: ["li.b_algo"],
      duckduckgo: [".result"],
      baidu: ["div.result", "div.c-container"],
      sogou: ["div.vrwrap", "div.rb"],
      yandex: ["li.serp-item"],
      naver: ["div.total_wrap", "li.bx"],
      yahoo_japan: ["div.sw-Card", "div.algo"]
    };
    for (const selector of selectors[engine] || []) {
      for (const card of document.querySelectorAll(selector)) {
        const anchor = card.querySelector("h2 a, h3 a, a.result__a, a[data-testid='result-title-a'], a[href]");
        add(anchor, card);
      }
    }
    if (found.length < 3) {
      for (const heading of document.querySelectorAll("h2, h3")) {
        add(heading.closest("a") || heading.querySelector("a"), heading.parentElement?.parentElement || heading.parentElement);
      }
    }
    return { blocked, title: document.title, results: found.slice(0, 30) };
  })()`;
}

function readableExpression() {
  return `(() => {
    const clone = document.body?.cloneNode(true);
    if (!clone) return { title: document.title, text: "", url: location.href };
    for (const node of clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,header,footer,form,button,[aria-hidden='true']")) node.remove();
    const main = clone.querySelector("main, article, [role='main']") || clone;
    const text = (main.innerText || main.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim();
    return { title: document.title, text: text.slice(0, ${MAX_TEXT}), url: location.href };
  })()`;
}

export default {
  activate(host) {
    let settings = {};
    const readSettings = () => {
      try {
        settings = host.getSettings?.() ?? {};
      } catch {
        settings = {};
      }
    };
    readSettings();
    host.onSettingsChanged?.(readSettings);

    const profileDir = join(host.dataDir || homedir(), "browser-use-chrome-data");
    mkdirSync(profileDir, { recursive: true });

    let cdpPort = DEFAULT_BROWSER_PORT;
    let stderrTail = "";
    let starting = null;
    let disposed = false;

    async function startBrowser() {
      if (disposed) throw new Error("The websearch plugin is deactivated.");
      if (starting) return starting;
      starting = (async () => {
        mkdirSync(profileDir, { recursive: true });
        const { diagnostic } = await runBrowserScript("start", profileDir);
        stderrTail = diagnostic;
        await waitForBrowser();
        cdpPort = DEFAULT_BROWSER_PORT;
      })();
      try { await starting; } finally { starting = null; }
    }

    async function withPage(url, operation) {
      await startBrowser();
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      if (!response.ok) throw new Error(`Chromium could not create a tab (HTTP ${response.status}).`);
      const target = await response.json();
      const cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
      try {
        await cdp.command("Page.enable");
        await cdp.command("Runtime.enable");
        cdp.on("Fetch.requestPaused", (event) => {
          void (async () => {
            const safe = await isPublicNetworkUrl(event.request?.url);
            if (safe) {
              await cdp.command("Fetch.continueRequest", { requestId: event.requestId });
            } else {
              await cdp.command("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
            }
          })().catch(() => {
            void cdp.command("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
          });
        });
        await cdp.command("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
        const navigation = await cdp.command("Page.navigate", { url }, NAV_TIMEOUT_MS);
        if (navigation.errorText) throw new Error(navigation.errorText);
        const deadline = Date.now() + NAV_TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
          const result = await cdp.command("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true
          });
          if (["interactive", "complete"].includes(result.result?.value)) {
            ready = true;
            break;
          }
          await delay(250);
        }
        if (!ready) await delay(1000);
        await delay(700);
        return await operation(cdp);
      } finally {
        cdp.close();
        try {
          await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`);
        } catch {}
      }
    }

    async function evaluate(cdp, expression) {
      const result = await cdp.command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page evaluation failed.");
      return result.result?.value;
    }

    const offSearch = host.registerAgentTool({
      name: "search_web",
      label: "Web Search",
      description: "Search the public web using locally managed headless Chromium. Google is the default. Select Baidu or Sogou for Chinese-language sources, Naver for Korean, Yahoo Japan for Japanese, and Yandex for Russian. Returns structured titles, URLs, and snippets. No search API is used.",
      promptSnippet: "search the public web through local headless Chromium",
      promptGuidelines: ENGINE_GUIDANCE,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          engine: { type: "string", enum: Object.keys(ENGINES), default: "google", description: "Search engine. Defaults to Google. Choose a regional engine when the requested sources or language call for it." },
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
          const data = await withPage(ENGINES[engine](query), (cdp) => evaluate(cdp, extractorExpression(engine)));
          if (data?.blocked) {
            return {
              ok: false,
              blocked: true,
              engine,
              query,
              message: "The search engine presented a CAPTCHA or bot-verification page. No search results were extracted."
            };
          }
          const results = Array.isArray(data?.results)
            ? data.results.slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }))
            : [];
          return { ok: true, engine, query, pageTitle: data?.title ?? "", resultCount: results.length, results };
        } catch (error) {
          return { ok: false, engine, query, error: String(error?.message ?? error), diagnostic: stderrTail.slice(-1000) };
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
          const data = await withPage(url, (cdp) => evaluate(cdp, readableExpression()));
          return {
            ok: true,
            title: data?.title ?? "",
            url: data?.url ?? url,
            text: clip(data?.text ?? "", Math.min(MAX_TEXT, Math.max(1000, Number(params.maxChars) || MAX_TEXT)))
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
          return { ok: true, running: true, browser: "DrissionPage Chromium", cdpPort, profileDir, headless: true };
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
      try { await runBrowserScript("quit", profileDir); }
      catch (error) { host.log?.("warn", "Chromium shutdown failed: " + String(error?.message ?? error)); }
      cdpPort = DEFAULT_BROWSER_PORT;
    };
  }
};
