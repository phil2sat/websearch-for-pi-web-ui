import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "websearch-mcp-test-"));
const child = spawn(process.execPath, [join(root, "mcp-server.mjs")], {
  cwd: root,
  env: { ...process.env, WEBSEARCH_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "pipe"]
});

const lines = createInterface({ input: child.stdout });
let nextId = 0;
const pending = new Map();

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "websearch-smoke-test", version: "1.0.0" }
  });
  assert.equal(initialized.serverInfo.name, "local-chromium-websearch");

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["browser_status", "read_url", "search_web"]);
  assert.ok(listed.tools.find((tool) => tool.name === "search_web").inputSchema.properties.engine.enum.includes("baidu"));

  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
    setTimeout(() => reject(new Error("MCP server did not shut down after stdin closed.")), 5000);
  });
  assert.equal(exitCode, 0);
  process.stdout.write("MCP stdio smoke test passed.\n");
} finally {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Test cleanup."));
  }
  pending.clear();
  if (child.exitCode === null) child.kill("SIGKILL");
  lines.close();
  rmSync(dataDir, { recursive: true, force: true });
}
