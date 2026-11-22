import plugin from "./runtime.mjs";

const tools = new Map();
let cleanup = null;
let shuttingDown = false;
let input = "";

const host = {
  dataDir: process.env.WEBSEARCH_DATA_DIR || process.cwd(),
  getSettings() {
    try {
      return JSON.parse(process.env.WEBSEARCH_SETTINGS || "{}");
    } catch {
      return {};
    }
  },
  onSettingsChanged() {
    return () => {};
  },
  registerAgentTool(tool) {
    tools.set(tool.name, tool);
    return () => tools.delete(tool.name);
  },
  log(level, message) {
    process.stderr.write(`[websearch:${level}] ${String(message)}\n`);
  }
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "local-chromium-websearch", version: "0.1.0" }
    });
    return;
  }
  if (message.method === "ping") {
    result(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(message.id, {
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters || { type: "object", properties: {} }
      }))
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = String(message.params?.name || "");
    const tool = tools.get(name);
    if (!tool) {
      failure(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }
    try {
      const value = await tool.execute(
        `mcp-${message.id}`,
        message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {}
      );
      result(message.id, {
        content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
        isError: value?.ok === false
      });
    } catch (error) {
      result(message.id, {
        content: [{ type: "text", text: String(error?.message ?? error) }],
        isError: true
      });
    }
    return;
  }
  if (message.id !== undefined) failure(message.id, -32601, `Method not found: ${message.method}`);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await cleanup?.();
  } catch (error) {
    process.stderr.write(`[websearch:error] ${String(error?.message ?? error)}\n`);
  }
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const index = input.indexOf("\n");
    if (index < 0) break;
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`[websearch:error] Invalid JSON-RPC input: ${String(error?.message ?? error)}\n`);
    }
  }
});
process.stdin.on("end", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

try {
  cleanup = await plugin.activate(host);
} catch (error) {
  process.stderr.write(`[websearch:fatal] ${String(error?.stack ?? error)}\n`);
  process.exit(1);
}
