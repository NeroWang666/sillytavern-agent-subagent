# Agent & Subagent — SillyTavern extension

Adds an autonomous **subagent loop** to SillyTavern: a small agent that takes a task, calls the function tools that are already registered in your instance, iterates round by round until it reaches a conclusion, and writes its progress into the current chat as a collapsible system line. It also registers two function tools for the main agent: `run_command` (execute one slash command and get its pipe output) and `run_js_api` (run restricted JavaScript against the public SillyTavern frontend API).

## Requirements

- SillyTavern with a **Chat Completion** backend configured. The subagent posts to `/api/backends/chat-completions/generate` with an explicit `tools` array plus `tool_choice: "auto"`, so your model/source must support function calling.
- **No third-party extension is required.** Everything this extension touches is SillyTavern core: `SillyTavern.getContext()`, `ctx.registerFunctionTool` and `ctx.ToolManager.invokeFunctionTool` (`scripts/tool-calling.js:269` / `:325`), `ctx.chatCompletionSettings` + `ctx.getRequestHeaders()` + `ctx.getChatCompletionModel()`, `ctx.chat` / `ctx.addOneMessage` / `ctx.saveChat()`, `/scripts/slash-commands.js` (`executeSlashCommandsWithOptions`), `/scripts/i18n.js`, and the standard settings-panel DOM/CSS (`#extensions_settings`, `inline-drawer`, `.text_pole`).

## Install

SillyTavern → **Extensions → Install extension** → paste this repository URL → install → refresh. Or clone into `extensions/sillytavern-agent-subagent/`.

## Settings (Extension Settings panel, collapsible)

- **Subagent Name** — the label shown in the chat status line.
- **Max Subagent Loops** — `0` = unlimited (keeps looping until it concludes or gets stopped; unlimited mode still has a 200-round hard cap as a safety net). Other values clamp to 1–30.
- **Auto-attach registered tools to subagent** — attach every currently registered function tool to the subagent's tool list. `subagent_run` and `spawn_agents` are always excluded so the subagent cannot recursively spawn itself.

There are no Save / Run / Stop buttons: every change is written immediately to the localStorage key `agent_subagent_v1`, and the collapsed state of the panel is persisted there too.

## Internationalization

Panel labels, hints and chat status text follow SillyTavern's current UI language using ST's own i18n mechanism (`/scripts/i18n.js`: `getCurrentLocale()` + `addLocaleData()`, plus `[data-i18n]` elements that ST's MutationObserver translates automatically). Bundles included: English, Simplified Chinese (zh-cn), Traditional Chinese (zh-tw). Any other language falls back to English.

## Known limitations in 1.5.1 (measured, not guesses)

1. **There is currently no built-in trigger for the subagent loop.** `runSubagent()` is module-private and not exported, and there is no Run button, no slash command and no registered `subagent_run` function tool. Installing this extension therefore gives you the two tools above plus the settings panel, while the loop engine itself stays inert until something calls it — in practice, until you add a trigger yourself.
2. **The chat status line can render as literal HTML source.** It pushes a `<details>` block using `name: ctx.name2`; SillyTavern forces `isSystem = false` whenever a message name is not its own `systemUserName` (`SillyTavern System`, see `script.js:405` and `script.js:1822`) and then escapes HTML through `encode_tags` (`script.js:1875`), so on most personas the markup shows up as text instead of a collapsible block.
3. **In-place DOM updates do not work.** The code targets `#mes_<id>`, but current SillyTavern renders `.mes` blocks without `id` / `data-message-id` (they carry `mesid` = chat index), so the status line becomes visible after a re-render/save rather than updating round by round.
4. **The Stop button does not interrupt it.** There is no subscription to `generation_stopped` (`script.js:5607 stopGeneration()` aborts and emits it; `scripts/events.js:24`) and `stopRequested` has no setter, so a running loop keeps going until it concludes or hits the round cap.
5. Full `run_js_api` validation depends on LittleWhiteBox (see Requirements).

## Changelog

### 1.5.1

- manifest now declares `"js": "index.js"` and `"hooks": { "activate": "init" }`. Without `js`, SillyTavern's loader returns early (`scripts/extensions.js:813-816`), which is exactly why 1.4.x and 1.5.0 never loaded their own JS.
- `init()` is guarded by an `initialized` flag and has a self-invoke fallback for hosts that do not call hooks.
- Settings panel rewritten as ST's standard `inline-drawer` (title left, chevron right like every other extension); inputs use `.text_pole` so they follow the theme instead of rendering white; each label sits on its own line; the log box and the Save/Run/Stop buttons are gone; changes save instantly; collapsed state persists.
- Max Loops: `0` = unlimited with a 200-round hard cap; empty or invalid input is ignored instead of overwriting the saved value.
- Panel and chat status text localized (en / zh-cn / zh-tw) through ST's i18n.
- `run_command` imports `/scripts/slash-commands.js` by absolute URL so it resolves regardless of which base this module was loaded from, and normalizes the slash pipe output to a string.

### 1.5.0

- Chat status message, tool whitelist (`subagent_run` / `spawn_agents` excluded), direct function-calling guidance in the subagent system prompt.
