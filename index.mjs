import runtime from "./runtime.mjs";

function summarizeToolResult(result) {
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (result && typeof result === "object" && Array.isArray(result.content)) {
    text = result.content
      .filter((item) => item?.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("\n");
  }

  let json = false;
  let jsonKeys = [];
  try {
    const parsed = JSON.parse(text);
    json = true;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      jsonKeys = Object.keys(parsed).slice(0, 30);
    }
  } catch {}

  return {
    resultType: typeof result,
    contentTypes: Array.isArray(result?.content) ? result.content.map((item) => item?.type) : undefined,
    detailsKeys: result?.details && typeof result.details === "object" ? Object.keys(result.details) : undefined,
    textLength: text.length,
    textLooksLikeJson: json,
    jsonKeys,
    textPreview: text.slice(0, 800),
  };
}

export default {
  activate(host) {
    const log = (event, data = {}) => {
      try {
        host.log?.("info", `[debug-output-probe] ${event}`, data);
      } catch {}
    };

    const instrumentedHost = new Proxy(host, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);

        if (key === "getSettings" && typeof value === "function") {
          return (...args) => {
            const settings = Reflect.apply(value, target, args);
            log("getSettings", {
              debugOutput: settings?.debugOutput,
              debugOutputType: typeof settings?.debugOutput,
              settingsKeys: settings && typeof settings === "object" ? Object.keys(settings) : [],
            });
            return settings;
          };
        }

        if (key === "onSettingsChanged" && typeof value === "function") {
          return (handler) => Reflect.apply(value, target, [
            (settings) => {
              log("onSettingsChanged", {
                debugOutput: settings?.debugOutput,
                debugOutputType: typeof settings?.debugOutput,
                settingsKeys: settings && typeof settings === "object" ? Object.keys(settings) : [],
              });
              return handler(settings);
            },
          ]);
        }

        if (key === "registerAgentTool" && typeof value === "function") {
          return (tool) => {
            if (tool?.name !== "search_web" || typeof tool.execute !== "function") {
              return Reflect.apply(value, target, [tool]);
            }

            log("search_web registered; execute wrapped for diagnostics");
            const originalExecute = tool.execute;
            const wrappedTool = {
              ...tool,
              execute: async (...args) => {
                const params = args[1] ?? {};
                let settings;
                try {
                  settings = typeof target.getSettings === "function"
                    ? Reflect.apply(target.getSettings, target, [])
                    : undefined;
                } catch (error) {
                  log("getSettings threw before search", { error: String(error?.stack ?? error) });
                }
                log("search_web execute start", {
                  debugOutput: settings?.debugOutput,
                  debugOutputType: typeof settings?.debugOutput,
                  queryLength: String(params.query ?? "").length,
                  engine: params.engine ?? "google",
                  limit: params.limit ?? 10,
                  argsCount: args.length,
                  signalAborted: args[2]?.aborted ?? false,
                });

                const startedAt = Date.now();
                try {
                  const result = await Reflect.apply(originalExecute, tool, args);
                  log("search_web execute complete", {
                    durationMs: Date.now() - startedAt,
                    ...summarizeToolResult(result),
                  });
                  return result;
                } catch (error) {
                  log("search_web execute threw", {
                    durationMs: Date.now() - startedAt,
                    error: String(error?.stack ?? error),
                  });
                  throw error;
                }
              },
            };
            return Reflect.apply(value, target, [wrappedTool]);
          };
        }

        return value;
      },
    });

    log("diagnostic wrapper activated");
    return runtime.activate(instrumentedHost);
  },
};
