import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(ROOT, "mcp-server.mjs");
const START_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 45000;

export default {
  async activate(host) {
    let settings = {};
    try {
      settings = host.getSettings?.() ?? {};
    } catch {}

    let child = null;
    let lineReader = null;
    let nextId = 0;
    let pending = new Map();
    let registered = [];
    let starting = null;
    let stopping = false;

    function rejectPending(error) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    }

    function handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "MCP request failed."));
      else entry.resolve(message.result);
    }

    function request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (!child || child.exitCode !== null || !child.stdin.writable) {
        return Promise.reject(new Error("The local websearch MCP process is not running."));
      }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          reject(error);
        });
      });
    }

    function notify(method, params = {}) {
      if (child && child.exitCode === null && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      }
    }

    async function stopServer() {
      const oldChild = child;
      child = null;
      if (!oldChild) return;
      rejectPending(new Error("The local websearch MCP process was restarted."));
      try {
        oldChild.stdin.end();
      } catch {}
      await Promise.race([
        new Promise((resolve) => oldChild.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      if (oldChild.exitCode === null) {
        try {
          oldChild.kill("SIGTERM");
        } catch {}
      }
      if (oldChild.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => oldChild.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 1000))
        ]);
      }
      if (oldChild.exitCode === null) {
        try {
          oldChild.kill("SIGKILL");
        } catch {}
      }
      lineReader?.close();
      lineReader = null;
    }

    async function startServer() {
      if (stopping) throw new Error("The websearch plugin is deactivating.");
      if (child && child.exitCode === null && registered.length) return;
      if (starting) return starting;
      starting = (async () => {
        await stopServer();
        const env = {
          ...process.env,
          WEBSEARCH_DATA_DIR: host.dataDir || "",
          WEBSEARCH_SETTINGS: JSON.stringify(settings)
        };
        child = spawn(process.execPath, [MCP_ENTRY], {
          cwd: ROOT,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
        const activeChild = child;
        lineReader = createInterface({ input: activeChild.stdout });
        lineReader.on("line", handleLine);
        activeChild.stderr.on("data", (chunk) => {
          host.log?.("warn", `[websearch MCP] ${String(chunk).trim().slice(-1500)}`);
        });
        activeChild.once("error", (error) => {
          rejectPending(error);
        });
        activeChild.once("exit", (code, signal) => {
          if (child === activeChild) child = null;
          registered = [];
          rejectPending(new Error(`The websearch MCP process exited (code=${code}, signal=${signal}).`));
        });

        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pi-web-ui-websearch-plugin", version: "0.1.0" }
        }, START_TIMEOUT_MS);
        notify("notifications/initialized");
        const response = await request("tools/list", {}, START_TIMEOUT_MS);
        const remoteTools = Array.isArray(response?.tools) ? response.tools : [];
        if (!remoteTools.length) throw new Error("The local websearch MCP server did not advertise any tools.");

        registered = remoteTools.map((remoteTool) => host.registerAgentTool({
          name: remoteTool.name,
          label: remoteTool.name.replace(/_/g, " "),
          description: remoteTool.description || "Local Chromium web search tool.",
          promptSnippet: "use the local Chromium websearch MCP server",
          namespace: {
            name: "mcp__websearch",
            description: "Locally managed Chromium websearch MCP server."
          },
          parameters: remoteTool.inputSchema || { type: "object", properties: {} },
          async execute(_toolCallId, params, signal) {
            if (signal?.aborted) throw new Error("Tool call cancelled.");
            const result = await request("tools/call", {
              name: remoteTool.name,
              arguments: params || {}
            });
            const content = Array.isArray(result?.content) ? result.content : [];
            const text = content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
            if (result?.isError) throw new Error(text || "MCP tool call failed.");
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
        }));
      })();
      try {
        await starting;
      } catch (error) {
        await stopServer();
        throw error;
      } finally {
        starting = null;
      }
    }

    await startServer();
    const offSettings = host.onSettingsChanged?.((next) => {
      settings = next && typeof next === "object" ? next : host.getSettings?.() ?? {};
      void (async () => {
        for (const unregister of registered) {
          try { unregister?.(); } catch {}
        }
        registered = [];
        await stopServer();
        if (!stopping) await startServer();
      })().catch((error) => host.log?.("error", `Websearch MCP restart failed: ${String(error?.message ?? error)}`));
    });

    host.log?.("info", "Local Chromium Web Search MCP connected; Chromium starts on first search.");
    return async () => {
      stopping = true;
      try { offSettings?.(); } catch {}
      for (const unregister of registered) {
        try { unregister?.(); } catch {}
      }
      registered = [];
      await stopServer();
    };
  }
};
