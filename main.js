"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DifySyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  apiBase: "https://api.dify.ai/v1",
  apiKey: "",
  datasetId: ""
};
var DifySyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    // 本地文件名（不含扩展名） -> Dify 文档 ID
    this.docMap = {};
    // 被修改过但尚未同步的文件
    this.dirtyFiles = /* @__PURE__ */ new Set();
    // 恢复中的文件，跳过 create 事件的自动上传
    this.skipCreate = /* @__PURE__ */ new Set();
    // 插件初始化完成，防止启动时触发自动上传
    this.ready = false;
  }
  async onload() {
    await this.loadSettings();
    await this.syncDocMap();
    this.addRibbonIcon("upload-cloud", "\u4E0A\u4F20\u5168\u90E8\u5230 Dify", () => {
      this.fullSync();
    });
    this.addRibbonIcon("download-cloud", "\u4ECE Dify \u62C9\u53D6", () => {
      this.pullFromDify();
    });
    this.addCommand({
      id: "dify-upload-current",
      name: "\u4E0A\u4F20\u5F53\u524D\u6587\u4EF6\u5230 Dify",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.uploadFileToDify(file);
        } else {
          new import_obsidian.Notice("\u6CA1\u6709\u6253\u5F00\u7684\u6587\u4EF6");
        }
      }
    });
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!this.ready) return;
        if (!(file instanceof import_obsidian.TFile) || file.extension !== "md") return;
        if (this.skipCreate.has(file.basename)) {
          this.skipCreate.delete(file.basename);
          return;
        }
        this.uploadFileToDify(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.ready) return;
        if (file instanceof import_obsidian.TFile && file.extension === "md") {
          this.dirtyFiles.add(file.basename);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof import_obsidian.TFile) || file.extension !== "md") return;
        if (!this.docMap[file.basename]) return;
        new DeleteConfirmModal(
          this.app,
          `\u300C${file.basename}\u300D\u5DF2\u4ECE\u672C\u5730\u5220\u9664\uFF0C\u5982\u4F55\u5904\u7406 Dify \u4E2D\u7684\u6587\u6863\uFF1F`,
          // 从 Dify 拉取：下载恢复文件
          async () => {
            try {
              const docId = this.docMap[file.basename];
              const downloadRes = await this.request("GET", `/datasets/${this.settings.datasetId}/documents/${docId}/download`);
              if (downloadRes.url) {
                const res = await (0, import_obsidian.requestUrl)({ url: downloadRes.url, method: "GET" });
                this.skipCreate.add(file.basename);
                await this.app.vault.create(file.path, res.text);
                new import_obsidian.Notice(`\u5DF2\u6062\u590D: ${file.name}`);
              }
            } catch (e) {
              new import_obsidian.Notice(`\u6062\u590D\u5931\u8D25: ${e.message}`);
            }
          },
          // 从 Dify 删除
          () => this.deleteFromDify(file.basename)
        ).open();
      })
    );
    this.addSettingTab(new DifySyncSettingTab(this.app, this));
    const timer = setTimeout(() => {
      this.ready = true;
      clearTimeout(timer);
    }, 1e3);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = {
      apiBase: (data == null ? void 0 : data.apiBase) ?? DEFAULT_SETTINGS.apiBase,
      apiKey: (data == null ? void 0 : data.apiKey) ?? DEFAULT_SETTINGS.apiKey,
      datasetId: (data == null ? void 0 : data.datasetId) ?? DEFAULT_SETTINGS.datasetId
    };
    if (data == null ? void 0 : data.docMap) {
      this.docMap = data.docMap;
    }
  }
  async saveSettings() {
    await this.saveData({
      apiBase: this.settings.apiBase,
      apiKey: this.settings.apiKey,
      datasetId: this.settings.datasetId,
      docMap: this.docMap
    });
  }
  // 检测配置缺失时弹出设置弹框
  promptSettings(onSubmit) {
    new SettingsModal(this.app, this, onSubmit).open();
  }
  // 通用 JSON 请求
  async request(method, path, body) {
    const url = `${this.settings.apiBase}${path}`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method,
      headers: {
        "Authorization": `Bearer ${this.settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : void 0
    });
    return response.text ? response.json : null;
  }
  // 从 Dify 获取所有文档，建立 name -> id 映射
  async syncDocMap() {
    if (!this.settings.apiKey || !this.settings.datasetId) return;
    try {
      const res = await this.request("GET", `/datasets/${this.settings.datasetId}/documents`);
      const docs = res.data || [];
      this.docMap = {};
      for (const doc of docs) {
        const name = doc.name.replace(/\.md$/i, "");
        this.docMap[name] = doc.id;
      }
      await this.saveSettings();
    } catch (e) {
      console.error("\u540C\u6B65\u6587\u6863\u6620\u5C04\u5931\u8D25:", e);
    }
  }
  // 文件上传请求（使用 fetch，因为 requestUrl 不支持 FormData）
  async fileUpload(url, file, content) {
    const formData = new FormData();
    formData.append("file", new Blob([content], { type: "text/markdown" }), file.name);
    formData.append("indexing_technique", "high_quality");
    formData.append("process_rule", JSON.stringify({ mode: "automatic" }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.settings.apiKey}` },
      body: formData
    });
    return res.json();
  }
  // 上传文件（创建或更新）
  async uploadFileToDify(file) {
    if (!this.settings.apiKey || !this.settings.datasetId) {
      this.promptSettings(() => this.uploadFileToDify(file));
      return;
    }
    if (this.docMap[file.basename]) {
      await this.updateFileInDify(file);
    } else {
      await this.createFileInDify(file);
    }
  }
  // 创建新文档
  async createFileInDify(file, silent = false) {
    var _a;
    try {
      const content = await this.app.vault.read(file);
      const url = `${this.settings.apiBase}/datasets/${this.settings.datasetId}/document/create_by_file`;
      const res = await this.fileUpload(url, file, content);
      if ((_a = res == null ? void 0 : res.document) == null ? void 0 : _a.id) {
        this.docMap[file.basename] = res.document.id;
        await this.saveSettings();
        if (!silent) new import_obsidian.Notice(`\u5DF2\u4E0A\u4F20: ${file.name}`);
        return true;
      }
      if (!silent) new import_obsidian.Notice(`\u4E0A\u4F20\u5931\u8D25: ${JSON.stringify(res)}`);
      return false;
    } catch (e) {
      if (!silent) new import_obsidian.Notice(`\u4E0A\u4F20\u51FA\u9519: ${e.message}`);
      return false;
    }
  }
  // 更新文档（使用 update-by-file 接口）
  async updateFileInDify(file, silent = false) {
    const existingId = this.docMap[file.basename];
    if (!existingId) return this.createFileInDify(file, silent);
    try {
      const content = await this.app.vault.read(file);
      const url = `${this.settings.apiBase}/datasets/${this.settings.datasetId}/documents/${existingId}/update-by-file`;
      const res = await this.fileUpload(url, file, content);
      if (res == null ? void 0 : res.document) {
        this.dirtyFiles.delete(file.basename);
        if (!silent) new import_obsidian.Notice(`\u5DF2\u66F4\u65B0: ${file.name}`);
        return true;
      }
      if (!silent) new import_obsidian.Notice(`\u66F4\u65B0\u5931\u8D25: ${JSON.stringify(res)}`);
      return false;
    } catch (e) {
      if (!silent) new import_obsidian.Notice(`\u66F4\u65B0\u5931\u8D25: ${e.message}`);
      return false;
    }
  }
  // 删除文档
  async deleteFromDify(basename) {
    await this.syncDocMap();
    const docId = this.docMap[basename];
    if (!docId) return;
    try {
      await this.request("DELETE", `/datasets/${this.settings.datasetId}/documents/${docId}`);
      delete this.docMap[basename];
      await this.saveSettings();
      new import_obsidian.Notice("\u5DF2\u4ECE Dify \u5220\u9664\u6587\u6863");
    } catch (e) {
      new import_obsidian.Notice(`\u5220\u9664\u5931\u8D25: ${e.message}`);
    }
  }
  // 全量上传：区分新建、已修改和未变动
  async fullSync() {
    await this.syncDocMap();
    const files = this.app.vault.getMarkdownFiles();
    const newFiles = [];
    const modifiedFiles = [];
    for (const file of files) {
      if (!this.docMap[file.basename]) {
        newFiles.push(file);
      } else if (this.dirtyFiles.has(file.basename)) {
        modifiedFiles.push(file);
      }
    }
    if (newFiles.length === 0 && modifiedFiles.length === 0) {
      new import_obsidian.Notice("\u6240\u6709\u6587\u4EF6\u5747\u5DF2\u540C\u6B65\uFF0C\u65E0\u9700\u4E0A\u4F20");
      return;
    }
    const total = newFiles.length + modifiedFiles.length;
    let success = 0;
    for (const file of newFiles) {
      if (await this.createFileInDify(file, true)) success++;
    }
    for (const file of modifiedFiles) {
      if (await this.updateFileInDify(file, true)) success++;
    }
    new import_obsidian.Notice(`\u4E0A\u4F20\u5B8C\u6210\uFF1A${success}/${total} \u6210\u529F`);
  }
  // 从 Dify 拉取文档（仅拉取本地不存在的新文档）
  async pullFromDify() {
    if (!this.settings.apiKey || !this.settings.datasetId) {
      this.promptSettings(() => this.pullFromDify());
      return;
    }
    try {
      await this.syncDocMap();
      const localFiles = this.app.vault.getMarkdownFiles();
      const localBasenames = new Set(localFiles.map((f) => f.basename));
      const newEntries = Object.entries(this.docMap).filter(([name]) => !localBasenames.has(name));
      if (newEntries.length === 0) {
        new import_obsidian.Notice("\u5168\u90E8\u6587\u4EF6\u5747\u5DF2\u540C\u6B65\uFF0C\u65E0\u9700\u62C9\u53D6");
        return;
      }
      let success = 0;
      for (const [name, docId] of newEntries) {
        const downloadRes = await this.request("GET", `/datasets/${this.settings.datasetId}/documents/${docId}/download`);
        const downloadUrl = downloadRes.url;
        if (!downloadUrl) continue;
        const fileResponse = await (0, import_obsidian.requestUrl)({ url: downloadUrl, method: "GET" });
        this.skipCreate.add(name);
        await this.app.vault.create(name + ".md", fileResponse.text);
        success++;
      }
      await this.saveSettings();
      new import_obsidian.Notice(`\u62C9\u53D6\u5B8C\u6210\uFF1A${success}/${newEntries.length} \u6210\u529F`);
    } catch (e) {
      new import_obsidian.Notice(`\u62C9\u53D6\u5931\u8D25: ${e.message}`);
    }
  }
};
var DeleteConfirmModal = class extends import_obsidian.Modal {
  constructor(app, message, onPull, onDelete) {
    super(app);
    this.message = message;
    this.onPull = onPull;
    this.onDelete = onDelete;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
    const pullBtn = btnContainer.createEl("button", { text: "\u4ECE Dify \u62C9\u53D6" });
    pullBtn.addEventListener("click", () => {
      this.close();
      this.onPull();
    });
    const deleteBtn = btnContainer.createEl("button", { text: "\u4ECE Dify \u5220\u9664" });
    deleteBtn.classList.add("mod-warning");
    deleteBtn.addEventListener("click", () => {
      this.close();
      this.onDelete();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};
var SettingsModal = class extends import_obsidian.Modal {
  constructor(app, plugin, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "\u914D\u7F6E Dify \u540C\u6B65" });
    new import_obsidian.Setting(contentEl).setName("API \u57FA\u7840\u5730\u5740").addText((text) => text.setPlaceholder("https://api.dify.ai/v1").setValue(this.plugin.settings.apiBase).onChange((v) => this.plugin.settings.apiBase = v));
    new import_obsidian.Setting(contentEl).setName("API Key").addText((text) => text.setPlaceholder("\u8F93\u5165 API Key").setValue(this.plugin.settings.apiKey).onChange((v) => this.plugin.settings.apiKey = v));
    new import_obsidian.Setting(contentEl).setName("\u77E5\u8BC6\u5E93 ID").addText((text) => text.setPlaceholder("\u8F93\u5165\u77E5\u8BC6\u5E93 ID").setValue(this.plugin.settings.datasetId).onChange((v) => this.plugin.settings.datasetId = v));
    const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
    const submitBtn = btnContainer.createEl("button", { text: "\u4FDD\u5B58\u5E76\u7EE7\u7EED" });
    submitBtn.addEventListener("click", async () => {
      await this.plugin.saveSettings();
      this.close();
      this.onSubmit();
    });
    const cancelBtn = btnContainer.createEl("button", { text: "\u53D6\u6D88" });
    cancelBtn.addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
};
var DifySyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Dify \u540C\u6B65\u8BBE\u7F6E" });
    new import_obsidian.Setting(containerEl).setName("API \u57FA\u7840\u5730\u5740").setDesc("Dify API \u7684\u57FA\u7840 URL\uFF0C\u4F8B\u5982 https://api.dify.ai/v1").addText((text) => text.setPlaceholder("https://api.dify.ai/v1").setValue(this.plugin.settings.apiBase).onChange(async (value) => {
      this.plugin.settings.apiBase = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("API Key").setDesc("\u4F60\u7684 Dify \u77E5\u8BC6\u5E93 API \u5BC6\u94A5").addText((text) => text.setPlaceholder("\u8F93\u5165 API Key").setValue(this.plugin.settings.apiKey).onChange(async (value) => {
      this.plugin.settings.apiKey = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u77E5\u8BC6\u5E93 ID").setDesc("\u8981\u540C\u6B65\u7684 Dify \u77E5\u8BC6\u5E93 ID").addText((text) => text.setPlaceholder("\u8F93\u5165\u77E5\u8BC6\u5E93 ID").setValue(this.plugin.settings.datasetId).onChange(async (value) => {
      this.plugin.settings.datasetId = value;
      await this.plugin.saveSettings();
    }));
  }
};
