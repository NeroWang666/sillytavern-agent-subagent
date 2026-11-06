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
  el.textContent += `[${time}] ${text}\n`;
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
      .filter(t => t && t.name)
      .map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
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
  createPanel();
  log("Agent & Subagent extension loaded.");
  log(`Registered tools available: ${getRegisteredTools().length}`);
}
