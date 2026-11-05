
const EXTENSION_ID = "agent-subagent";
const SETTINGS_KEY = "agent_subagent_v1";

let running = false;
let stopRequested = false;
let registeredTools = [];

function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    subagentName: "Subagent",
    maxLoops: 8,
    autoAttachTools: true,
    lastTask: "",
  };
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

function createPanel() {
  const panel = document.createElement("div");
  panel.id = "agent_subagent_panel";
  panel.style.padding = "10px";

  panel.innerHTML = `
    <h3>Agent & Subagent</h3>
    <label>Subagent Name</label>
    <input id="asa_subagent_name" type="text" placeholder="Subagent" />
    <label>Max Subagent Loops</label>
    <input id="asa_max_loops" type="number" min="1" max="30" />
    <label><input id="asa_auto_tools" type="checkbox" /> Auto-attach registered tools to subagent</label>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button id="asa_save" class="menu_button">Save</button>
      <button id="asa_run" class="menu_button">Run Subagent</button>
      <button id="asa_stop" class="menu_button">Stop</button>
    </div>
    <pre id="asa_log" style="margin-top:8px;white-space:pre-wrap;max-height:280px;overflow:auto;background:#111;padding:8px;border-radius:6px;"></pre>
  `;

  const container = document.querySelector("#extensions_settings");
  if (container) {
    container.appendChild(panel);
  } else {
    // Fallback: append to body if extensions_settings not found
    panel.style.position = "fixed";
    panel.style.bottom = "10px";
    panel.style.right = "10px";
    panel.style.zIndex = "9999";
    panel.style.background = "#222";
    panel.style.border = "1px solid #555";
    panel.style.borderRadius = "8px";
    document.body.appendChild(panel);
  }

  const s = getSettings();
  document.querySelector("#asa_subagent_name").value = s.subagentName || "Subagent";
  document.querySelector("#asa_max_loops").value = s.maxLoops ?? 8;
  document.querySelector("#asa_auto_tools").checked = s.autoAttachTools !== false;

  document.querySelector("#asa_save").addEventListener("click", () => {
    const subagentName = document.querySelector("#asa_subagent_name").value.trim() || "Subagent";
    const maxLoops = Math.max(1, Math.min(30, parseInt(document.querySelector("#asa_max_loops").value, 10) || 8));
    const autoAttachTools = document.querySelector("#asa_auto_tools").checked;

    saveSettings({ subagentName, maxLoops, autoAttachTools });
    log("Settings saved.");
  });

  document.querySelector("#asa_run").addEventListener("click", async () => {
    const s = getSettings();
    // Get last user message from chat
    const chatData = SillyTavern.getContext().chat;
    const lastUser = chatData?.[chatData.length - 1];
    const task = lastUser?.is_user ? lastUser.mes : (s.lastTask || "Continue the current task using tools.");
    saveSettings({ ...s, lastTask: task });
    await runSubagent(task);
  });

  document.querySelector("#asa_stop").addEventListener("click", () => {
    stopRequested = true;
    log("Stop requested.");
  });
}

function log(text) {
  const el = document.querySelector("#asa_log");
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${text}
`;
  el.scrollTop = el.scrollHeight;
}

/**
 * Collect all currently registered tools from ToolManager
 * and convert them to OpenAI function calling format.
 */
function getRegisteredTools() {
  try {
    const ctx = SillyTavern.getContext();
    const tools = ctx.ToolManager?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return [];

    return tools
      .map(t => {
        if (!t || typeof t.toFunctionOpenAI !== "function") return null;
        try {
          const fn = t.toFunctionOpenAI();
          if (!fn?.function?.name) return null;
          return {
            type: "function",
            function: {
              name: fn.function.name,
              description: fn.function.description || "",
              parameters: fn.function.parameters || { type: "object", properties: {} },
            },
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Invoke a registered tool by name using ToolManager.
 * 返回结构化结果，明确区分"未注册"、"执行抛错"、"工具自身返回失败"。
 */
async function invokeTool(name, args) {
  const ctx = SillyTavern.getContext();
  if (!ctx.ToolManager || typeof ctx.ToolManager.invokeFunctionTool !== "function") {
    return { ok: false, kind: "TOOL_NOT_FOUND", result: `[TOOL_NOT_FOUND] ToolManager unavailable in this SillyTavern build; cannot invoke "${name}".` };
  }
  try {
    const result = await ctx.ToolManager.invokeFunctionTool(name, args);
    if (result instanceof Error) {
      return { ok: false, kind: "TOOL_ERROR", result: `[TOOL_ERROR] Tool "${name}" threw: ${result.message || result}` };
    }
    // 工具自身以 {ok:false} 结构报告失败
    if (result && typeof result === "object" && !Array.isArray(result) && result.ok === false) {
      const detail = result.error || result.errorMessage || "tool reported failure";
      return { ok: false, kind: "TOOL_FAILED", result: `[TOOL_FAILED] Tool "${name}" reported failure: ${detail}` };
    }
    return { ok: true, kind: "OK", result: typeof result === "string" ? result : JSON.stringify(result) };
  } catch (err) {
    return { ok: false, kind: "TOOL_ERROR", result: `[TOOL_ERROR] Tool "${name}" threw: ${err?.message || err}` };
  }
}

/**
 * 把受限 JS API 沙箱包装成 subagent 可调用的 function tool。
 * 沙箱执行的是 ST 公开前端 API（ctx/st），与"小白助手聊天面板"本身无关。
 * 优先使用 LittleWhiteBox 的 jsapi-runtime（带 manifest 校验），不可用时回退到内置最小沙箱，
 * 因此本扩展在没有 LittleWhiteBox 的环境也能独立运行。
 */
const JSAPI_TOOL_NAME = "run_js_api";

function normalizeJsApiOutput(output) {
  if (output === undefined || output === "") return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** 可选增强：加载 LittleWhiteBox 的 JS API manifest + 运行时（只读前端文件，不依赖助手面板）。 */
async function loadLwbJsApiRuntime() {
  const base = "/scripts/extensions/third-party/LittleWhiteBox/modules/assistant";
  const manifestResponse = await fetch(`${base}/st-jsapi-manifest.json`, { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`jsapi_manifest_load_failed:${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const runtimeModule = await import(`${base}/runtime-src/jsapi-runtime.js`);
  if (typeof runtimeModule?.runJavaScriptApi !== "function") throw new Error("jsapi_runtime_missing_runJavaScriptApi");
  return { manifest, runtimeModule };
}

/**
 * 内置最小沙箱：与 LittleWhiteBox 的 executeValidatedCode 等价的核心行为
 * （AsyncFunction + "use strict" + 注入 ctx/st 与少量全局对象），
 * 但不做 manifest 校验和 requestKind 分类。
 */
async function executeInMinimalSandbox(codeText, stContext, st) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction(
    "ctx", "st", "JSON", "Math", "Object", "Array", "Date", "String", "Number", "Promise",
    `\"use strict\";
${codeText}`
  );
  return await runner(stContext, st, JSON, Math, Object, Array, Date, String, Number, Promise);
}

async function executeJsApiTool({ code = "", purpose = "", apiPaths = [], safety = "", expectedOutput = "" } = {}) {
  const codeText = String(code || "").trim();
  const purposeText = String(purpose || "").trim();
  const expectedText = String(expectedOutput || "").trim();
  if (!codeText || !purposeText || !expectedText) {
    return { ok: false, error: "code、purpose、expectedOutput 均为必填。" };
  }

  const stContext = SillyTavern.getContext();
  const st = {
    extensions: {
      getContext: () => stContext,
    },
    script: {},
    slash: {},
  };

  // 优先走 LittleWhiteBox 的完整沙箱（带 manifest 校验）
  try {
    const { manifest, runtimeModule } = await loadLwbJsApiRuntime();
    const result = await runtimeModule.runJavaScriptApi({
      code: codeText,
      purpose: purposeText,
      apiPaths: Array.isArray(apiPaths) ? apiPaths : [],
      safety: String(safety || ""),
      expectedOutput: expectedText,
      manifest: manifest,
      ctx: stContext,
      st,
    });

    return {
      ok: result?.ok === true,
      output: normalizeJsApiOutput(result?.output),
      requestKind: result?.requestKind || "unknown",
      note: result?.note || "",
      error: result?.ok ? "" : (result?.execution?.errorMessage || result?.execution?.validationErrors?.join("; ") || "jsapi_failed"),
    };
  } catch (lwbErr) {
    // 回退：内置最小沙箱（无 LittleWhiteBox 也能跑）
    try {
      const output = await executeInMinimalSandbox(codeText, stContext, st);
      return {
        ok: true,
        output: normalizeJsApiOutput(output),
        requestKind: "minimal",
        note: `LittleWhiteBox jsapi-runtime 不可用（${lwbErr?.message || lwbErr}），已回退到内置最小沙箱执行。`,
      };
    } catch (fallbackErr) {
      return {
        ok: false,
        error: `jsapi_execution_failed: ${fallbackErr?.message || fallbackErr}`,
        note: `LittleWhiteBox jsapi-runtime 不可用（${lwbErr?.message || lwbErr}），内置最小沙箱执行也失败。`,
      };
    }
  }
}

let jsApiToolRegistered = false;

/** 注册 JS API 工具到 ToolManager（幂等）。 */
function registerJsApiTool() {
  if (jsApiToolRegistered) return true;
  try {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.registerFunctionTool !== "function") return false;
    ctx.registerFunctionTool({
      name: JSAPI_TOOL_NAME,
      displayName: "执行 JS API",
      description:
        "执行一段受限 JavaScript 代码来读取/检查 SillyTavern 前端公开状态（ctx.* / st.*），" +
        "例如读取聊天消息、变量、世界书、扩展设置等。代码必须显式 return 最终结果；" +
        "inspect/read 请求 apiPaths 可省略，effect（副作用）请求建议提供精确 apiPaths。",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JS 代码，必须显式 return 结果。可用注入的 ctx 和 st。" },
          purpose: { type: "string", description: "这段代码要做什么。" },
          apiPaths: {
            type: "array",
            items: { type: "string" },
            description: "可选：用到的公开 API 路径，如 [\"ctx.chat\"] 或 [\"st.extensions.getContext\"]。",
          },
          safety: { type: "string", description: "可选：安全性说明，如 只读 / 会修改哪些状态。" },
          expectedOutput: { type: "string", description: "预期返回什么结果。" },
        },
        required: ["code", "purpose", "expectedOutput"],
      },
      action: async (params = {}) => executeJsApiTool(params),
      formatMessage: (params = {}) => `JS API: ${String(params.purpose || params.code || "").slice(0, 80)}`,
      shouldRegister: () => true,
      stealth: false,
    });
    jsApiToolRegistered = true;
    return true;
  } catch (err) {
    console.warn("[agent-subagent] JS API tool 注册失败:", err?.message || err);
    return false;
  }
}


/**
 * 调用 LLM：优先直连 ST 后端 /api/backends/chat-completions/generate，
 * 请求体里显式带 tools，保证 tool_calls 循环能跑起来。
 * 该端点由 SillyTavern 后端代理转发到当前 Chat Completion 源，tools 参数会原样透传。
 */
async function callSubagentLLM(messages, tools) {
  const ctx = SillyTavern.getContext();
  const settings = ctx.chatCompletionSettings;
  if (!settings || typeof ctx.getRequestHeaders !== "function" || typeof ctx.getChatCompletionModel !== "function") {
    throw new Error("缺少 chatCompletionSettings / getRequestHeaders / getChatCompletionModel，无法直连后端。");
  }

  const model = ctx.getChatCompletionModel(settings);
  if (!model) {
    throw new Error("getChatCompletionModel 返回空，请检查当前 Chat Completion 设置。");
  }

  const generateData = {
    type: "normal",
    messages: messages,
    model: model,
    temperature: Number(settings.temp_openai),
    frequency_penalty: Number(settings.freq_pen_openai),
    presence_penalty: Number(settings.pres_pen_openai),
    top_p: Number(settings.top_p_openai),
    max_tokens: settings.openai_max_tokens,
    stream: false,
    chat_completion_source: settings.chat_completion_source,
    user_name: ctx.name1,
    char_name: ctx.name2,
    include_reasoning: Boolean(settings.show_thoughts),
  };

  if (settings.reverse_proxy) {
    generateData.reverse_proxy = settings.reverse_proxy;
    generateData.proxy_password = settings.proxy_password;
  }

  // Custom OpenAI 源需要显式提供 custom_url 等字段（openai.js:2922）
  if (settings.chat_completion_source === "custom") {
    generateData.custom_url = settings.custom_url;
    if (settings.custom_include_body) generateData.custom_include_body = settings.custom_include_body;
    if (settings.custom_exclude_body) generateData.custom_exclude_body = settings.custom_exclude_body;
    if (settings.custom_include_headers) generateData.custom_include_headers = settings.custom_include_headers;
  }

  if (Array.isArray(tools) && tools.length > 0) {
    generateData.tools = tools;
    generateData.tool_choice = "auto";
  }

  const response = await fetch("/api/backends/chat-completions/generate", {
    method: "POST",
    body: JSON.stringify(generateData),
    headers: ctx.getRequestHeaders(),
    cache: "no-cache",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`后端返回 ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  if (data?.error) {
    const msg = data.error?.message || (typeof data.error === "string" ? data.error : JSON.stringify(data.error));
    throw new Error(`API 错误: ${msg}`);
  }
  return data;
}

async function runSubagent(task) {
  if (running) {
    log("Subagent already running.");
    return;
  }

  running = true;
  stopRequested = false;

  const s = getSettings();
  const maxLoops = s.maxLoops ?? 8;
  const subagentName = s.subagentName || "Subagent";

  log(`Subagent started: ${subagentName}`);
  log(`Task: ${task}`);

  const systemPrompt =
    `You are a subagent named ${subagentName}. ` +
    `Your job is to complete the task by planning, calling tools, and iterating until you have a final answer. ` +
    `When you call tools, wait for their results before concluding. ` +
    `When you are done, return only the final answer.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  let tools = [];
  if (s.autoAttachTools) {
    tools = getRegisteredTools();
    if (tools.length > 0) {
      log(`Attached ${tools.length} registered tool(s): ${tools.map(t => t.function.name).join(", ")}`);
    } else {
      log("No registered tools found. Subagent will work without tools.");
    }
  }

  // 确保 JS API 工具在工具表里（幂等：已注册过会直接返回）
  registerJsApiTool();
  if (s.autoAttachTools) {
    const refreshed = getRegisteredTools();
    if (refreshed.length > tools.length) {
      tools = refreshed;
      log(`Attached ${tools.length} registered tool(s): ${tools.map(t => t.function.name).join(", ")}`);
    }
  }

  try {
    for (let loop = 1; loop <= maxLoops; loop++) {
      if (stopRequested) {
        log("Subagent stopped by user.");
        break;
      }

      log(`Loop ${loop}/${maxLoops}`);

      // 深拷贝后再发请求，避免 ST 内部处理原地改写 messages
      const snapshot = typeof structuredClone === "function"
        ? structuredClone(messages)
        : JSON.parse(JSON.stringify(messages));

      const data = await callSubagentLLM(snapshot, tools);

      // Extract the response
      let content = "";
      let toolCalls = [];

      if (typeof data === "string") {
        content = data;
      } else if (data?.choices?.[0]?.message) {
        const msg = data.choices[0].message;
        content = msg.content || "";
        toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      } else if (data?.content) {
        content = typeof data.content === "string" ? data.content : JSON.stringify(data.content);
      } else if (data?.message?.content) {
        content = data.message.content;
      }

      if (!content && toolCalls.length === 0) {
        log("Empty response from model.");
        break;
      }

      if (toolCalls.length === 0) {
        log(`Subagent finished:
${content}`);
        break;
      }

      log(`Tool calls: ${toolCalls.map(t => t.function?.name).join(", ")}`);

      for (const call of toolCalls) {
        const toolName = call.function?.name;
        let args = {};

        try {
          args = typeof call.function?.arguments === "string"
            ? JSON.parse(call.function.arguments || "{}")
            : (call.function?.arguments || {});
        } catch {
          args = {};
        }

        log(`Invoking tool: ${toolName} with args: ${JSON.stringify(args).substring(0, 200)}`);

        const invocation = await invokeTool(toolName, args);
        const resultText = String(invocation.result ?? "");
        if (invocation.ok) {
          log(`Tool result: ${resultText.substring(0, 500)}`);
        } else {
          log(`Tool ${invocation.kind || "FAILED"}: ${resultText.substring(0, 500)}`);
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        });
      }

      // Push the assistant message with tool calls
      messages.push({
        role: "assistant",
        content: content,
        tool_calls: toolCalls,
      });

    }
  } catch (err) {
    log(`Subagent error: ${err?.message || err}`);
  } finally {
    running = false;
    stopRequested = false;
  }
}

export async function init() {
  createPanel();
  log("Agent & Subagent extension loaded.");
  log(`Registered tools available: ${getRegisteredTools().length}`);
  const jsApiOk = registerJsApiTool();
  log(jsApiOk ? "JS API tool registered (run_js_api)." : "JS API tool not registered (ToolManager unavailable).");
}
