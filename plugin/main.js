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
let electronWebUtils = null;
try {
  const electron = require("electron");
  if (electron?.webUtils && typeof electron.webUtils.getPathForFile === "function") {
    electronWebUtils = electron.webUtils;
  }
} catch (_error) {
  electronWebUtils = null;
}
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
  truncateText,
  trimTrailingSlash,
} = require("./shared");
const { checkCliRunner, runCliTask } = require("./runtime");
const { CodexAgentView, CodexInputModal } = require("./view");

function resolveAttachmentPath(fileLike) {
  for (const candidate of [fileLike?.path, fileLike?.originalPath, fileLike?.filePath]) {
    const resolved = String(candidate || "").trim();
    if (resolved) {
      return resolved;
    }
  }

  if (electronWebUtils?.getPathForFile && fileLike) {
    try {
      const resolved = String(electronWebUtils.getPathForFile(fileLike) || "").trim();
      if (resolved) {
        return resolved;
      }
    } catch (_error) {
      // Fall through to empty path handling below.
    }
  }

  return "";
}

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
      .setName("极速模型")
      .setDesc("极速回复开启时优先使用的小模型。默认使用官方在 Codex 中可用且更快的 `gpt-5.4-mini`。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.fastResponseModel)
          .setValue(this.plugin.settings.fastResponseModel || DEFAULT_SETTINGS.fastResponseModel)
          .onChange(async (value) => {
            this.plugin.settings.fastResponseModel =
              value.trim() || DEFAULT_SETTINGS.fastResponseModel;
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
      .setName("极速回复")
      .setDesc("默认开启。会强制使用低推理强度，并压缩笔记上下文，尽量缩短等待时间。")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.fastResponseMode))
          .onChange(async (value) => {
            this.plugin.settings.fastResponseMode = Boolean(value);
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
    let migrated = false;
    if (
      !String(this.settings.fastResponseModel || "").trim() ||
      this.settings.fastResponseModel === "openai-codex/gpt-5.4-mini"
    ) {
      this.settings.fastResponseModel = DEFAULT_SETTINGS.fastResponseModel;
      migrated = true;
    }
    if (migrated) {
      await this.saveSettings();
    }
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
    const attachmentPath = resolveAttachmentPath(fileLike);
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

  getFastContextLimits(action, hasSelection) {
    if (action === "rewrite") {
      return {
        selectionChars: 3200,
        noteChars: 1600,
        referenceChars: 1200,
        maxReferences: 2,
      };
    }

    if (action === "summarize") {
      return {
        selectionChars: 1800,
        noteChars: 3600,
        referenceChars: 1600,
        maxReferences: 2,
      };
    }

    return {
      selectionChars: hasSelection ? 1200 : 600,
      noteChars: hasSelection ? 1400 : 1800,
      referenceChars: 1200,
      maxReferences: 2,
    };
  }

  compactNoteContext(note, maxContentChars) {
    if (!note) {
      return null;
    }

    return Object.assign({}, note, {
      content: truncateText(note.content || "", maxContentChars),
      headings: Array.isArray(note.headings) ? note.headings.slice(0, 12) : [],
    });
  }

  optimizePayloadForSpeed(payload) {
    if (!this.settings.fastResponseMode) {
      return Object.assign({}, payload, {
        fastMode: false,
      });
    }

    const limits = this.getFastContextLimits(
      payload.action,
      Boolean(String(payload.selection || "").trim())
    );

    return Object.assign({}, payload, {
      fastMode: true,
      selection: truncateText(payload.selection || "", limits.selectionChars),
      note: this.compactNoteContext(payload.note, limits.noteChars),
      references: Array.isArray(payload.references)
        ? payload.references
            .slice(0, limits.maxReferences)
            .map((note) => this.compactNoteContext(note, limits.referenceChars))
        : [],
    });
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

  async buildPayload(
    action,
    instruction,
    contextMode,
    attachments = [],
    references = [],
    includeCurrentNote = true
  ) {
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

      return this.optimizePayloadForSpeed({
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
      });
    }

    if (!includeCurrentNote && action !== "rewrite") {
      const referenceNotes = await this.loadReferencedNotes(normalizedReferences);
      if (
        action === "summarize" &&
        normalizedAttachments.length === 0 &&
        referenceNotes.length === 0
      ) {
        throw new Error("请先引用至少一篇笔记、上传文件，或重新开启当前笔记引用后再执行总结。");
      }

      return this.optimizePayloadForSpeed({
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
      });
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

      return this.optimizePayloadForSpeed({
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
      });
    }

    if ((action === "rewrite" || contextMode === "selection") && !context.selection.trim()) {
      throw new Error("请先选中一些文本。");
    }

    return this.optimizePayloadForSpeed({
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
    });
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
    includeCurrentNote = true,
  }) {
    const payload = await this.buildPayload(
      action,
      instruction,
      contextMode,
      attachments,
      references,
      includeCurrentNote
    );
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
