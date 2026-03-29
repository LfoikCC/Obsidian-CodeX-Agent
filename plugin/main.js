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

  async buildPayload(action, instruction, contextMode, attachments = []) {
    const normalizedAttachments = this.normalizeAttachments(attachments);

    if (contextMode === "none") {
      return {
        action,
        instruction,
        selection: "",
        note: null,
        attachments: normalizedAttachments,
        resolvedContextMode: "none",
        client: {
          name: "obsidian-codex-agent",
          version: PLUGIN_VERSION,
        },
      };
    }

    let context = null;
    try {
      context = await this.requireMarkdownContext();
    } catch (error) {
      if (!(normalizedAttachments.length > 0 && (action === "chat" || action === "create_note"))) {
        throw error;
      }
    }

    if (!context) {
      return {
        action,
        instruction,
        selection: "",
        note: null,
        attachments: normalizedAttachments,
        resolvedContextMode: "none",
        client: {
          name: "obsidian-codex-agent",
          version: PLUGIN_VERSION,
        },
      };
    }

    if (contextMode === "selection" && !context.selection.trim()) {
      throw new Error("请先选中一些文本。");
    }

    return {
      action,
      instruction,
      attachments: normalizedAttachments,
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
      resolvedContextMode: contextMode,
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

  async executeTask({ action, instruction, contextMode, openSidebar, attachments = [] }) {
    const payload = await this.buildPayload(action, instruction, contextMode, attachments);
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
