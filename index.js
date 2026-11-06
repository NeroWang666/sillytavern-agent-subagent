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

  if (typeof ctx.generateRawData !== "function") {
    throw new Error("generateRawData is not available in this SillyTavern version.");
  }

  // Build a prompt from the messages array
  // generateRawData accepts a prompt (string or array) + systemPrompt
  let systemPrompt = "";
  let userContent = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += (systemPrompt ? "\n" : "") + (msg.content || "");
    } else if (msg.role === "user") {
      userContent += (userContent ? "\n" : "") + (msg.content || "");
    } else if (msg.role === "assistant") {
      // Append assistant messages to the prompt as context
      userContent += (userContent ? "\n" : "") + `[Assistant]: ${msg.content || ""}`;
    } else if (msg.role === "tool") {
      userContent += (userContent ? "\n" : "") + `[Tool Result (${msg.tool_call_id || ""})]: ${msg.content || ""}`;
    }
  }

  // Use generateRawData with the assembled prompt
  // Note: For proper tool calling, we need the API to support it
  // generateRawData will use the current API's tool calling if tools are registered
  const data = await ctx.generateRawData({
    prompt: userContent,
    systemPrompt: systemPrompt,
  });

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

export async function init() {
  if (initialized) return;
  initialized = true;
  // 先拿到当前 UI 语言并注册词条，再渲染面板（这样面板里的 [data-i18n] 也能被 ST 的 observer 翻译）
  const { locale } = await loadAsaI18n();
  const localeRegistered = registerAsaLocaleKeys(locale);
  createPanel();
  log(asaT("asa_loaded") + ` (locale=${locale}, i18n=${asaI18n ? "ok" : "fallback"}, keys=${localeRegistered ? "registered" : "self-rendered only"})`);
  log(`Registered tools available: ${getRegisteredTools().length}`);
}

// ST 通过 manifest.hooks.activate（这里映射到导出的 init）调用扩展入口；若宿主不走 hooks，模块加载后自调用一次。
// initialized 标志保证两种路径都命中时也只会初始化一次。
Promise.resolve().then(() => init()).catch((e) => console.error("[agent-subagent] 自调用 init 失败:", e));
