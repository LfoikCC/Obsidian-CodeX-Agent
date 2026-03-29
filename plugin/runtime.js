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
