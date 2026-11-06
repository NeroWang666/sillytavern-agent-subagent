const EXTENSION_ID = "agent-subagent";
const SETTINGS_KEY = "agent_subagent_v1";

let running = false;
let stopRequested = false;
let registeredTools = [];
let initialized = false;

const DEFAULT_MAX_LOOPS = 8;
const MAX_LOOPS_CAP = 30;      // maxLoops > 0 时的上限
const ABSOLUTE_LOOP_CAP = 200; // maxLoops = 0（无限制）时的硬上限，防止无限烧 token

/**
 * 归一化最大轮数：0 = 无限制；其他值 clamp 到 1..MAX_LOOPS_CAP。
 * 返回 null 表示"这次输入先忽略"（正在输入的空值 / 非法值），避免覆盖已保存的设置。
 */
function normalizeMaxLoops(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0;
  return Math.min(Math.floor(value), MAX_LOOPS_CAP);
}

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
    collapsed: false,
  };
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

/* ---------------- 多语言：跟随 ST 当前 UI 语言 ---------------- */
// ST 自己的机制（scripts/i18n.js）：getCurrentLocale() / addLocaleData(localeId, data) 只写「当前 locale」且不允许覆盖已有 key（22-39）；
// initLocales() 挂了 MutationObserver（45-61，observe 在 298-303）→ 新插入的 [data-i18n] 元素会被自动翻译；
// translateElement（153-168）只在 localeData 里有值时才写 → 未注册的 key 保留原文（第三种语言优雅回退英文）。
// 切语言 = localStorage 'language' + location.reload()（286-296），所以刷新后本扩展会用新语言重新渲染。
const ASA_I18N = {
  en: {
    asa_label_name: "Subagent Name",
    asa_placeholder_name: "Name shown in the chat status line",
    asa_label_loops: "Max Subagent Loops",
    asa_hint1: "0 = unlimited (keeps looping until it reaches a conclusion or gets stopped; unlimited mode still has a {cap}-round hard cap as a safety net).",
    asa_label_auto_tools: "Auto-attach registered tools to subagent",
    asa_saved_name: "Saved: Subagent Name = {v}",
    asa_saved_loops: "Saved: Max Loops = {v}",
    asa_saved_auto_tools: "Saved: Auto-attach tools = {v}",
    asa_on: "on",
    asa_off: "off",
    asa_unlimited: "unlimited",
    asa_status_running: "running",
    asa_status_done: "done",
    asa_status_stopped: "stopped",
    asa_status_error: "error",
    asa_status_empty: "ended (empty response)",
    asa_status_capped: "ended (hit the {cap}-round hard cap)",
    asa_lbl_task: "Task",
    asa_lbl_status: "Status",
    asa_lbl_final: "Final output",
    asa_lbl_logs: "Log",
    asa_loaded: "Agent & Subagent extension loaded.",
  },
  "zh-cn": {
    asa_label_name: "子 Agent 名称",
    asa_placeholder_name: "显示在聊天状态行里的名字",
    asa_label_loops: "最大子 Agent 轮数",
    asa_hint1: "0 = 无限制（一直循环，直到得出结论或被停止；无限制模式仍有 {cap} 轮硬上限兜底）。",
    asa_label_auto_tools: "自动把已注册工具挂给子 Agent",
    asa_saved_name: "已保存：子 Agent 名称 = {v}",
    asa_saved_loops: "已保存：最大轮数 = {v}",
    asa_saved_auto_tools: "已保存：自动挂工具 = {v}",
    asa_on: "开",
    asa_off: "关",
    asa_unlimited: "无限制",
    asa_status_running: "运行中",
    asa_status_done: "已完成",
    asa_status_stopped: "已停止",
    asa_status_error: "出错",
    asa_status_empty: "结束（空响应）",
    asa_status_capped: "结束（达到 {cap} 轮硬上限）",
    asa_lbl_task: "任务",
    asa_lbl_status: "状态",
    asa_lbl_final: "最终输出",
    asa_lbl_logs: "日志",
    asa_loaded: "Agent & Subagent 扩展已加载。",
  },
  "zh-tw": {
    asa_label_name: "子代理名稱",
    asa_placeholder_name: "顯示在聊天狀態行裡的名字",
    asa_label_loops: "最大子代理輪數",
    asa_hint1: "0 = 無限制（一直迴圈，直到得出結論或被停止；無限制模式仍有 {cap} 輪硬上限兜底）。",
    asa_label_auto_tools: "自動把已註冊工具掛給子代理",
    asa_saved_name: "已儲存：子代理名稱 = {v}",
    asa_saved_loops: "已儲存：最大輪數 = {v}",
    asa_saved_auto_tools: "已儲存：自動掛工具 = {v}",
    asa_on: "開",
    asa_off: "關",
    asa_unlimited: "無限制",
    asa_status_running: "執行中",
    asa_status_done: "已完成",
    asa_status_stopped: "已停止",
    asa_status_error: "錯誤",
    asa_status_empty: "結束（空回應）",
    asa_status_capped: "結束（達到 {cap} 輪硬上限）",
    asa_lbl_task: "任務",
    asa_lbl_status: "狀態",
    asa_lbl_final: "最終輸出",
    asa_lbl_logs: "日誌",
    asa_loaded: "Agent & Subagent 擴充已載入。",
  },
};
let asaI18n = null; // 动态导入的 ST i18n 模块；拿不到就用同一套 locale 公式回退
let asaPack = ASA_I18N.en;

// 与 ST 的 localeFile 公式保持一致（i18n.js:5-6）：localStorage 'language' || navigator.language || 'en'
function asaFallbackLocale() {
  return String(localStorage.getItem("language") || navigator.language || navigator.userLanguage || "en").toLowerCase();
}

// 精确匹配 locale → zh* 归到 zh-cn → 其他一律英文（en.json 是空表，所以英文本来就靠原文回退）
function asaPickPack(locale) {
  const l = String(locale || "").toLowerCase();
  if (ASA_I18N[l]) return ASA_I18N[l];
  if (l.startsWith("zh")) return ASA_I18N["zh-cn"];
  return ASA_I18N.en;
}

async function loadAsaI18n() {
  if (!asaI18n) {
    try { asaI18n = await import(new URL("/scripts/i18n.js", location.origin).href); } catch (e) { asaI18n = null; }
  }
  const locale = typeof asaI18n?.getCurrentLocale === "function"
    ? String(asaI18n.getCurrentLocale() || "").toLowerCase()
    : asaFallbackLocale();
  asaPack = asaPickPack(locale);
  return { i18n: asaI18n, locale };
}

/** 把当前语言的词条写进 ST 的 localeData，这样 [data-i18n] 会被 ST 的 observer 自动翻译。 */
function registerAsaLocaleKeys(locale) {
  if (!asaI18n || typeof asaI18n.addLocaleData !== "function") return false;
  const filled = {}; // hint 文案里的 {cap}/{max} 在注册时就把常量填进去（observer 只会写 textContent，不能运行时替换）
  for (const [key, value] of Object.entries(asaPack)) {
    filled[key] = String(value).replaceAll("{cap}", String(ABSOLUTE_LOOP_CAP)).replaceAll("{max}", String(MAX_LOOPS_CAP));
  }
  try { asaI18n.addLocaleData(locale, filled); } catch (e) {}
  const probeKey = "asa_label_name";
  const ok = typeof asaI18n.translate === "function" ? asaI18n.translate(probeKey) === filled[probeKey] : true;
  // localeData 还没加载完时 addLocaleData 会被丢弃（i18n.js:23-26 的 warn 分支）→ 稍后重试一次
  if (!ok) setTimeout(() => { try { asaI18n.addLocaleData(locale, filled); } catch (e) {} }, 1500);
  return ok;
}

/** 运行时文案（保存提示 / 聊天状态），{v}、{cap} 由调用方填。 */
function asaT(key, subs) {
  let text = asaPack[key] ?? ASA_I18N.en[key] ?? key;
  if (subs) for (const [k, v] of Object.entries(subs)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

/** 状态码 → 本地化状态文案。 */
function asaStatus(code, subs) {
  const map = { running: "asa_status_running", done: "asa_status_done", stopped: "asa_status_stopped", error: "asa_status_error", empty: "asa_status_empty", capped: "asa_status_capped" };
  const key = map[code] || code;
  // cap/max 默认就把常量填进去，免得调用方每个点都要传
  return asaT(key, { cap: ABSOLUTE_LOOP_CAP, max: MAX_LOOPS_CAP, ...(subs || {}) });
}

let panelAttached = false;

function attachPanel(panel) {
  if (panelAttached) return;
  const container = document.querySelector("#extensions_settings");
  if (container) {
    panelAttached = true;
    container.appendChild(panel);
    return true;
  }
  return false;
}

function createPanel() {
  const panel = document.createElement("div");
  panel.id = "agent_subagent_panel";
  panel.classList.add("extension_container");
  panel.style.padding = "10px";

  // ST 标准折叠结构（inline-drawer）：标题在左、箭头在右，样式由 #extensions_settings .inline-drawer-header 提供
  // script.js:12193 有全局 click 委托处理 .inline-drawer-toggle（slideToggle + up/down 图标互换），所以这里只负责初始状态与状态持久化
  // 文案 = 当前语言的原文 + data-i18n（让 ST 的 observer 也认这些 key）。两者语言一致，所以不会互相翻掉。
  panel.innerHTML = `
    <div class="inline-drawer" id="asa_drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Agent &amp; Subagent</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label for="asa_subagent_name" data-i18n="asa_label_name">${asaT("asa_label_name")}</label>
        <input id="asa_subagent_name" type="text" class="text_pole" placeholder="${asaT("asa_placeholder_name")}" data-i18n="[placeholder]asa_placeholder_name" />
        <label for="asa_max_loops" data-i18n="asa_label_loops">${asaT("asa_label_loops")}</label>
        <input id="asa_max_loops" type="number" min="0" step="1" class="text_pole" />
        <div class="asa_hint" style="color:var(--SmartThemeEmColor);font-size:.9em;line-height:1.5;margin:4px 0;">
          <span data-i18n="asa_hint1">${asaT("asa_hint1", { cap: ABSOLUTE_LOOP_CAP })}</span>
        </div>
        <label class="flex-container alignItemsCenter margin0" for="asa_auto_tools">
          <input id="asa_auto_tools" type="checkbox" /> <span data-i18n="asa_label_auto_tools">${asaT("asa_label_auto_tools")}</span>
        </label>
      </div>
    </div>
  `;

  if (!attachPanel(panel)) {
    // 设置页容器还没渲染出来：等它出现后再挂进去（扩展 init 早于设置页 DOM 就绪）
    const tryAttach = () => attachPanel(panel);
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => { if (tryAttach()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 10000);
    }
    // 兜底：10 秒后还没挂上就固定定位显示，避免面板彻底消失
    setTimeout(() => {
      if (!panelAttached) {
        panel.style.position = "fixed";
        panel.style.bottom = "10px";
        panel.style.right = "10px";
        panel.style.zIndex = "9999";
        panel.style.background = "#222";
        panel.style.border = "1px solid #555";
        panel.style.borderRadius = "8px";
        document.body.appendChild(panel);
        panelAttached = true;
      }
    }, 10000);
  }

  const s = getSettings();
  panel.querySelector("#asa_subagent_name").value = s.subagentName || "Subagent";
  panel.querySelector("#asa_max_loops").value = s.maxLoops ?? 8;
  panel.querySelector("#asa_auto_tools").checked = s.autoAttachTools !== false;
  const drawer = panel.querySelector("#asa_drawer");
  const header = panel.querySelector(".inline-drawer-toggle");
  const icon = panel.querySelector(".inline-drawer-icon");
  const content = panel.querySelector(".inline-drawer-content");
  // 初始展开状态：collapsed=true → 收起（图标朝下、内容隐藏），否则展开（图标朝上、内容显示）
  if (drawer && header && icon && content) {
    const collapsed = s.collapsed === true;
    content.style.display = collapsed ? "none" : "block";
    icon.classList.toggle("down", collapsed);
    icon.classList.toggle("fa-circle-chevron-down", collapsed);
    icon.classList.toggle("up", !collapsed);
    icon.classList.toggle("fa-circle-chevron-up", !collapsed);
  }

  const nameInput = panel.querySelector("#asa_subagent_name");
  const loopsInput = panel.querySelector("#asa_max_loops");
  const autoToolsInput = panel.querySelector("#asa_auto_tools");

  // 改完立刻保存（不需要 Save 按钮）
  const commit = (patchObj, note) => {
    const current = getSettings();
    saveSettings({ ...current, ...patchObj });
    if (note) log(note);
  };

  nameInput.addEventListener("change", (e) => {
    const subagentName = String(e.target.value || "").trim() || "Subagent";
    e.target.value = subagentName;
    commit({ subagentName }, asaT("asa_saved_name", { v: subagentName }));
  });

  const saveLoops = (raw, withNote) => {
    const normalized = normalizeMaxLoops(raw);
    if (normalized === null) return; // 空值/非法值先忽略，别覆盖已保存的设置
    const shown = normalized === 0 ? `0（${asaT("asa_unlimited")}）` : String(normalized);
    commit({ maxLoops: normalized }, withNote ? asaT("asa_saved_loops", { v: shown }) : "");
  };
  loopsInput.addEventListener("input", (e) => saveLoops(e.target.value, false));
  loopsInput.addEventListener("change", (e) => {
    const normalized = normalizeMaxLoops(e.target.value);
    if (normalized !== null) e.target.value = String(normalized); // 回写 clamp 后的值
    saveLoops(e.target.value, true);
  });

  autoToolsInput.addEventListener("change", (e) => {
    commit({ autoAttachTools: !!e.target.checked }, asaT("asa_saved_auto_tools", { v: e.target.checked ? asaT("asa_on") : asaT("asa_off") }));
  });

  // 折叠状态持久化：点标题时 ST 的全局 handler（script.js:12193）会 slideToggle + 互换 up/down 图标；
  // 这里按"取反当前状态"直接落盘，避免和 jQuery slideToggle 的动画时序较劲。
  if (header && content) {
    header.addEventListener("click", (e) => {
      if (e.target.classList.contains("text_pole")) return; // 和 ST handler 一样：点在输入框上不算折叠
      const willBeCollapsed = content.style.display !== "none";
      saveSettings({ ...getSettings(), collapsed: willBeCollapsed });
    });
  }
}

function log(text) {
  console.log(`[agent-subagent] ${text}`);
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
        if (!t) return null;
        // 新版 ST 的 FunctionTool 实例没有自有 .name（属性在私有字段/原型上），优先用官方 toFunctionOpenAI()
        if (typeof t.toFunctionOpenAI === "function") {
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
        }
        if (!t.name) return null;
        return {
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.parameters || { type: "object", properties: {} },
          },
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Invoke a registered tool by name using ToolManager.
 */
async function invokeTool(name, args) {
  try {
    const ctx = SillyTavern.getContext();
    if (ctx.ToolManager && typeof ctx.ToolManager.invokeFunctionTool === "function") {
      return await ctx.ToolManager.invokeFunctionTool(name, args);
    }
    return `Tool not found: ${name}`;
  } catch (err) {
    return `Tool error: ${err?.message || err}`;
  }
}

/**
 * Call the LLM using generateRawData to get raw response with tool_calls.
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
    `When you are done, return only the final answer. ` +
    (attachedNames.length > 0
      ? `Your available tools are exactly: ${attachedNames.join(", ")}. ` +
        `You MUST call them directly as function calls with their JSON arguments object — do NOT wrap any of them in a /tools-invoke slash command. ` +
        `Only use /tools-invoke as a last resort for a tool that is NOT in this list; if you must, the parameters JSON must be wrapped in double quotes with inner double quotes escaped. ` +
        `Do NOT call subagent_run or spawn_agents (no recursion). `
      : `You have NO direct tools in this run. Use slash commands (e.g. /tools-invoke parameters="{...}" <tool>) to access functionality; the parameters JSON must be wrapped in double quotes with inner double quotes escaped. ` +
        `Do NOT call subagent_run or spawn_agents (no recursion). ` ) +
    `IMPORTANT tool-calling rules: ` +
    ` (1) Any tool that is already in your function/tool list (e.g. chat_fetch, chat_read, chats_list, chat_stats, worldbook_read, worldbook_write, run_command, run_js_api) MUST be called directly as a function call with its JSON arguments object — do NOT wrap it in a /tools-invoke slash command. ` +
    ` (2) /tools-invoke is only a fallback for tools you can NOT call directly. Its parser splits on spaces, so the parameters JSON must be wrapped in double quotes with the inner double quotes escaped. Correct example: /tools-invoke parameters="{\\\"file_name\\\":\\\"Assistant - 2026-10-01@18h00m37s598ms\\\",\\\"start\\\":0,\\\"limit\\\":10}" chat_fetch. Bare JSON that contains spaces (like a file_name) will be truncated and fail. ` +
    ` (3) Prefer direct function calls; they handle spaces and any JSON value correctly.`;

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

  try {
    for (let loop = 1; loop <= maxLoops; loop++) {
      if (stopRequested) {
        log("Subagent stopped by user.");
        break;
      }

      log(`Loop ${loop}/${maxLoops}`);

      const data = await callSubagentLLM(messages, tools);

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
        log(`Subagent finished:\n${content}`);
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

        const result = await invokeTool(toolName, args);
        log(`Tool result: ${String(result).substring(0, 500)}`);

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: String(result),
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

/* slash 与 jsapi runtime 的加载入口（不依赖全局 st，也不依赖未打包的 runtime-src 源码） */

async function executeAgentSlashCommand(commandText, source) {
  const slashModule = await import("/scripts/slash-commands.js");
  return await slashModule.executeSlashCommandsWithOptions(commandText, typeof source === "string" ? { source } : (source || {}));
}

async function buildStSlashNamespace() {
  try {
    const slashModule = await import("/scripts/slash-commands.js");
    return {
      executeSlashCommandsWithOptions: slashModule.executeSlashCommandsWithOptions,
      getSlashCommandsHelp: slashModule.getSlashCommandsHelp,
      registerSlashCommand: slashModule.registerSlashCommand,
    };
  } catch {
    return {};
  }
}

async function resolveLwbJsApiRuntimeUrl() {
  const assetBase = "/scripts/extensions/third-party/LittleWhiteBox";
  try {
    const buildManifestResponse = await fetch(`${assetBase}/dist/manifest.json`, { cache: "no-cache" });
    if (buildManifestResponse.ok) {
      const buildManifest = await buildManifestResponse.json();
      const entry = buildManifest.entries && buildManifest.entries["runtime/assistant-jsapi"];
      if (entry && entry.file) return `${assetBase}/dist/${entry.file}`;
    }
  } catch {
  }
  return `${assetBase}/modules/assistant/runtime-src/jsapi-runtime.js`;
}

/* run_command + run_js_api：1.5.1 误删，1.5.2 从 v1.5.0 恢复；slash 改走 /scripts/slash-commands.js（旧版依赖的全局 st 本实例不存在），jsapi runtime 改走已打包 dist chunk */
const JSAPI_TOOL_NAME = "run_js_api";
const RUN_COMMAND_TOOL_NAME = "run_command";

function normalizeJsApiOutput(output) {
  if (output === undefined || output === "") return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

async function loadLwbJsApiRuntime() {
  const base = "/scripts/extensions/third-party/LittleWhiteBox/modules/assistant";
  const manifestResponse = await fetch(`${base}/st-jsapi-manifest.json`, { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`jsapi_manifest_load_failed:${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const runtimeUrl = await resolveLwbJsApiRuntimeUrl();
  const runtimeModule = await import(runtimeUrl);
  if (typeof runtimeModule?.runJavaScriptApi !== "function") throw new Error("jsapi_runtime_missing_runJavaScriptApi");
  return { manifest, runtimeModule };
}

async function executeInMinimalSandbox(codeText, stContext, st) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runner = new AsyncFunction(
    "ctx", "st", "JSON", "Math", "Object", "Array", "Date", "String", "Number", "Promise",
    `"use strict";\n${codeText}`
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
    slash: await buildStSlashNamespace(),
  };

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
let runCommandToolRegistered = false;

/** 注册 run_command 工具到 ToolManager（幂等）。执行 slash 命令并返回 pipe 输出。 */
function registerRunCommandTool() {
  if (runCommandToolRegistered) return true;
  try {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.registerFunctionTool !== "function") return false;
    ctx.registerFunctionTool({
      name: RUN_COMMAND_TOOL_NAME,
      displayName: "执行 slash 命令",
      description:
        "执行一条 SillyTavern slash 命令（STscript）并返回执行结果。" +
        "返回对象包含 pipe（命令输出值）、isError、interrupt 等字段。" +
        "示例：/findentry file=新世界书 field=key 苏哲、/getvar name={{char}}、/setentryfield file=新世界书 uid=123 field=content 新内容",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "slash 命令文本，以 / 开头，如 /findentry file=新世界书 field=key 苏哲" },
        },
        required: ["command"],
      },
      action: async ({ command = "" } = {}) => {
        const cmd = String(command || "").trim();
        if (!cmd || !cmd.startsWith("/")) {
          return { ok: false, error: "invalid_command", message: "command 必须以 / 开头的 slash 命令。" };
        }
        try {
          const result = await executeAgentSlashCommand(cmd, "agent-subagent");
          return {
            ok: !result?.isError,
            pipe: result?.pipe || "",
            isError: Boolean(result?.isError),
            interrupt: Boolean(result?.interrupt),
            errorMessage: result?.errorMessage || "",
          };
        } catch (err) {
          return { ok: false, error: "execution_failed", message: err?.message || String(err) };
        }
      },
      formatMessage: ({ command = "" } = {}) => `CMD: ${String(command).slice(0, 100)}`,
      shouldRegister: () => true,
      stealth: false,
    });
    runCommandToolRegistered = true;
    return true;
  } catch (err) {
    console.warn("[agent-subagent] run_command 注册失败:", err?.message || err);
    return false;
  }
}

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

export async function init() {
  if (initialized) return;
  initialized = true;
  // 先拿到当前 UI 语言并注册词条，再渲染面板（这样面板里的 [data-i18n] 也能被 ST 的 observer 翻译）
  const { locale } = await loadAsaI18n();
  const localeRegistered = registerAsaLocaleKeys(locale);
  createPanel();
  const cmdOk = registerRunCommandTool();
  log(cmdOk ? "run_command tool registered." : "run_command tool not registered (ToolManager unavailable).");
  const jsApiOk = registerJsApiTool();
  log(jsApiOk ? "JS API tool registered (run_js_api)." : "JS API tool not registered (ToolManager unavailable).");
  log(asaT("asa_loaded") + ` (locale=${locale}, i18n=${asaI18n ? "ok" : "fallback"}, keys=${localeRegistered ? "registered" : "self-rendered only"})`);
  log(`Registered tools available: ${getRegisteredTools().length}`);
}

// ST 通过 manifest.hooks.activate（这里映射到导出的 init）调用扩展入口；若宿主不走 hooks，模块加载后自调用一次。
// initialized 标志保证两种路径都命中时也只会初始化一次。
Promise.resolve().then(() => init()).catch((e) => console.error("[agent-subagent] 自调用 init 失败:", e));
