(function(){
const __nativeRequire = typeof require === "function" ? require : null;
const __modules = {
"./shared": function(module, exports, require) {
const fs = require("fs");
const path = require("path");

const VIEW_TYPE_CODEX_AGENT = "codex-agent-sidebar";
const PLUGIN_VERSION = "1.0.0";

const ACTIONS = {
  chat: {
    label: "提问",
    hint: "就当前笔记、整个库或当前选中文本向 Codex 提问。",
    placeholder: "输入你想让 Codex 回答的问题，可用 @ 引用笔记...",
  },
  rewrite: {
    label: "改写",
    hint: "返回当前选中文本的替换内容。",
    placeholder: "描述你希望如何改写选中文本...",
  },
  summarize: {
    label: "总结",
    hint: "将当前笔记或多个文件整理成一篇精简摘要。",
    placeholder: "可选：补充摘要或多文件汇总要求，也可用 @ 引用笔记...",
  },
  create_note: {
    label: "新建笔记",
    hint: "结合当前笔记上下文生成一篇新笔记。",
    placeholder: "描述你想让 Codex 创建的笔记，可用 @ 引用笔记...",
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

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

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
  defaultSummaryInstruction:
    "请将当前笔记或所附文件整理成便于快速回顾的摘要；如果有多个文件，请先提炼每个文件的重点，再给出综合结论。",
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

function formatReferencedNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return "未提供额外引用笔记。";
  }

  return notes
    .map((note, index) => {
      return [`## 引用笔记 ${index + 1}`, formatNoteContext(note)].join("\n");
    })
    .join("\n\n");
}

function formatSelection(selection) {
  return String(selection || "").trim() || "(未提供选中内容)";
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(filePath, mimeType) {
  const normalizedMime = String(mimeType || "").trim().toLowerCase();
  if (normalizedMime.startsWith("image/")) {
    return true;
  }

  const ext = path.extname(String(filePath || "")).trim().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function classifyAttachment(filePath, mimeType) {
  return isImageAttachment(filePath, mimeType) ? "image" : "file";
}

function formatAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "未提供附件。";
  }

  return attachments
    .map((attachment, index) => {
      const name = String(attachment?.name || attachment?.path || `附件 ${index + 1}`).trim();
      const kind = attachment?.kind === "image" ? "图片" : "文件";
      const size = formatBytes(attachment?.size);
      const pathLabel = String(attachment?.path || "").trim() || "(路径不可用)";
      return `${index + 1}. [${kind}] ${name}${size ? ` · ${size}` : ""}\n   路径: ${pathLabel}`;
    })
    .join("\n");
}

function buildPrompt(action, instruction, payload, vaultPath) {
  const noteBlock = formatNoteContext(payload.note);
  const referencesBlock = formatReferencedNotes(payload.references || []);
  const selectionBlock = formatSelection(payload.selection);
  const attachmentsBlock = formatAttachments(payload.attachments || []);
  const vaultBlock = `库根目录: ${vaultPath || "(未知)"}`;

  if (action === "chat") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "你当前由桌面版 Obsidian 插件调用。仓库根目录就是你的工作目录。",
      "在相关时使用提供的笔记上下文；如果有助于回答问题，也可以查看库中的其他文件。",
      "如果提供了额外引用笔记，请优先围绕这些引用笔记回答；除非用户明确要求，否则不要把当前活动笔记当成主要依据。",
      "如果提供了附件，请结合附件内容一起分析并回答。",
      "图片附件会作为视觉输入直接附带；其他附件可以通过列出的本地路径读取。",
      "默认使用中文回答，除非用户明确要求其他语言。",
      "只返回 Markdown，不要把整个回答包在代码块里。",
      "",
      vaultBlock,
      "",
      `用户请求:\n${instruction}`,
      "",
      `选中内容:\n${selectionBlock}`,
      "",
      `附件:\n${attachmentsBlock}`,
      "",
      `额外引用笔记:\n${referencesBlock}`,
      "",
      `当前笔记:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "rewrite") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "请根据用户要求改写选中的文本。",
      "如果提供了额外引用笔记，请在必要时参考这些笔记。",
      "如果提供了附件，请在必要时参考附件内容。",
      "图片附件会作为视觉输入直接附带；其他附件可以通过列出的本地路径读取。",
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
      `附件:\n${attachmentsBlock}`,
      "",
      `额外引用笔记:\n${referencesBlock}`,
      "",
      `所在笔记上下文:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "summarize") {
    const attachmentCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
    let summaryTask = "请基于提供的笔记生成一篇精炼、可独立阅读的 Markdown 摘要笔记。";

    if (!payload.note && attachmentCount === 1) {
      summaryTask = "请基于提供的文件生成一篇精炼、可独立阅读的 Markdown 摘要笔记。";
    } else if (!payload.note && attachmentCount > 1) {
      summaryTask =
        "请基于提供的多个文件生成一篇汇总摘要，先提炼每个文件的重点，再整理综合结论、共通点与差异点。";
    } else if (payload.note && attachmentCount > 0) {
      summaryTask =
        "请基于当前笔记和提供的文件生成一篇汇总摘要，优先保留核心信息，并在必要时吸收附件中的补充内容。";
    }

    return [
      "你是运行在 Obsidian 中的 Codex。",
      summaryTask,
      "如果提供了额外引用笔记，请优先围绕这些引用笔记组织摘要。",
      "如果提供了附件，请在确有帮助时结合附件内容补充摘要。",
      "如果提供了多个文件，请先分别提炼重点，再输出整合后的总览。",
      "图片附件会作为视觉输入直接附带；其他附件可以通过列出的本地路径读取。",
      "默认使用中文输出，除非用户明确要求其他语言。",
      "使用一级标题，并让摘要适合后续复习回顾。",
      "",
      vaultBlock,
      "",
      `摘要要求:\n${instruction || DEFAULT_SETTINGS.defaultSummaryInstruction}`,
      "",
      `附件:\n${attachmentsBlock}`,
      "",
      `额外引用笔记:\n${referencesBlock}`,
      "",
      `当前笔记:\n${noteBlock}`,
      "",
    ].join("\n");
  }

  if (action === "create_note") {
    return [
      "你是运行在 Obsidian 中的 Codex。",
      "请根据用户请求和提供的上下文起草一篇新的 Markdown 笔记。",
      "如果提供了额外引用笔记，请优先整合这些引用笔记中的内容。",
      "如果提供了附件，请把附件中的关键信息整合进结果。",
      "图片附件会作为视觉输入直接附带；其他附件可以通过列出的本地路径读取。",
      "默认使用中文输出，除非用户明确要求其他语言。",
      "只返回笔记正文，并以一级标题开头。",
      "",
      vaultBlock,
      "",
      `新笔记需求:\n${instruction}`,
      "",
      `选中内容:\n${selectionBlock}`,
      "",
      `附件:\n${attachmentsBlock}`,
      "",
      `额外引用笔记:\n${referencesBlock}`,
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
  classifyAttachment,
  deriveTitleFromContent,
  fileExists,
  formatAttachments,
  formatBytes,
  formatTimestamp,
  isImageAttachment,
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
  classifyAttachment,
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

function sanitizeAttachmentName(fileName) {
  const value = String(fileName || "").trim() || "attachment";
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function makeUniquePath(directory, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length) || "attachment";
  let candidate = path.join(directory, fileName);
  let index = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base}-${index}${ext}`);
    index += 1;
  }

  return candidate;
}

function stagePayloadAttachments(plugin, payload, vaultPath) {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (attachments.length === 0) {
    return {
      attachments: [],
      imagePaths: [],
      cleanupDir: "",
    };
  }

  const pluginDir = plugin.getInstalledPluginDir() || vaultPath;
  const attachmentRoot = path.join(pluginDir, ".task-attachments");
  fs.mkdirSync(attachmentRoot, { recursive: true });

  const cleanupDir = path.join(
    attachmentRoot,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(cleanupDir, { recursive: true });

  const stagedAttachments = [];
  const imagePaths = [];

  for (const attachment of attachments) {
    const originalPath = String(attachment?.path || "").trim();
    if (!originalPath || !fileExists(originalPath)) {
      continue;
    }

    const safeName = sanitizeAttachmentName(attachment.name || path.basename(originalPath));
    const stagedPath = makeUniquePath(cleanupDir, safeName);
    fs.copyFileSync(originalPath, stagedPath);

    const stagedStat = fs.statSync(stagedPath);
    const kind = attachment.kind || classifyAttachment(stagedPath, attachment.mimeType);
    const stagedAttachment = Object.assign({}, attachment, {
      name: attachment.name || path.basename(originalPath),
      originalPath,
      path: stagedPath,
      size: Number(attachment.size || stagedStat.size || 0),
      kind,
    });

    stagedAttachments.push(stagedAttachment);
    if (kind === "image") {
      imagePaths.push(stagedPath);
    }
  }

  return {
    attachments: stagedAttachments,
    imagePaths,
    cleanupDir,
  };
}

function buildCodexExecArgs(plugin, outputPath, imagePaths) {
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

  for (const imagePath of imagePaths || []) {
    args.push("--image", imagePath);
  }

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
  const staged = stagePayloadAttachments(plugin, payload, vaultPath);
  const stagedPayload = Object.assign({}, payload, {
    attachments: staged.attachments,
  });
  const prompt = buildPrompt(payload.action, payload.instruction, stagedPayload, vaultPath);
  const args = launcher.args.concat(buildCodexExecArgs(plugin, outputPath, staged.imagePaths));
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
        attachment_count: staged.attachments.length,
      },
    };
  } catch (error) {
    throw new Error(normalizeRunnerError(error?.message || String(error)));
  } finally {
    try {
      if (staged.cleanupDir) {
        fs.rmSync(staged.cleanupDir, { recursive: true, force: true });
      }
    } catch (_error) {
      // ignore cleanup failures
    }
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
  formatBytes,
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
    this.fileInputEl = null;
    this.pendingInputSelection = null;
    this.state = {
      action: "chat",
      contextMode: "note+selection",
      instruction: "",
      references: [],
      attachments: [],
      mention: null,
      busy: false,
      messages: [],
      runnerInfo: "",
      lastError: "",
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
    if (this.fileInputEl) {
      this.fileInputEl.remove();
      this.fileInputEl = null;
    }
    this.pendingInputSelection = null;
  }

  setRunnerInfo(text) {
    this.state.runnerInfo = text || "";
    this.render();
  }

  clearTranscript() {
    this.state.messages = [];
    this.state.lastError = "";
    this.state.resultActionsExpandedId = "";
    this.state.references = [];
    this.state.attachments = [];
    this.state.instruction = "";
    this.state.mention = null;
    this._mentionRenderKey = "";
    this.render();
  }

  beginTask({ action, contextMode, instruction, attachments = [], references = [] }) {
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
      meta: {
        attachments,
        references,
      },
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
        attachments: this.state.attachments,
        references: this.state.references,
        openSidebar: true,
      });
      this.applyInstructionChange("", { cursor: 0 });
    } catch (error) {
      new Notice(error?.message || String(error));
    }
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

  ensureFileInput() {
    if (this.fileInputEl?.isConnected) {
      return this.fileInputEl;
    }

    const input = this.contentEl.createEl("input", {
      cls: "codex-agent-hidden-file-input",
    });
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      if (!files.length) {
        return;
      }

      const existing = new Map(
        this.state.attachments.map((attachment) => [attachment.path.toLowerCase(), attachment])
      );
      let addedCount = 0;

      for (const file of files) {
        const record = this.plugin.createAttachmentRecord(file);
        if (!record) {
          continue;
        }
        existing.set(record.path.toLowerCase(), record);
        addedCount += 1;
      }

      if (!addedCount) {
        new Notice("没有读取到可用附件。请确认你选择的是本地文件。");
        return;
      }

      this.state.attachments = Array.from(existing.values());
      this.render();
      new Notice(`已添加 ${addedCount} 个附件。`);
    });

    this.fileInputEl = input;
    return input;
  }

  openAttachmentPicker() {
    const input = this.ensureFileInput();
    input.value = "";
    input.click();
  }

  removeAttachment(attachmentId) {
    this.state.attachments = this.state.attachments.filter((attachment) => attachment.id !== attachmentId);
    this.render();
  }

  getActiveMention(text, cursor) {
    const beforeCursor = String(text || "").slice(0, Math.max(Number(cursor || 0), 0));
    const match = beforeCursor.match(/(?:^|\s)@([^\s@\[\]]*)$/);
    if (!match) {
      return null;
    }

    const query = match[1] || "";
    const start = beforeCursor.length - query.length - 1;
    return {
      start,
      end: beforeCursor.length,
      query,
    };
  }

  updateMentionState(cursor) {
    const activeMention = this.getActiveMention(this.state.instruction, cursor);
    if (!activeMention) {
      this.state.mention = null;
      return;
    }

    const results = this.plugin.searchReferenceableNotes(
      activeMention.query,
      new Set(this.state.references.map((item) => String(item.path || "").trim().toLowerCase())),
      8
    );
    this.state.mention = {
      ...activeMention,
      selectedIndex: 0,
      results,
    };
  }

  applyInstructionChange(nextInstruction, options = {}) {
    this.state.instruction = nextInstruction;
    this.updateMentionState(options.cursor ?? nextInstruction.length);
    this.pendingInputSelection = {
      start: options.selectionStart ?? options.cursor ?? nextInstruction.length,
      end: options.selectionEnd ?? options.cursor ?? nextInstruction.length,
    };
    this.render();
  }

  removeReferencedNote(referenceId) {
    this.state.references = this.state.references.filter((reference) => reference.id !== referenceId);
    this.render();
  }

  getPinnedCurrentReference() {
    const view = this.plugin.getMarkdownView();
    if (!view?.file) {
      return null;
    }

    return {
      id: "__current_note__",
      title: view.file.basename,
      path: view.file.path,
      pinned: true,
    };
  }

  getVisibleReferences() {
    const pinned = this.getPinnedCurrentReference();
    const pinnedPath = String(pinned?.path || "").trim().toLowerCase();
    const extraReferences = this.state.references.filter((reference) => {
      const referencePath = String(reference?.path || "").trim().toLowerCase();
      return referencePath && referencePath !== pinnedPath;
    });

    return pinned ? [pinned, ...extraReferences] : extraReferences;
  }

  selectMentionSuggestion(index) {
    if (!this.state.mention?.results?.length) {
      return;
    }

    const item = this.state.mention.results[index] || this.state.mention.results[0];
    if (!item) {
      return;
    }

    const before = this.state.instruction.slice(0, this.state.mention.start);
    const after = this.state.instruction.slice(this.state.mention.end);
    const nextInstruction = `${before}${after}`.replace(/ {2,}/g, " ");
    const nextCursor = before.length;

    const exists = this.state.references.some(
      (reference) => String(reference.path || "").toLowerCase() === String(item.path || "").toLowerCase()
    );
    if (!exists) {
      this.state.references = [
        ...this.state.references,
        {
          id: item.id,
          title: item.title,
          path: item.path,
        },
      ];
    }

    this.applyInstructionChange(nextInstruction, {
      cursor: nextCursor,
    });
    new Notice(`已引用笔记：${item.title}`);
  }

  renderMentionSuggestions(parent) {
    if (!this.state.mention?.results?.length) {
      return;
    }

    const panel = parent.createDiv({ cls: "codex-agent-mention-panel" });
    const header = panel.createDiv({ cls: "codex-agent-mention-panel-header" });
    header.createSpan({ text: "引用笔记" });
    header.createSpan({ text: `${this.state.mention.results.length} 项` });

    this.state.mention.results.forEach((item, index) => {
      const button = panel.createEl("button", {
        cls: [
          "codex-agent-mention-item",
          index === this.state.mention.selectedIndex ? "is-active" : "",
        ].filter(Boolean).join(" "),
      });
      button.type = "button";
      button.addEventListener("click", () => this.selectMentionSuggestion(index));

      const icon = button.createDiv({ cls: "codex-agent-mention-item-icon" });
      icon.setText("@");

      const content = button.createDiv({ cls: "codex-agent-mention-item-content" });
      const title = content.createDiv({ cls: "codex-agent-note-suggest-title" });
      title.setText(item.title);
      const meta = content.createDiv({ cls: "codex-agent-note-suggest-path" });
      meta.setText(`@${item.linkPath}`);
    });
  }

  renderAttachmentChips(parent, attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return;
    }

    const list = parent.createDiv({ cls: "codex-agent-attachment-list" });
    for (const attachment of attachments) {
      const chip = list.createDiv({
        cls: `codex-agent-attachment-chip is-${attachment.kind || "file"}`,
      });

      const icon = chip.createSpan({ cls: "codex-agent-attachment-icon" });
      setIcon(icon, attachment.kind === "image" ? "image" : "paperclip");

      const label = chip.createSpan({ cls: "codex-agent-attachment-label" });
      const sizeText = formatBytes(attachment.size);
      label.setText(`${attachment.name || "附件"}${sizeText ? ` · ${sizeText}` : ""}`);
      chip.setAttr("title", attachment.path || attachment.name || "附件");

      if (options.removable) {
        const removeButton = chip.createEl("button", {
          cls: "codex-agent-attachment-remove",
        });
        setIcon(removeButton, "x");
        removeButton.ariaLabel = `移除附件 ${attachment.name || ""}`.trim();
        removeButton.addEventListener("click", () => this.removeAttachment(attachment.id));
      }
    }
  }

  renderReferenceChips(parent, references, options = {}) {
    if (!Array.isArray(references) || references.length === 0) {
      return;
    }

    const list = parent.createDiv({ cls: "codex-agent-attachment-list" });
    for (const reference of references) {
      const chip = list.createDiv({
        cls: "codex-agent-attachment-chip is-note",
      });

      const icon = chip.createSpan({ cls: "codex-agent-attachment-icon" });
      setIcon(icon, "file-text");

      const label = chip.createSpan({ cls: "codex-agent-attachment-label" });
      label.setText(reference.title || "引用笔记");
      chip.setAttr("title", reference.path || reference.title || "引用笔记");

      if (reference.pinned) {
        chip.addClass("is-pinned");
      } else if (options.removable) {
        const removeButton = chip.createEl("button", {
          cls: "codex-agent-attachment-remove",
        });
        setIcon(removeButton, "x");
        removeButton.ariaLabel = `移除引用笔记 ${reference.title || ""}`.trim();
        removeButton.addEventListener("click", () => this.removeReferencedNote(reference.id));
      }
    }
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
      if (message.meta?.attachments?.length) {
        left.createEl("span", {
          text: `附件 ${message.meta.attachments.length}`,
          cls: "codex-agent-tag",
        });
      }
      if (message.meta?.references?.length) {
        left.createEl("span", {
          text: `引用 ${message.meta.references.length}`,
          cls: "codex-agent-tag",
        });
      }

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

      if (message.meta?.references?.length) {
        this.renderReferenceChips(card, message.meta.references, { removable: false });
      }

      if (message.meta?.attachments?.length) {
        this.renderAttachmentChips(card, message.meta.attachments, { removable: false });
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

    const actionRow = composer.createDiv({ cls: "codex-agent-chip-row codex-agent-action-row" });
    Object.entries(ACTIONS).forEach(([key, value]) => {
      const button = actionRow.createEl("button", {
        text: value.label,
        cls: key === this.state.action ? "codex-agent-chip is-active" : "codex-agent-chip",
      });
      button.disabled = this.state.busy;
      button.addEventListener("click", () => {
        this.state.action = key;
        this.state.contextMode = "note+selection";
        this.render();
      });
    });

    const inputWrap = composer.createDiv({ cls: "codex-agent-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      cls: "codex-agent-input",
    });
    input.rows = 5;
    input.placeholder = `${actionConfig.placeholder}${actionConfig.placeholder ? "\n" : ""}输入 @ 可快速引用笔记`;
    input.value = this.state.instruction;
    input.disabled = this.state.busy;
    input.addEventListener("input", () => {
      this.state.instruction = input.value;
      const previousPaths = this.state.references.map((item) => item.path).join("|");
      this.updateMentionState(input.selectionStart ?? input.value.length);
      const nextPaths = this.state.references.map((item) => item.path).join("|");
      const mentionKey = this.state.mention
        ? `${this.state.mention.start}:${this.state.mention.end}:${this.state.mention.query}:${this.state.mention.results
            .map((item) => item.path)
            .join("|")}`
        : "";
      const previousMentionKey = this._mentionRenderKey || "";
      this._mentionRenderKey = mentionKey;
      if (previousPaths !== nextPaths || previousMentionKey !== mentionKey) {
        this.pendingInputSelection = {
          start: input.selectionStart ?? input.value.length,
          end: input.selectionEnd ?? input.value.length,
        };
        this.render();
      }
    });
    input.addEventListener("keydown", (event) => {
      if (this.state.mention?.results?.length) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          this.state.mention.selectedIndex =
            (this.state.mention.selectedIndex + 1) % this.state.mention.results.length;
          this.pendingInputSelection = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
          };
          this.render();
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          this.state.mention.selectedIndex =
            (this.state.mention.selectedIndex - 1 + this.state.mention.results.length) %
            this.state.mention.results.length;
          this.pendingInputSelection = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
          };
          this.render();
          return;
        }

        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          this.selectMentionSuggestion(this.state.mention.selectedIndex || 0);
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          this.state.mention = null;
          this.pendingInputSelection = {
            start: input.selectionStart ?? input.value.length,
            end: input.selectionEnd ?? input.value.length,
          };
          this.render();
          return;
        }
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.runCurrentAction();
      }
    });

    if (this.state.mention?.results?.length) {
      this.renderMentionSuggestions(inputWrap);
    }

    const visibleReferences = this.getVisibleReferences();
    if (visibleReferences.length > 0) {
      this.renderReferenceChips(composer, visibleReferences, { removable: true });
    }

    if (this.state.attachments.length > 0) {
      this.renderAttachmentChips(composer, this.state.attachments, { removable: true });
    }

    const composerFooter = composer.createDiv({ cls: "codex-agent-composer-footer" });
    const composerActions = composerFooter.createDiv({ cls: "codex-agent-composer-footer-actions" });
    if (this.state.references.length > 0) {
      const clearReferencesButton = composerActions.createEl("button", {
        text: "清空引用",
      });
      clearReferencesButton.disabled = this.state.busy;
      clearReferencesButton.addEventListener("click", () => {
        this.state.references = [];
        this.render();
      });
    }

    const attachmentButton = composerActions.createEl("button", {
      text: this.state.attachments.length > 0 ? "继续添加附件" : "上传附件",
    });
    attachmentButton.disabled = this.state.busy;
    attachmentButton.addEventListener("click", () => this.openAttachmentPicker());

    if (this.state.attachments.length > 0) {
      const clearButton = composerActions.createEl("button", {
        text: "清空附件",
      });
      clearButton.disabled = this.state.busy;
      clearButton.addEventListener("click", () => {
        this.state.attachments = [];
        this.render();
      });
    }

    const runButton = composerFooter.createEl("button", {
      text: this.state.busy ? "执行中..." : actionConfig.label,
      cls: "mod-cta",
    });
    runButton.disabled = this.state.busy;
    runButton.addEventListener("click", () => this.runCurrentAction());

    if (this.pendingInputSelection) {
      const selection = this.pendingInputSelection;
      this.pendingInputSelection = null;
      window.setTimeout(() => {
        const latestInput = this.contentEl.querySelector(".codex-agent-input");
        if (!latestInput) {
          return;
        }
        latestInput.focus();
        latestInput.setSelectionRange(selection.start, selection.end);
      }, 0);
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
  classifyAttachment,
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
  REASONING_EFFORTS,
  RUNNER_MODES,
  SANDBOX_MODES,
  VIEW_TYPE_CODEX_AGENT,
  deriveTitleFromContent,
  fileExists,
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

class ReferenceNotePickerModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.resolver = null;
    this.excludePaths = new Set(
      (options.excludePaths || [])
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    );
    this.items = this.plugin.listReferenceableNotes(this.excludePaths);
    this.query = "";
    this.listEl = null;
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

  getFilteredItems() {
    const query = this.query.trim().toLowerCase();
    if (!query) {
      return this.items.slice(0, 80);
    }

    return this.items
      .map((item) => {
        const title = String(item.title || "").toLowerCase();
        const itemPath = String(item.path || "").toLowerCase();
        let score = 0;
        if (title === query) {
          score += 10;
        }
        if (title.includes(query)) {
          score += 6;
        }
        if (itemPath.includes(query)) {
          score += 3;
        }
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path, "zh-CN"))
      .slice(0, 80)
      .map((entry) => entry.item);
  }

  renderList() {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();
    const items = this.getFilteredItems();

    if (items.length === 0) {
      this.listEl.createEl("div", {
        text: this.items.length === 0 ? "当前库里没有可引用的 Markdown 笔记。" : "没有找到匹配的笔记。",
        cls: "codex-agent-note-suggest-empty",
      });
      return;
    }

    items.forEach((item, index) => {
      const button = this.listEl.createEl("button", {
        cls: "codex-agent-note-suggest-item",
      });
      button.type = "button";
      if (index === 0) {
        button.addClass("is-first");
      }
      button.createEl("div", {
        text: item.title,
        cls: "codex-agent-note-suggest-title",
      });
      button.createEl("div", {
        text: item.path,
        cls: "codex-agent-note-suggest-path",
      });
      button.addEventListener("click", () => this.submit(item));
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-agent-modal");
    contentEl.createEl("h2", { text: "引用笔记" });
    contentEl.createEl("p", {
      text: "搜索并选择要加入上下文的笔记。可重复添加多篇。",
      cls: "codex-agent-modal-copy",
    });

    const input = contentEl.createEl("input", {
      cls: "codex-agent-note-search-input",
    });
    input.type = "text";
    input.placeholder = "搜索要引用的笔记...";
    input.value = this.query;
    input.addEventListener("input", () => {
      this.query = input.value;
      this.renderList();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const firstItem = this.getFilteredItems()[0];
        if (firstItem) {
          event.preventDefault();
          this.submit(firstItem);
        }
      }
    });

    this.listEl = contentEl.createDiv({ cls: "codex-agent-note-suggest-list" });
    this.renderList();

    const actionsEl = contentEl.createDiv({ cls: "codex-agent-modal-actions" });
    const cancelButton = actionsEl.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.submit(null));

    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    const resolve = this.resolver;
    this.resolver = null;
    if (resolve) {
      resolve(null);
    }
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

  createAttachmentRecord(fileLike) {
    const attachmentPath = String(
      fileLike?.path || fileLike?.originalPath || fileLike?.filePath || ""
    ).trim();
    if (!attachmentPath || !fileExists(attachmentPath)) {
      return null;
    }

    const stat = fs.statSync(attachmentPath);
    if (!stat.isFile()) {
      return null;
    }

    return {
      id:
        String(fileLike?.id || "").trim() ||
        `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(fileLike?.name || path.basename(attachmentPath)).trim() || path.basename(attachmentPath),
      path: attachmentPath,
      size: Number(fileLike?.size || stat.size || 0),
      mimeType: String(fileLike?.type || fileLike?.mimeType || "").trim(),
      kind: classifyAttachment(attachmentPath, fileLike?.type || fileLike?.mimeType),
    };
  }

  normalizeAttachments(attachments) {
    const normalized = [];
    const seen = new Set();

    for (const attachment of attachments || []) {
      const record = this.createAttachmentRecord(attachment);
      if (!record) {
        continue;
      }

      const key = record.path.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalized.push(record);
    }

    return normalized;
  }

  listReferenceableNotes(excludePaths = new Set()) {
    const excluded = excludePaths instanceof Set ? excludePaths : new Set(excludePaths || []);

    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => !excluded.has(String(file.path || "").trim().toLowerCase()))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"))
      .map((file) => ({
        id: `ref-${file.path}`,
        title: file.basename,
        path: file.path,
      }));
  }

  async pickReferencedNote(existingNotes = []) {
    const modal = new ReferenceNotePickerModal(this.app, this, {
      excludePaths: (existingNotes || []).map((item) => item?.path),
    });
    return modal.ask();
  }

  createReferenceRecord(fileLike) {
    const notePath = String(fileLike?.path || "").trim();
    if (!notePath) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file || file.extension !== "md") {
      return null;
    }

    return {
      id: String(fileLike?.id || "").trim() || `ref-${file.path}`,
      title: String(fileLike?.title || file.basename).trim() || file.basename,
      path: file.path,
    };
  }

  toReferenceLinkPath(notePath) {
    return String(notePath || "").replace(/\.md$/i, "");
  }

  resolveReferenceFile(linkPath, sourcePath = "") {
    const normalized = String(linkPath || "").trim();
    if (!normalized) {
      return null;
    }

    const resolved =
      this.app.metadataCache.getFirstLinkpathDest(normalized, sourcePath) ||
      this.app.vault.getAbstractFileByPath(normalized) ||
      this.app.vault.getAbstractFileByPath(`${normalized}.md`);

    if (!resolved || resolved.extension !== "md") {
      return null;
    }

    return resolved;
  }

  extractReferencedNotesFromInstruction(instruction, options = {}) {
    const text = String(instruction || "");
    const sourcePath = String(options.sourcePath || this.getMarkdownView()?.file?.path || "").trim();
    const references = [];
    const seen = new Set();

    const cleanedInstruction = text.replace(/@\[\[([^\]]+)\]\]/g, (fullMatch, inner) => {
      const [linkPathRaw, aliasRaw] = String(inner || "").split("|");
      const resolvedFile = this.resolveReferenceFile(linkPathRaw, sourcePath);
      if (!resolvedFile) {
        return fullMatch;
      }

      const record = this.createReferenceRecord({
        path: resolvedFile.path,
        title: aliasRaw ? aliasRaw.trim() : resolvedFile.basename,
      });
      if (!record) {
        return fullMatch;
      }

      const key = record.path.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        references.push(record);
      }

      return `《${record.title}》`;
    });

    return {
      references,
      cleanedInstruction,
    };
  }

  searchReferenceableNotes(query, excludePaths = new Set(), limit = 8) {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const items = this.listReferenceableNotes(excludePaths).map((item) => ({
      ...item,
      linkPath: this.toReferenceLinkPath(item.path),
    }));

    if (!normalizedQuery) {
      return items.slice(0, limit);
    }

    return items
      .map((item) => {
        const title = String(item.title || "").toLowerCase();
        const itemPath = String(item.path || "").toLowerCase();
        let score = 0;
        if (title === normalizedQuery) {
          score += 10;
        }
        if (title.startsWith(normalizedQuery)) {
          score += 7;
        }
        if (title.includes(normalizedQuery)) {
          score += 5;
        }
        if (itemPath.includes(normalizedQuery)) {
          score += 3;
        }
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path, "zh-CN"))
      .slice(0, limit)
      .map((entry) => entry.item);
  }

  normalizeReferencedNotes(references) {
    const normalized = [];
    const seen = new Set();

    for (const reference of references || []) {
      const record = this.createReferenceRecord(reference);
      if (!record) {
        continue;
      }

      const key = record.path.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalized.push(record);
    }

    return normalized;
  }

  async loadReferencedNotes(references, options = {}) {
    const loaded = [];
    const seen = new Set();
    const skipPath = String(options.skipPath || "").trim().toLowerCase();

    for (const reference of references || []) {
      const record = this.createReferenceRecord(reference);
      if (!record) {
        continue;
      }

      const key = record.path.toLowerCase();
      if (seen.has(key) || (skipPath && key === skipPath)) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(record.path);
      if (!file || file.extension !== "md") {
        continue;
      }

      const metadata = this.app.metadataCache.getFileCache(file) || {};
      const content = await this.app.vault.read(file);
      loaded.push({
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
      });
      seen.add(key);
    }

    return loaded;
  }

  canUseSupplementalContext(action, attachments, references) {
    if (!["chat", "create_note", "summarize"].includes(action)) {
      return false;
    }

    return (
      (Array.isArray(attachments) && attachments.length > 0) ||
      (Array.isArray(references) && references.length > 0)
    );
  }

  shouldPrioritizeReferencedNotes(action, references) {
    return (
      Array.isArray(references) &&
      references.length > 0 &&
      ["chat", "create_note", "summarize"].includes(action)
    );
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

  async buildPayload(action, instruction, contextMode, attachments = [], references = []) {
    const parsedMentions = this.extractReferencedNotesFromInstruction(instruction);
    const effectiveInstruction = parsedMentions.cleanedInstruction;
    const normalizedAttachments = this.normalizeAttachments(attachments);
    const normalizedReferences = this.normalizeReferencedNotes([
      ...(references || []),
      ...(parsedMentions.references || []),
    ]);

    if (contextMode === "none") {
      const referenceNotes = await this.loadReferencedNotes(normalizedReferences);
      if (
        action === "summarize" &&
        normalizedAttachments.length === 0 &&
        referenceNotes.length === 0
      ) {
        throw new Error("总结需要当前笔记、引用笔记，或至少上传一个文件。");
      }

      return {
        action,
        instruction: effectiveInstruction,
        selection: "",
        note: null,
        attachments: normalizedAttachments,
        references: referenceNotes,
        resolvedContextMode: "none",
        client: {
          name: "obsidian-codex-agent",
          version: PLUGIN_VERSION,
        },
      };
    }

    let context = null;
    const canFallbackToSupplementalOnly = this.canUseSupplementalContext(
      action,
      normalizedAttachments,
      normalizedReferences
    );
    try {
      context = await this.requireMarkdownContext();
    } catch (error) {
      if (!canFallbackToSupplementalOnly) {
        if (action === "summarize") {
          throw new Error("请先打开一篇 Markdown 笔记，或先引用笔记/上传文件后再执行总结。");
        }
        throw error;
      }
    }

    const referenceNotes = await this.loadReferencedNotes(normalizedReferences, {
      skipPath: context?.file?.path || "",
    });
    const prioritizeReferences = this.shouldPrioritizeReferencedNotes(action, referenceNotes);

    if (!context) {
      if (
        action === "summarize" &&
        normalizedAttachments.length === 0 &&
        referenceNotes.length === 0
      ) {
        throw new Error("请先打开一篇 Markdown 笔记，或先引用笔记/上传文件后再执行总结。");
      }

      return {
        action,
        instruction: effectiveInstruction,
        selection: "",
        note: null,
        attachments: normalizedAttachments,
        references: referenceNotes,
        resolvedContextMode: "none",
        client: {
          name: "obsidian-codex-agent",
          version: PLUGIN_VERSION,
        },
      };
    }

    if ((action === "rewrite" || contextMode === "selection") && !context.selection.trim()) {
      throw new Error("请先选中一些文本。");
    }

    return {
      action,
      instruction: effectiveInstruction,
      attachments: normalizedAttachments,
      references: referenceNotes,
      selection:
        prioritizeReferences
          ? ""
          : contextMode === "selection" || contextMode === "note+selection"
            ? context.selection
            : "",
      note:
        prioritizeReferences
          ? null
          : contextMode === "selection" ||
              contextMode === "note" ||
              contextMode === "note+selection"
            ? context.note
            : null,
      resolvedContextMode: prioritizeReferences ? "none" : contextMode,
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
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        throw new Error("当前桥接模式暂不支持附件，请切换到“直接 CLI”模式后再试。");
      }
      return this.runBridgeTask(payload);
    }
    return runCliTask(this, payload);
  }

  async executeTask({
    action,
    instruction,
    contextMode,
    openSidebar,
    attachments = [],
    references = [],
  }) {
    const payload = await this.buildPayload(action, instruction, contextMode, attachments, references);
    const shouldUseSidebar = openSidebar ?? this.settings.openSidebarOnRun;
    let taskHandle = null;

    if (shouldUseSidebar) {
      await this.activateSidebar();
      if (this.sidebarView) {
        taskHandle = this.sidebarView.beginTask({
          action,
          contextMode: payload.resolvedContextMode || contextMode,
          instruction,
          attachments: payload.attachments || [],
          references: (payload.references || []).map((note, index) => ({
            id: `ref-${note.path || index}`,
            title: note.title || "引用笔记",
            path: note.path || "",
          })),
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
        contextMode: payload.resolvedContextMode || contextMode,
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
