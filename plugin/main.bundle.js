(function(){
const __nativeRequire = typeof require === "function" ? require : null;
const __modules = {
"./shared": function(module, exports, require) {
const fs = require("fs");
const path = require("path");

const VIEW_TYPE_CODEX_AGENT = "codex-agent-sidebar";
const PLUGIN_VERSION = "0.2.0";

const ACTIONS = {
  chat: {
    label: "提问",
    hint: "就当前笔记、整个库或当前选中文本向 Codex 提问。",
    placeholder: "输入你想让 Codex 回答的问题...",
  },
  rewrite: {
    label: "改写",
    hint: "返回当前选中文本的替换内容。",
    placeholder: "描述你希望如何改写选中文本...",
  },
  summarize: {
    label: "总结",
    hint: "将当前笔记整理成一篇精简摘要。",
    placeholder: "可选：补充摘要要求...",
  },
  create_note: {
    label: "新建笔记",
    hint: "结合当前笔记上下文生成一篇新笔记。",
    placeholder: "描述你想让 Codex 创建的笔记...",
  },
};

const CONTEXT_MODES = {
  "note+selection": "笔记 + 选中内容",
  note: "当前笔记",
  selection: "仅选中内容",
  none: "不使用笔记上下文",
};

const RUNNER_MODES = {
  cli: "直接 CLI",
  bridge: "桥接服务",
};

const SANDBOX_MODES = {
  "read-only": "只读",
  "workspace-write": "工作区可写",
  "danger-full-access": "完全访问",
};

const REASONING_EFFORTS = {
  low: "低",
  medium: "中",
  high: "高",
};

const DEFAULT_SETTINGS = {
  runnerMode: "cli",
  codexCliPath: "",
  codexModel: "gpt-5-codex",
  codexReasoningEffort: "high",
  codexSandbox: "read-only",
  codexTimeoutSec: 600,
  bridgeUrl: "http://127.0.0.1:8765",
  bridgeToken: "",
  createNoteFolder: "Codex",
  openSidebarOnRun: true,
  defaultSummaryInstruction: "请将这篇笔记整理成便于快速回顾的摘要。",
};

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function sanitizeFileName(value) {
  const cleaned = String(value || "")
    .replace(/^#+\s*/, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "Codex 笔记";
  }

  return cleaned.slice(0, 80);
}

function formatTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function deriveTitleFromContent(content, fallbackTitle) {
  const headingMatch = String(content || "").match(/^#\s+(.+)$/m);
  if (headingMatch && headingMatch[1]) {
    return sanitizeFileName(headingMatch[1]);
  }

  const firstLine = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return sanitizeFileName(firstLine || fallbackTitle || `Codex 笔记 ${formatTimestamp()}`);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function normalizeExecutablePath(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }
  return value.replace(/^"(.*)"$/, "$1");
}

function resolveNodeExecutable() {
  if (process.platform !== "win32") {
    return "node";
  }

  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node.exe"));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, "nodejs", "node.exe"));
  }
  if (process.env["ProgramFiles(x86)"]) {
    candidates.push(path.join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe"));
  }
  candidates.push("node");

  for (const candidate of candidates) {
    if (candidate === "node" || fileExists(candidate)) {
      return candidate;
    }
  }

  return "node";
}

function resolveCodexLauncher(customPath) {
  const explicitPath = normalizeExecutablePath(customPath);
  if (explicitPath) {
    if (/\.ps1$/i.test(explicitPath)) {
      throw new Error("这里不要使用 codex.ps1。请改用 codex.js、codex.exe，或留空让插件自动检测。");
    }

    if (/\.js$/i.test(explicitPath)) {
      return {
        command: resolveNodeExecutable(),
        args: [explicitPath],
        displayPath: explicitPath,
      };
    }

    return {
      command: explicitPath,
      args: [],
      displayPath: explicitPath,
    };
  }

  if (process.platform === "win32" && process.env.APPDATA) {
    const scriptPath = path.join(
      process.env.APPDATA,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js"
    );
    if (fileExists(scriptPath)) {
      return {
        command: resolveNodeExecutable(),
        args: [scriptPath],
        displayPath: scriptPath,
      };
    }
  }

  if (process.platform !== "win32") {
    return {
      command: "codex",
      args: [],
      displayPath: "codex",
    };
  }

  throw new Error(
    "未能自动检测到 Codex CLI。请在插件设置中把“Codex CLI 路径”指向本机的 codex.js 文件。"
  );
}

function formatHeadings(headings) {
  if (!Array.isArray(headings) || headings.length === 0) {
    return "没有标题元数据。";
  }

  const lines = [];
  for (const item of headings) {
    const heading = String(item?.heading || "").trim();
    const level = Number(item?.level || 0);
    if (!heading) {
      continue;
    }
    lines.push(`${"#".repeat(Math.max(level, 1))} ${heading}`);
  }

  return lines.length ? lines.join("\n") : "没有标题元数据。";
}

function formatNoteContext(note) {
  if (!note) {
    return "未提供当前活动笔记。";
  }

  const parts = [
    `标题: ${note.title || "(未知)"}`,
    `路径: ${note.path || "(未知)"}`,
  ];

  if (note.frontmatter) {
    parts.push(`Frontmatter:\n${JSON.stringify(note.frontmatter, null, 2)}`);
  } else {
    parts.push("Frontmatter:\n(无)");
  }

  parts.push(`标题结构:\n${formatHeadings(note.headings || [])}`);
  parts.push(`完整笔记内容:\n${note.content || "(空笔记)"}`);
  return parts.join("\n\n");
}

function formatSelection(selection) {
  return String(selection || "").trim() || "(未提供选中内容)";
}

function buildPrompt(action, instruction, payload, vaultPath) {
  const noteBlock = formatNoteContext(payload.note);
  const selectionBlock = formatSelection(payload.selection);
  const vaultBlock = `库根目录: ${vaultPath || "(未知)"}`;

  if (action === "chat") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "你当前由桌面版 Obsidian 插件调用。仓库根目录就是你的工作目录。",
      "在相关时使用提供的笔记上下文；如果有助于回答问题，也可以查看库中的其他文件。",
      "默认使用中文回答，除非用户明确要求其他语言。",
      "只返回 Markdown，不要把整个回答包在代码块里。",
      "",
      vaultBlock,
      "",
      `用户请求:\n${instruction}`,
      "",
      `选中内容:\n${selectionBlock}`,
      "",
      `当前笔记:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "rewrite") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "请根据用户要求改写选中的文本。",
      "默认使用中文输出，除非用户明确要求其他语言。",
      "只返回改写后的替换文本。",
      "除非用户明确要求，否则请保留 Markdown、链接和事实信息。",
      "",
      vaultBlock,
      "",
      `改写要求:\n${instruction}`,
      "",
      `选中内容:\n${selectionBlock}`,
      "",
      `所在笔记上下文:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "summarize") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "请基于提供的笔记生成一篇精炼、可独立阅读的 Markdown 摘要笔记。",
      "默认使用中文输出，除非用户明确要求其他语言。",
      "使用一级标题，并让摘要适合后续复习回顾。",
      "",
      vaultBlock,
      "",
      `摘要要求:\n${instruction || DEFAULT_SETTINGS.defaultSummaryInstruction}`,
      "",
      `当前笔记:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "create_note") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "请根据用户请求和提供的上下文起草一篇新的 Markdown 笔记。",
      "默认使用中文输出，除非用户明确要求其他语言。",
      "只返回笔记正文，并以一级标题开头。",
      "",
      vaultBlock,
      "",
      `新笔记需求:\n${instruction}`,
      "",
      `选中内容:\n${selectionBlock}`,
      "",
      `参考笔记上下文:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  return instruction;
}

function normalizeRunnerError(detail) {
  const text = String(detail || "").trim();
  if (!text) {
    return "Codex 返回了空错误信息。";
  }

  if (text.includes("Token data is not available")) {
    return "当前环境中的 Codex CLI 尚未完成认证。请先在普通终端执行 `codex login`。";
  }

  if (text.includes("Unsupported value: 'xhigh'") && text.includes("reasoning.effort")) {
    return "你的全局 Codex 配置把推理强度设成了 `xhigh`，但当前模型不支持。插件会覆盖这个值，但你仍可能需要把外部 Codex 环境里的 `model_reasoning_effort` 改成 `\"high\"`。";
  }

  if (text.includes("Not inside a trusted directory")) {
    return "Codex 把当前目录判定为未信任目录。插件已经附带 `--skip-git-repo-check`，所以这通常意味着 CLI 实际调用参数不符合预期。";
  }

  if (text.includes("spawn") && text.includes("ENOENT")) {
    return "未找到 Codex CLI。请检查插件里的“Codex CLI 路径”设置。";
  }

  if (text.includes("Access is denied") || text.includes("拒绝访问")) {
    return "Codex 无法访问所需的本地路径。请不要使用 `codex.ps1`，改用 `codex.js`，或让插件自动检测 CLI。";
  }

  return text;
}

function makeMessageId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  ACTIONS,
  CONTEXT_MODES,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
  REASONING_EFFORTS,
  RUNNER_MODES,
  SANDBOX_MODES,
  VIEW_TYPE_CODEX_AGENT,
  buildPrompt,
  deriveTitleFromContent,
  fileExists,
  formatTimestamp,
  makeMessageId,
  normalizeRunnerError,
  resolveCodexLauncher,
  safeJsonParse,
  sanitizeFileName,
  trimTrailingSlash,
};

},
"./runtime": function(module, exports, require) {
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_SETTINGS,
  buildPrompt,
  fileExists,
  normalizeRunnerError,
  resolveCodexLauncher,
} = require("./shared");

function spawnProcess(command, args, options) {
  const timeoutMs = Math.max(Number(options.timeoutMs || 0), 0);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(() => {
              try {
                child.kill();
              } catch (_error) {
                // ignore
              }
              reject(new Error(`Codex 运行超过 ${Math.round(timeoutMs / 1000)} 秒，已超时。`));
            });
          }, timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code, signal) => {
      finish(() => resolve({ code, signal, stdout, stderr }));
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function buildCodexExecArgs(plugin, outputPath) {
  const args = [
    "exec",
    "-",
    "--model",
    plugin.settings.codexModel,
    "--color",
    "never",
    "--skip-git-repo-check",
    "--output-last-message",
    outputPath,
    "-c",
    `model_reasoning_effort="${plugin.settings.codexReasoningEffort}"`,
  ];

  if (plugin.settings.codexSandbox) {
    args.push("--sandbox", plugin.settings.codexSandbox);
  }

  return args;
}

async function runCliTask(plugin, payload) {
  const launcher = resolveCodexLauncher(plugin.settings.codexCliPath);
  const vaultPath = plugin.getVaultBasePath();
  if (!vaultPath) {
    throw new Error("无法解析当前库的本地路径。");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-codex-"));
  const outputPath = path.join(tempDir, "last-message.txt");
  const prompt = buildPrompt(payload.action, payload.instruction, payload, vaultPath);
  const args = launcher.args.concat(buildCodexExecArgs(plugin, outputPath));
  const startedAt = Date.now();

  try {
    const result = await spawnProcess(launcher.command, args, {
      cwd: vaultPath,
      env: { ...process.env },
      input: prompt,
      timeoutMs: Number(plugin.settings.codexTimeoutSec || DEFAULT_SETTINGS.codexTimeoutSec) * 1000,
    });

    const outputText = fileExists(outputPath)
      ? fs.readFileSync(outputPath, "utf8").trim()
      : "";

    if (result.code !== 0) {
      const detail = normalizeRunnerError(result.stderr || result.stdout || `Codex exited with status ${result.code}.`);
      throw new Error(detail);
    }

    const finalText = outputText || String(result.stdout || "").trim();
    if (!finalText) {
      throw new Error("Codex 返回了空结果。");
    }

    return {
      result: finalText,
      meta: {
        action: payload.action,
        model: plugin.settings.codexModel,
        elapsed_ms: Date.now() - startedAt,
        runner: "直接 CLI",
        launcher: launcher.displayPath,
      },
    };
  } catch (error) {
    throw new Error(normalizeRunnerError(error?.message || String(error)));
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_error) {
      // ignore cleanup failures
    }
  }
}

async function checkCliRunner(plugin) {
  const launcher = resolveCodexLauncher(plugin.settings.codexCliPath);
  const result = await spawnProcess(launcher.command, launcher.args.concat(["--version"]), {
    cwd: plugin.getVaultBasePath() || process.cwd(),
    env: { ...process.env },
    input: "",
    timeoutMs: 15000,
  });

  if (result.code !== 0) {
    throw new Error(normalizeRunnerError(result.stderr || result.stdout || "Codex 版本检查失败。"));
  }

  const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "Codex CLI";
  return {
    mode: "直接 CLI",
    version,
    launcher: launcher.displayPath,
  };
}

module.exports = {
  checkCliRunner,
  runCliTask,
};

},
"./view": function(module, exports, require) {
const {
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  setIcon,
} = require("obsidian");
const {
  ACTIONS,
  CONTEXT_MODES,
  RUNNER_MODES,
  VIEW_TYPE_CODEX_AGENT,
  makeMessageId,
} = require("./shared");

async function renderMarkdownInto(component, app, markdown, container, sourcePath) {
  if (typeof MarkdownRenderer.renderMarkdown === "function") {
    await MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component);
    return;
  }

  if (typeof MarkdownRenderer.render === "function") {
    await MarkdownRenderer.render(app, markdown, container, sourcePath, component);
    return;
  }

  container.setText(markdown);
}

class CodexInputModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.resolver = null;
  }

  ask() {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  submit(value) {
    const resolve = this.resolver;
    this.resolver = null;
    this.close();
    if (resolve) {
      resolve(value);
    }
  }

  onOpen() {
    const { contentEl } = this;
    const {
      title,
      description,
      placeholder,
      value,
      submitText,
      allowEmpty,
      lines,
    } = this.options;

    const commit = () => {
      const rawValue = inputEl.value.trim();
      if (!allowEmpty && !rawValue) {
        new Notice("请输入内容。");
        return;
      }
      this.submit(rawValue);
    };

    contentEl.empty();
    contentEl.addClass("codex-agent-modal");
    contentEl.createEl("h2", { text: title });

    if (description) {
      contentEl.createEl("p", {
        text: description,
        cls: "codex-agent-modal-copy",
      });
    }

    const inputEl = contentEl.createEl("textarea", {
      cls: "codex-agent-modal-input",
    });
    inputEl.rows = lines || 8;
    inputEl.placeholder = placeholder || "";
    inputEl.value = value || "";
    inputEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });

    const actionsEl = contentEl.createDiv({ cls: "codex-agent-modal-actions" });
    const submitButton = actionsEl.createEl("button", {
      text: submitText || "执行",
      cls: "mod-cta",
    });
    submitButton.addEventListener("click", commit);

    const cancelButton = actionsEl.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.submit(null));

    window.setTimeout(() => inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(null);
    }
  }
}

class CodexAgentView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderToken = 0;
    this.transcriptEl = null;
    this.state = {
      action: "chat",
      contextMode: "note+selection",
      instruction: "",
      busy: false,
      messages: [],
      runnerInfo: "",
      lastError: "",
      controlsExpanded: false,
      resultActionsExpandedId: "",
    };
  }

  getViewType() {
    return VIEW_TYPE_CODEX_AGENT;
  }

  getDisplayText() {
    return "Codex 助手";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.plugin.sidebarView = this;
    this.render();
  }

  async onClose() {
    if (this.plugin.sidebarView === this) {
      this.plugin.sidebarView = null;
    }
  }

  setRunnerInfo(text) {
    this.state.runnerInfo = text || "";
    this.render();
  }

  clearTranscript() {
    this.state.messages = [];
    this.state.lastError = "";
    this.state.resultActionsExpandedId = "";
    this.render();
  }

  beginTask({ action, contextMode, instruction }) {
    const userId = makeMessageId();
    const assistantId = makeMessageId();

    this.state.action = action;
    this.state.contextMode = contextMode;
    this.state.busy = true;
    this.state.lastError = "";
    this.state.resultActionsExpandedId = "";

    this.state.messages.push({
      id: userId,
      role: "user",
      action,
      contextMode,
      text: instruction || ACTIONS[action].hint,
      meta: null,
      pending: false,
      error: false,
    });

    this.state.messages.push({
      id: assistantId,
      role: "assistant",
      action,
      contextMode,
      text: "",
      meta: null,
      pending: true,
      error: false,
    });

    this.render();
    return { userId, assistantId };
  }

  finishTask(taskHandle, response) {
    const message = this.state.messages.find((item) => item.id === taskHandle.assistantId);
    if (message) {
      message.text = response.result || "";
      message.meta = response.meta || null;
      message.pending = false;
      message.error = false;
    }
    this.state.busy = false;
    this.state.lastError = "";
    this.render();
  }

  failTask(taskHandle, error) {
    const message = this.state.messages.find((item) => item.id === taskHandle.assistantId);
    if (message) {
      message.text = error?.message || String(error);
      message.meta = null;
      message.pending = false;
      message.error = true;
    }
    this.state.busy = false;
    this.state.lastError = error?.message || String(error);
    this.render();
  }

  getLatestAssistantMessage() {
    return [...this.state.messages]
      .reverse()
      .find((message) => message.role === "assistant" && !message.pending && !message.error);
  }

  async runCurrentAction() {
    const action = this.state.action;
    const rawInstruction = this.state.instruction.trim();
    const instruction =
      action === "summarize"
        ? rawInstruction || this.plugin.settings.defaultSummaryInstruction
        : rawInstruction;

    if (!instruction && action !== "summarize") {
      new Notice("请输入提示内容。");
      return;
    }

    try {
      await this.plugin.executeTask({
        action,
        instruction,
        contextMode: this.state.contextMode,
        openSidebar: true,
      });
      if (action !== "chat") {
        this.state.instruction = "";
      }
    } catch (error) {
      new Notice(error?.message || String(error));
    }
  }

  renderChipGroup(parent, label, options, activeValue, onSelect) {
    const group = parent.createDiv({ cls: "codex-agent-chip-group" });
    group.createEl("div", {
      text: label,
      cls: "codex-agent-chip-label",
    });
    const row = group.createDiv({ cls: "codex-agent-chip-row" });
    Object.entries(options).forEach(([key, text]) => {
      const button = row.createEl("button", {
        text,
        cls: key === activeValue ? "codex-agent-chip is-active" : "codex-agent-chip",
      });
      button.disabled = this.state.busy;
      button.addEventListener("click", () => onSelect(key));
    });
  }

  renderDisclosureButton(parent, label, expanded, onClick) {
    const button = parent.createEl("button", {
      cls: "codex-agent-disclosure-button",
    });
    const icon = button.createSpan({ cls: "codex-agent-disclosure-icon" });
    setIcon(icon, expanded ? "chevron-up" : "chevron-down");
    button.createSpan({ text: label });
    button.addEventListener("click", onClick);
    return button;
  }

  renderContextStrip(parent) {
    const summary = this.plugin.getContextSummary();
    const strip = parent.createDiv({ cls: "codex-agent-context-strip" });

    const createBadge = (label, tone) => {
      const badge = strip.createDiv({
        cls: `codex-agent-context-badge ${tone ? `is-${tone}` : ""}`.trim(),
      });
      badge.setText(label);
    };

    createBadge(RUNNER_MODES[this.plugin.settings.runnerMode] || "运行器", "runner");
    createBadge(this.plugin.settings.codexModel, "model");
    if (summary.noteTitle) {
      createBadge(summary.noteTitle, "note");
    } else {
      createBadge("当前无笔记", "muted");
    }
    createBadge(summary.selectionText, summary.selectionLength > 0 ? "selection" : "muted");
  }

  async renderMessages(container, token) {
    container.empty();
    const messages = this.state.messages;

    if (messages.length === 0) {
      const empty = container.createDiv({ cls: "codex-agent-empty" });
      empty.createEl("div", { text: "开始新请求", cls: "codex-agent-empty-title" });
      return;
    }

    const latestAssistant = this.getLatestAssistantMessage();
    const sourcePath = this.plugin.getMarkdownView()?.file?.path || "";

    for (const message of messages) {
      if (token !== this.renderToken) {
        return;
      }

      const card = container.createDiv({
        cls: [
          "codex-agent-message",
          `is-${message.role}`,
          message.pending ? "is-pending" : "",
          message.error ? "is-error" : "",
        ].filter(Boolean).join(" "),
      });

      const header = card.createDiv({ cls: "codex-agent-message-header" });
      const left = header.createDiv({ cls: "codex-agent-message-left" });
      left.createEl("span", {
        text: message.role === "user" ? "你" : message.error ? "错误" : "Codex",
        cls: "codex-agent-role",
      });
      left.createEl("span", {
        text: ACTIONS[message.action]?.label || message.action,
        cls: "codex-agent-tag",
      });
      left.createEl("span", {
        text: CONTEXT_MODES[message.contextMode] || message.contextMode,
        cls: "codex-agent-tag is-muted",
      });

      const right = header.createDiv({ cls: "codex-agent-message-right" });
      if (message.pending) {
        const spinner = right.createDiv({ cls: "codex-agent-spinner" });
        setIcon(spinner, "loader-2");
        right.createSpan({ text: "执行中..." });
      } else if (message.meta?.runner) {
        right.createSpan({ text: `${message.meta.runner} · ${message.meta.elapsed_ms} 毫秒` });
      }

      const body = card.createDiv({ cls: "codex-agent-message-body" });
      if (message.pending) {
        body.createEl("p", {
          text: "Codex 正在处理中...",
          cls: "codex-agent-pending-copy",
        });
      } else if (message.error) {
        body.createEl("pre", {
          text: message.text,
          cls: "codex-agent-plain-text",
        });
      } else if (message.role === "assistant") {
        await renderMarkdownInto(this, this.app, message.text || "", body, sourcePath);
      } else {
        body.createEl("pre", {
          text: message.text,
          cls: "codex-agent-plain-text",
        });
      }

      if (latestAssistant && latestAssistant.id === message.id && !message.pending && !message.error) {
        const expanded = this.state.resultActionsExpandedId === message.id;
        const resultShell = card.createDiv({ cls: "codex-agent-result-shell" });
        const resultHeader = resultShell.createDiv({ cls: "codex-agent-disclosure-row" });
        const resultCopy = resultHeader.createDiv({ cls: "codex-agent-disclosure-copy-wrap" });
        resultCopy.createEl("div", {
          text: "结果操作",
          cls: "codex-agent-disclosure-title",
        });

        this.renderDisclosureButton(
          resultHeader,
          expanded ? "收起" : "展开",
          expanded,
          () => {
            this.state.resultActionsExpandedId = expanded ? "" : message.id;
            this.render();
          }
        );

        if (expanded) {
          const actions = resultShell.createDiv({ cls: "codex-agent-result-actions" });
          const buttons = [
            {
              text: "复制",
              onClick: () => this.plugin.copyToClipboard(message.text),
            },
            {
              text: "插入",
              onClick: () => this.plugin.insertAtCursor(message.text),
            },
            {
              text: "替换",
              onClick: () => this.plugin.replaceSelection(message.text),
            },
            {
              text: "追加",
              onClick: () => this.plugin.appendToCurrentNote(message.text),
            },
            {
              text: "新建笔记",
              onClick: () => this.plugin.createNoteFromContent(message.text),
            },
          ];

          buttons.forEach(({ text, onClick }) => {
            const button = actions.createEl("button", { text });
            button.disabled = this.state.busy;
            button.addEventListener("click", async () => {
              try {
                await onClick();
              } catch (error) {
                new Notice(error?.message || String(error));
              }
            });
          });
        }
      }
    }

    window.requestAnimationFrame(() => {
      if (this.transcriptEl) {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      }
    });
  }

  render() {
    const { contentEl } = this;
    const actionConfig = ACTIONS[this.state.action];
    this.renderToken += 1;
    const token = this.renderToken;

    contentEl.empty();
    contentEl.addClass("codex-agent-view");

    const shell = contentEl.createDiv({ cls: "codex-agent-shell" });
    const hero = shell.createDiv({ cls: "codex-agent-hero" });
    const heroTitle = hero.createDiv({ cls: "codex-agent-hero-title" });
    const logo = heroTitle.createDiv({ cls: "codex-agent-logo" });
    setIcon(logo, "bot");
    const titleBlock = heroTitle.createDiv({ cls: "codex-agent-title-block" });
    titleBlock.createEl("h2", { text: "Codex 助手" });

    const heroActions = hero.createDiv({ cls: "codex-agent-hero-actions" });
    const buttons = [
      {
        icon: "shield-check",
        label: "检查运行器",
        onClick: async () => {
          try {
            const info = await this.plugin.checkRunner();
            const text = info.version
              ? `${info.mode} 已就绪 · ${info.version}`
              : `${info.mode} 已就绪`;
            this.setRunnerInfo(text);
            new Notice(text);
          } catch (error) {
            new Notice(error?.message || String(error));
          }
        },
      },
      {
        icon: "settings",
        label: "设置",
        onClick: () => this.plugin.openSettings(),
      },
      {
        icon: "rotate-ccw",
        label: "新会话",
        onClick: () => this.clearTranscript(),
      },
    ];

    buttons.forEach(({ icon, label, onClick }) => {
      const button = heroActions.createEl("button", { cls: "codex-agent-icon-button" });
      setIcon(button, icon);
      button.ariaLabel = label;
      button.addEventListener("click", onClick);
    });

    this.renderContextStrip(shell);

    const transcript = shell.createDiv({ cls: "codex-agent-transcript" });
    this.transcriptEl = transcript;
    void this.renderMessages(transcript, token);

    const composer = shell.createDiv({ cls: "codex-agent-composer" });
    const composerHeader = composer.createDiv({ cls: "codex-agent-composer-header" });
    const composerHeaderCopy = composerHeader.createDiv({ cls: "codex-agent-composer-header-copy" });
    composerHeaderCopy.createEl("div", {
      text: actionConfig.label,
      cls: "codex-agent-composer-title",
    });
    this.renderDisclosureButton(
      composerHeader,
      this.state.controlsExpanded ? "收起功能" : "展开功能",
      this.state.controlsExpanded,
      () => {
        this.state.controlsExpanded = !this.state.controlsExpanded;
        this.render();
      }
    );

    const composerSummary = composer.createDiv({ cls: "codex-agent-composer-summary" });
    composerSummary.createEl("span", {
      text: `当前操作：${actionConfig.label}`,
      cls: "codex-agent-tag",
    });
    composerSummary.createEl("span", {
      text: `上下文：${CONTEXT_MODES[this.state.contextMode] || this.state.contextMode}`,
      cls: "codex-agent-tag is-muted",
    });

    const inputWrap = composer.createDiv({ cls: "codex-agent-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      cls: "codex-agent-input",
    });
    input.rows = 5;
    input.placeholder = actionConfig.placeholder;
    input.value = this.state.instruction;
    input.disabled = this.state.busy;
    input.addEventListener("input", () => {
      this.state.instruction = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.runCurrentAction();
      }
    });

    const composerFooter = composer.createDiv({ cls: "codex-agent-composer-footer" });
    const runButton = composerFooter.createEl("button", {
      text: this.state.busy ? "执行中..." : actionConfig.label,
      cls: "mod-cta",
    });
    runButton.disabled = this.state.busy;
    runButton.addEventListener("click", () => this.runCurrentAction());

    if (this.state.controlsExpanded) {
      const advanced = composer.createDiv({ cls: "codex-agent-advanced-panel" });
      advanced.createEl("div", {
        text: "功能配置",
        cls: "codex-agent-advanced-title",
      });

      this.renderChipGroup(
        advanced,
        "操作",
        Object.fromEntries(Object.entries(ACTIONS).map(([key, value]) => [key, value.label])),
        this.state.action,
        (nextAction) => {
          this.state.action = nextAction;
          this.state.contextMode = this.plugin.defaultContextModeForAction(nextAction);
          this.render();
        }
      );

      this.renderChipGroup(
        advanced,
        "上下文",
        CONTEXT_MODES,
        this.state.contextMode,
        (nextMode) => {
          this.state.contextMode = nextMode;
          this.render();
        }
      );
    }
  }
}

module.exports = {
  CodexAgentView,
  CodexInputModal,
};

},
"./main": function(module, exports, require) {
const fs = require("fs");
const path = require("path");
const {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
} = require("obsidian");
const {
  ACTIONS,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
  REASONING_EFFORTS,
  RUNNER_MODES,
  SANDBOX_MODES,
  VIEW_TYPE_CODEX_AGENT,
  deriveTitleFromContent,
  formatTimestamp,
  safeJsonParse,
  sanitizeFileName,
  trimTrailingSlash,
} = require("./shared");
const { checkCliRunner, runCliTask } = require("./runtime");
const { CodexAgentView, CodexInputModal } = require("./view");

class CodexAgentSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Codex 助手" });

    containerEl.createEl("h3", { text: "运行设置" });

    new Setting(containerEl)
      .setName("运行模式")
      .setDesc("直接 CLI 模式不需要额外启动服务；桥接服务模式用于兼容旧版本地服务。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(RUNNER_MODES)
          .setValue(this.plugin.settings.runnerMode)
          .onChange(async (value) => {
            this.plugin.settings.runnerMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Codex CLI 路径")
      .setDesc("留空则自动检测。Windows 上优先填写本机 codex.js 路径，不要使用 codex.ps1。")
      .addText((text) =>
        text
          .setPlaceholder("自动检测")
          .setValue(this.plugin.settings.codexCliPath)
          .onChange(async (value) => {
            this.plugin.settings.codexCliPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("直接 CLI 模式下传给 `codex exec` 的模型名称。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.codexModel)
          .setValue(this.plugin.settings.codexModel)
          .onChange(async (value) => {
            this.plugin.settings.codexModel = value.trim() || DEFAULT_SETTINGS.codexModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("推理强度")
      .setDesc("插件会覆盖全局 CLI 的该项设置，避免 `xhigh` 这类不受支持的值导致执行失败。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(REASONING_EFFORTS)
          .setValue(this.plugin.settings.codexReasoningEffort)
          .onChange(async (value) => {
            this.plugin.settings.codexReasoningEffort = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("沙箱模式")
      .setDesc("控制 Codex 在 Obsidian 内直接运行时的沙箱权限。")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(SANDBOX_MODES)
          .setValue(this.plugin.settings.codexSandbox)
          .onChange(async (value) => {
            this.plugin.settings.codexSandbox = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("超时时间（秒）")
      .setDesc("Obsidian 等待一次 Codex 执行完成的最长时间。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.codexTimeoutSec))
          .setValue(String(this.plugin.settings.codexTimeoutSec))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.codexTimeoutSec =
              Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.codexTimeoutSec;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Obsidian 工作流" });

    new Setting(containerEl)
      .setName("输出文件夹")
      .setDesc("Codex 根据摘要或提示创建新笔记时使用的文件夹。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.createNoteFolder)
          .setValue(this.plugin.settings.createNoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.createNoteFolder = value.trim() || DEFAULT_SETTINGS.createNoteFolder;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("执行命令时自动打开侧边栏")
      .setDesc("通过命令面板触发的操作，也会把结果同步写入侧边栏会话记录。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openSidebarOnRun)
          .onChange(async (value) => {
            this.plugin.settings.openSidebarOnRun = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认摘要提示词")
      .setDesc("当“总结”操作未填写额外要求时，会使用这里的默认提示词。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultSummaryInstruction)
          .setValue(this.plugin.settings.defaultSummaryInstruction)
          .onChange(async (value) => {
            this.plugin.settings.defaultSummaryInstruction =
              value.trim() || DEFAULT_SETTINGS.defaultSummaryInstruction;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "桥接回退" });

    new Setting(containerEl)
      .setName("桥接地址")
      .setDesc("仅在运行模式切换为桥接服务时使用。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.bridgeUrl)
          .setValue(this.plugin.settings.bridgeUrl)
          .onChange(async (value) => {
            this.plugin.settings.bridgeUrl = value.trim() || DEFAULT_SETTINGS.bridgeUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("桥接令牌")
      .setDesc("桥接服务模式下可选的共享密钥。")
      .addText((text) =>
        text
          .setPlaceholder("可选")
          .setValue(this.plugin.settings.bridgeToken)
          .onChange(async (value) => {
            this.plugin.settings.bridgeToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("检查当前运行器")
      .setDesc("对当前选中的运行模式执行一次轻量验证。")
      .addButton((button) =>
        button.setButtonText("立即检查").onClick(async () => {
          try {
            const info = await this.plugin.checkRunner();
            new Notice(info.version ? `${info.mode} 已就绪 · ${info.version}` : `${info.mode} 已就绪`);
          } catch (error) {
            new Notice(error?.message || String(error));
          }
        })
      );

    containerEl.createEl("h3", { text: "赞助支持" });

    new Setting(containerEl)
      .setName("微信赞助")
      .setDesc("如果这个插件对你有帮助，欢迎通过微信收款码支持作者。")
      .addButton((button) =>
        button.setButtonText("打开收款码").onClick(() => {
          this.plugin.openSponsorModal();
        })
      );
  }
}

class SponsorModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-agent-modal", "codex-agent-sponsor-modal");
    contentEl.createEl("h2", { text: "赞助作者" });
    contentEl.createEl("p", {
      text: "如果这个插件对你有帮助，欢迎使用微信扫一扫支持作者。",
      cls: "codex-agent-modal-copy",
    });

    const dataUrl = this.plugin.getPluginAssetDataUrl("wechat-sponsor.jpg");
    if (dataUrl) {
      contentEl.createEl("img", {
        cls: "codex-agent-sponsor-image",
        attr: {
          src: dataUrl,
          alt: "微信赞助收款码",
        },
      });
    } else {
      contentEl.createEl("p", {
        text: "未找到微信收款码图片，请确认插件目录中包含 wechat-sponsor.jpg。",
        cls: "codex-agent-modal-copy",
      });
    }

    const actionsEl = contentEl.createDiv({ cls: "codex-agent-modal-actions" });
    const closeButton = actionsEl.createEl("button", {
      text: "关闭",
      cls: "mod-cta",
    });
    closeButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class CodexAgentPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.sidebarView = null;
    this.lastMarkdownLeaf = null;

    const initialLeaf = this.app.workspace.getMostRecentLeaf();
    if (initialLeaf?.view instanceof MarkdownView) {
      this.lastMarkdownLeaf = initialLeaf;
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownLeaf = leaf;
        }
        if (this.sidebarView && !this.sidebarView.state.busy) {
          this.sidebarView.render();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.sidebarView && !this.sidebarView.state.busy) {
          this.sidebarView.render();
        }
      })
    );

    this.registerView(VIEW_TYPE_CODEX_AGENT, (leaf) => new CodexAgentView(leaf, this));
    this.addRibbonIcon("bot", "打开 Codex 助手", () => this.activateSidebar());
    this.addSettingTab(new CodexAgentSettingTab(this.app, this));

    this.addCommand({
      id: "open-codex-agent-sidebar",
      name: "打开 Codex 助手侧边栏",
      callback: async () => {
        await this.activateSidebar();
      },
    });

    this.addCommand({
      id: "check-codex-runner",
      name: "检查 Codex 运行器",
      callback: async () => {
        const info = await this.checkRunner();
        new Notice(info.version ? `${info.mode} 已就绪 · ${info.version}` : `${info.mode} 已就绪`);
      },
    });

    this.addCommand({
      id: "open-wechat-sponsor",
      name: "打开微信赞助码",
      callback: () => {
        this.openSponsorModal();
      },
    });

    this.addCommand({
      id: "ask-codex-about-current-note",
      name: "向 Codex 提问当前笔记",
      callback: async () => {
        const instruction = await this.promptForText({
          title: "向 Codex 提问",
          description: "Codex 会在可用时结合当前笔记和当前选中内容来回答。",
          placeholder: ACTIONS.chat.placeholder,
          submitText: "提问",
        });
        if (instruction === null) {
          return;
        }

        await this.executeTask({
          action: "chat",
          instruction,
          contextMode: "note+selection",
          openSidebar: this.settings.openSidebarOnRun,
        });
        new Notice("Codex 回复已生成。");
      },
    });

    this.addCommand({
      id: "rewrite-selection-with-codex",
      name: "用 Codex 改写选中文本",
      callback: async () => {
        const instruction = await this.promptForText({
          title: "改写选中文本",
          description: "Codex 会返回一段可直接替换当前选区的文本。",
          placeholder: ACTIONS.rewrite.placeholder,
          submitText: "改写",
        });
        if (instruction === null) {
          return;
        }

        const response = await this.executeTask({
          action: "rewrite",
          instruction,
          contextMode: "selection",
          openSidebar: this.settings.openSidebarOnRun,
        });
        await this.replaceSelection(response.result);
      },
    });

    this.addCommand({
      id: "summarize-current-note-with-codex",
      name: "用 Codex 总结当前笔记",
      callback: async () => {
        const context = await this.requireMarkdownContext();
        const extraInstruction = await this.promptForText({
          title: "总结当前笔记",
          description: "留空则使用设置中的默认摘要提示词。",
          placeholder: ACTIONS.summarize.placeholder,
          submitText: "总结",
          allowEmpty: true,
          lines: 6,
        });
        if (extraInstruction === null) {
          return;
        }

        const response = await this.executeTask({
          action: "summarize",
          instruction: extraInstruction || this.settings.defaultSummaryInstruction,
          contextMode: "note",
          openSidebar: this.settings.openSidebarOnRun,
        });

        await this.createNoteFromContent(response.result, {
          titleHint: `${context.file.basename} 摘要`,
        });
        new Notice("摘要笔记已创建。");
      },
    });

    this.addCommand({
      id: "create-note-with-codex",
      name: "用 Codex 创建新笔记",
      callback: async () => {
        const instruction = await this.promptForText({
          title: "用 Codex 创建笔记",
          description: "Codex 会结合当前笔记上下文生成一篇新的 Markdown 笔记。",
          placeholder: ACTIONS.create_note.placeholder,
          submitText: "创建",
        });
        if (instruction === null) {
          return;
        }

        const response = await this.executeTask({
          action: "create_note",
          instruction,
          contextMode: "note+selection",
          openSidebar: this.settings.openSidebarOnRun,
        });

        await this.createNoteFromContent(response.result);
        new Notice("新笔记已创建。");
      },
    });
  }

  async onunload() {
    await this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEX_AGENT);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openSettings() {
    this.app.setting.open();
    if (typeof this.app.setting.openTabById === "function") {
      this.app.setting.openTabById(this.manifest.id);
    }
  }

  openSponsorModal() {
    new SponsorModal(this.app, this).open();
  }

  defaultContextModeForAction(action) {
    if (action === "rewrite") {
      return "selection";
    }
    if (action === "summarize") {
      return "note";
    }
    if (action === "create_note") {
      return "note+selection";
    }
    return "note+selection";
  }

  async promptForText(options) {
    const modal = new CodexInputModal(this.app, options);
    return modal.ask();
  }

  async activateSidebar() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_AGENT)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_CODEX_AGENT,
        active: true,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
    if (this.sidebarView) {
      this.sidebarView.render();
    }
    return leaf;
  }

  getMarkdownView() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      return activeView;
    }

    if (this.lastMarkdownLeaf?.view instanceof MarkdownView) {
      return this.lastMarkdownLeaf.view;
    }

    const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
    if (mostRecentLeaf?.view instanceof MarkdownView) {
      return mostRecentLeaf.view;
    }

    const markdownLeaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find((leaf) => leaf.view instanceof MarkdownView);

    return markdownLeaf ? markdownLeaf.view : null;
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter?.getBasePath === "function") {
      return adapter.getBasePath();
    }
    if (adapter?.basePath) {
      return adapter.basePath;
    }
    return "";
  }

  getInstalledPluginDir() {
    const basePath = this.getVaultBasePath();
    if (!basePath) {
      return "";
    }
    return path.join(basePath, this.app.vault.configDir, "plugins", this.manifest.id);
  }

  getPluginAssetDataUrl(fileName) {
    const pluginDir = this.getInstalledPluginDir();
    if (!pluginDir) {
      return "";
    }

    const assetPath = path.join(pluginDir, fileName);
    if (!fs.existsSync(assetPath)) {
      return "";
    }

    const ext = path.extname(fileName).toLowerCase();
    const mimeType =
      ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    const content = fs.readFileSync(assetPath);
    return `data:${mimeType};base64,${content.toString("base64")}`;
  }

  getContextSummary() {
    const view = this.getMarkdownView();
    const selection = view?.editor?.getSelection?.() || "";
    return {
      noteTitle: view?.file?.basename || "",
      selectionLength: selection.length,
      selectionText: selection.trim() ? `已选中 ${selection.length} 个字符` : "未选中文本",
    };
  }

  async requireMarkdownContext() {
    const view = this.getMarkdownView();
    if (!view || !view.file) {
      throw new Error("请先打开一篇 Markdown 笔记。");
    }

    const file = view.file;
    const content = await this.app.vault.read(file);
    const editor = view.editor;
    const selection = editor ? editor.getSelection() : "";
    const metadata = this.app.metadataCache.getFileCache(file) || {};

    return {
      view,
      file,
      editor,
      selection,
      note: {
        title: file.basename,
        path: file.path,
        content,
        frontmatter: metadata.frontmatter || null,
        headings: Array.isArray(metadata.headings)
          ? metadata.headings.map((item) => ({
              heading: item.heading,
              level: item.level,
            }))
          : [],
      },
    };
  }

  async buildPayload(action, instruction, contextMode) {
    if (contextMode === "none") {
      return {
        action,
        instruction,
        selection: "",
        note: null,
        client: {
          name: "obsidian-codex-agent",
          version: PLUGIN_VERSION,
        },
      };
    }

    const context = await this.requireMarkdownContext();
    if (contextMode === "selection" && !context.selection.trim()) {
      throw new Error("请先选中一些文本。");
    }

    return {
      action,
      instruction,
      selection:
        contextMode === "selection" || contextMode === "note+selection"
          ? context.selection
          : "",
      note:
        contextMode === "selection" ||
        contextMode === "note" ||
        contextMode === "note+selection"
          ? context.note
          : null,
      client: {
        name: "obsidian-codex-agent",
        version: PLUGIN_VERSION,
      },
    };
  }

  async callBridge(pathname, method, payload) {
    const baseUrl = trimTrailingSlash(this.settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl);
    const headers = {
      "Content-Type": "application/json",
    };

    if (this.settings.bridgeToken) {
      headers["X-Bridge-Token"] = this.settings.bridgeToken;
    }

    const response = await requestUrl({
      url: `${baseUrl}${pathname}`,
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      throw: false,
    });

    const data = response.text ? safeJsonParse(response.text) : null;
    if (response.status >= 400) {
      throw new Error(data?.error || `Bridge 请求失败，状态码：${response.status}。`);
    }
    if (!data) {
      throw new Error("Bridge 返回了无效的 JSON 响应。");
    }
    return data;
  }

  async runBridgeTask(payload) {
    const response = await this.callBridge("/v1/tasks", "POST", payload);
    if (!response.ok) {
      throw new Error(response.error || "Bridge 请求失败。");
    }
    return {
      result: response.result || "",
      meta: Object.assign({}, response.meta, {
        runner: "桥接服务",
      }),
    };
  }

  async checkRunner() {
    if (this.settings.runnerMode === "bridge") {
      const result = await this.callBridge("/health", "GET");
      if (!result.ok) {
        throw new Error(result.error || "Bridge 健康检查失败。");
      }
      return {
        mode: "桥接服务",
        version: result.model || result.version || "",
      };
    }

    return checkCliRunner(this);
  }

  async callRunner(payload) {
    if (this.settings.runnerMode === "bridge") {
      return this.runBridgeTask(payload);
    }
    return runCliTask(this, payload);
  }

  async executeTask({ action, instruction, contextMode, openSidebar }) {
    const payload = await this.buildPayload(action, instruction, contextMode);
    const shouldUseSidebar = openSidebar ?? this.settings.openSidebarOnRun;
    let taskHandle = null;

    if (shouldUseSidebar) {
      await this.activateSidebar();
      if (this.sidebarView) {
        taskHandle = this.sidebarView.beginTask({
          action,
          contextMode,
          instruction,
        });
      }
    }

    try {
      const response = await this.callRunner(payload);
      if (shouldUseSidebar && this.sidebarView && taskHandle) {
        this.sidebarView.finishTask(taskHandle, response);
      }
      return {
        action,
        instruction,
        contextMode,
        result: response.result,
        meta: response.meta,
      };
    } catch (error) {
      if (shouldUseSidebar && this.sidebarView && taskHandle) {
        this.sidebarView.failTask(taskHandle, error);
      }
      throw error;
    }
  }

  async ensureFolderExists(folderPath) {
    if (!folderPath) {
      return;
    }

    const normalized = normalizePath(folderPath);
    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  async createNoteFromContent(content, options = {}) {
    if (!content || !content.trim()) {
      throw new Error("结果为空。");
    }

    const folder = options.folder ?? this.settings.createNoteFolder;
    const normalizedFolder = folder ? normalizePath(folder) : "";
    if (normalizedFolder) {
      await this.ensureFolderExists(normalizedFolder);
    }

    const baseTitle = sanitizeFileName(
      options.titleHint || deriveTitleFromContent(content, `Codex 笔记 ${formatTimestamp()}`)
    );

    let candidate = normalizedFolder
      ? `${normalizedFolder}/${baseTitle}.md`
      : `${baseTitle}.md`;
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizedFolder
        ? `${normalizedFolder}/${baseTitle} ${index}.md`
        : `${baseTitle} ${index}.md`;
      index += 1;
    }

    const file = await this.app.vault.create(normalizePath(candidate), content);
    await this.app.workspace.getLeaf(true).openFile(file);
    return file;
  }

  async replaceSelection(text) {
    if (!text || !text.trim()) {
      throw new Error("结果为空。");
    }

    const context = await this.requireMarkdownContext();
    if (!context.selection.trim()) {
      throw new Error("请先选中一些文本。");
    }

    context.editor.replaceSelection(text);
    new Notice("已替换选中文本。");
  }

  async insertAtCursor(text) {
    if (!text || !text.trim()) {
      throw new Error("结果为空。");
    }

    const context = await this.requireMarkdownContext();
    const cursor = context.editor.getCursor();
    context.editor.replaceRange(text, cursor);
    new Notice("已插入到光标处。");
  }

  async appendToCurrentNote(text) {
    if (!text || !text.trim()) {
      throw new Error("结果为空。");
    }

    const context = await this.requireMarkdownContext();
    const editor = context.editor;
    const lastLine = editor.lastLine();
    const lastLineText = editor.getLine(lastLine);
    const prefix = editor.getValue().trim() ? "\n\n" : "";
    editor.replaceRange(prefix + text, { line: lastLine, ch: lastLineText.length });
    new Notice("已追加到当前笔记。");
  }

  async copyToClipboard(text) {
    if (!text || !text.trim()) {
      throw new Error("结果为空。");
    }

    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      new Notice("已复制到剪贴板。");
      return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    new Notice("已复制到剪贴板。");
  }
};

}
};
const __cache = {};
function __require(id){
  if(__cache[id]) return __cache[id].exports;
  if(__modules[id]) {
    const module = { exports: {} };
    __cache[id] = module;
    __modules[id](module, module.exports, __require);
    return module.exports;
  }
  if(__nativeRequire) {
    return __nativeRequire(id);
  }
  throw new Error('Module not found: ' + id);
}
module.exports = __require("./main");
})();
