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
