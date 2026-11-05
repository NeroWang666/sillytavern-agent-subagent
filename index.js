const EXTENSION_ID = "agent-subagent";
const SETTINGS_KEY = "agent_subagent_v1";

let running = false;
let stopRequested = false;

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
    <label><input id="asa_auto_tools" type="checkbox" /> Auto-attach ST.functions to subagent</label>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button id="asa_save" class="menu_button">Save</button>
      <button id="asa_run" class="menu_button">Run Subagent</button>
      <button id="asa_stop" class="menu_button">Stop</button>
    </div>
    <pre id="asa_log" style="margin-top:8px;white-space:pre-wrap;max-height:280px;overflow:auto;background:#111;padding:8px;border-radius:6px;"></pre>
  `;

  document.querySelector("#extensions_settings")?.appendChild(panel);

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
    const lastUser = ST?.chat?.[ST.chat.length - 1];
    const task = lastUser?.is_user ? lastUser.mes : s.lastTask || "Continue the current task using tools.";
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

async function callSubagentLLM(messages, tools) {
  if (typeof generateRaw !== "function") {
    throw new Error("generateRaw is not available in this SillyTavern version.");
  }

  const resp = await generateRaw({
    messages,
    tools,
    stream: false,
  });

  return resp;
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

  if (s.autoAttachTools && Array.isArray(ST?.functions)) {
    tools = ST.functions
      .filter((f) => f && f.name && typeof f.fn === "function")
      .map((f) => ({
        type: "function",
        function: {
          name: f.name,
          description: f.description || "",
          parameters: f.parameters || { type: "object", properties: {} },
        },
      }));
  }

  try {
    for (let loop = 1; loop <= maxLoops; loop++) {
      if (stopRequested) {
        log("Subagent stopped by user.");
        break;
      }

      log(`Loop ${loop}/${maxLoops}`);

      const resp = await callSubagentLLM(messages, tools);
      const message = resp?.choices?.[0]?.message;

      if (!message) {
        log("Empty response from model.");
        break;
      }

      messages.push(message);

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length === 0) {
        const finalAnswer = message.content || "(no output)";
        log(`Subagent finished:\n${finalAnswer}`);
        break;
      }

      log(`Tool calls: ${toolCalls.map((t) => t.function?.name).join(", ")}`);

      for (const call of toolCalls) {
        const toolName = call.function?.name;
        let args = {};

        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }

        const toolDef = Array.isArray(ST?.functions)
          ? ST.functions.find((f) => f.name === toolName)
          : null;

        let result = "";

        if (toolDef && typeof toolDef.fn === "function") {
          try {
            result = String(await toolDef.fn(args));
          } catch (err) {
            result = `Tool error: ${err?.message || err}`;
          }
        } else {
          result = `Tool not found: ${toolName}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
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
}