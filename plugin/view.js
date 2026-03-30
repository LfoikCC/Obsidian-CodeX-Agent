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
