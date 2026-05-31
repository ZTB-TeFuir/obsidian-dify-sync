import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    Notice,
    requestUrl,
} from 'obsidian';

interface DifySyncSettings {
    apiBase: string;
    apiKey: string;
    datasetId: string;
}

const DEFAULT_SETTINGS: DifySyncSettings = {
    apiBase: 'https://api.dify.ai/v1',
    apiKey: '',
    datasetId: '',
};

export default class DifySyncPlugin extends Plugin {
    settings: DifySyncSettings;
    // 本地文件名（不含扩展名） -> Dify 文档 ID
    docMap: Record<string, string> = {};
    // 被修改过但尚未同步的文件
    dirtyFiles: Set<string> = new Set();

    async onload() {
        await this.loadSettings();

        // 初始化文档映射
        await this.syncDocMap();

        // 侧边栏按钮：全量上传
        this.addRibbonIcon('upload-cloud', '上传全部到 Dify', () => {
            this.fullSync();
        });

        // 侧边栏按钮：从 Dify 拉取
        this.addRibbonIcon('download-cloud', '从 Dify 拉取', () => {
            this.pullFromDify();
        });

        // 命令：上传当前文件
        this.addCommand({
            id: 'dify-upload-current',
            name: '上传当前文件到 Dify',
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    this.uploadFileToDify(file);
                } else {
                    new Notice('没有打开的文件');
                }
            },
        });

        // 监听文件创建
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.uploadFileToDify(file);
                }
            })
        );
        // 监听文件修改
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.dirtyFiles.add(file.basename);
                }
            })
        );
        // 监听文件删除
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.deleteFromDify(file.basename);
                }
            })
        );

        // 添加设置面板
        this.addSettingTab(new DifySyncSettingTab(this.app, this));
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            apiBase: data?.apiBase ?? DEFAULT_SETTINGS.apiBase,
            apiKey: data?.apiKey ?? DEFAULT_SETTINGS.apiKey,
            datasetId: data?.datasetId ?? DEFAULT_SETTINGS.datasetId,
        };
        if (data?.docMap) {
            this.docMap = data.docMap;
        }
    }

    async saveSettings() {
        await this.saveData({
            apiBase: this.settings.apiBase,
            apiKey: this.settings.apiKey,
            datasetId: this.settings.datasetId,
            docMap: this.docMap,
        });
    }

    // 通用 JSON 请求
    async request(method: string, path: string, body?: any): Promise<any> {
        const url = `${this.settings.apiBase}${path}`;
        const response = await requestUrl({
            url,
            method,
            headers: {
                'Authorization': `Bearer ${this.settings.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        // DELETE 等接口可能返回空响应体
        return response.text ? response.json : null;
    }

    // 从 Dify 获取所有文档，建立 name -> id 映射
    async syncDocMap() {
        if (!this.settings.apiKey || !this.settings.datasetId) return;
        try {
            const res = await this.request('GET', `/datasets/${this.settings.datasetId}/documents`);
            const docs = res.data || [];
            this.docMap = {};
            for (const doc of docs) {
                // 去掉扩展名，与本地 file.basename 保持一致
                const name = doc.name.replace(/\.md$/i, '');
                this.docMap[name] = doc.id;
            }
            await this.saveSettings();
        } catch (e) {
            console.error('同步文档映射失败:', e);
        }
    }

    // 文件上传请求（使用 fetch，因为 requestUrl 不支持 FormData）
    private async fileUpload(url: string, file: TFile, content: string): Promise<any> {
        const formData = new FormData();
        formData.append('file', new Blob([content], { type: 'text/markdown' }), file.name);
        formData.append('indexing_technique', 'high_quality');
        formData.append('process_rule', JSON.stringify({ mode: 'automatic' }));

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.settings.apiKey}` },
            body: formData,
        });
        return res.json();
    }

    // 上传文件（创建或更新）
    async uploadFileToDify(file: TFile) {
        if (!this.settings.apiKey || !this.settings.datasetId) {
            new Notice('请先配置 API Key 和知识库 ID');
            return;
        }
        if (this.docMap[file.basename]) {
            await this.updateFileInDify(file);
        } else {
            await this.createFileInDify(file);
        }
    }

    // 创建新文档
    async createFileInDify(file: TFile, silent = false): Promise<boolean> {
        try {
            const content = await this.app.vault.read(file);
            const url = `${this.settings.apiBase}/datasets/${this.settings.datasetId}/document/create_by_file`;
            const res = await this.fileUpload(url, file, content);
            if (res?.document?.id) {
                this.docMap[file.basename] = res.document.id;
                await this.saveSettings();
                if (!silent) new Notice(`已上传: ${file.name}`);
                return true;
            }
            if (!silent) new Notice(`上传失败: ${JSON.stringify(res)}`);
            return false;
        } catch (e: any) {
            if (!silent) new Notice(`上传出错: ${e.message}`);
            return false;
        }
    }

    // 更新文档（使用 update-by-file 接口）
    async updateFileInDify(file: TFile, silent = false): Promise<boolean> {
        const existingId = this.docMap[file.basename];
        if (!existingId) return this.createFileInDify(file, silent);
        try {
            const content = await this.app.vault.read(file);
            const url = `${this.settings.apiBase}/datasets/${this.settings.datasetId}/documents/${existingId}/update-by-file`;
            const res = await this.fileUpload(url, file, content);
            if (res?.document) {
                this.dirtyFiles.delete(file.basename);
                if (!silent) new Notice(`已更新: ${file.name}`);
                return true;
            }
            if (!silent) new Notice(`更新失败: ${JSON.stringify(res)}`);
            return false;
        } catch (e: any) {
            if (!silent) new Notice(`更新失败: ${e.message}`);
            return false;
        }
    }

    // 删除文档
    async deleteFromDify(basename: string) {
        await this.syncDocMap();
        const docId = this.docMap[basename];
        if (!docId) return;
        try {
            await this.request('DELETE', `/datasets/${this.settings.datasetId}/documents/${docId}`);
            delete this.docMap[basename];
            await this.saveSettings();
            new Notice('已从 Dify 删除文档');
        } catch (e: any) {
            new Notice(`删除失败: ${e.message}`);
        }
    }

    // 全量上传：区分新建、已修改和未变动
    async fullSync() {
        await this.syncDocMap();
        const files = this.app.vault.getMarkdownFiles();
        const newFiles: TFile[] = [];
        const modifiedFiles: TFile[] = [];

        for (const file of files) {
            if (!this.docMap[file.basename]) {
                newFiles.push(file);
            } else if (this.dirtyFiles.has(file.basename)) {
                modifiedFiles.push(file);
            }
        }

        if (newFiles.length === 0 && modifiedFiles.length === 0) {
            new Notice('所有文件均已同步，无需上传');
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

        new Notice(`上传完成：${success}/${total} 成功`);
    }

    // 从 Dify 拉取文档（仅拉取本地不存在的新文档）
    async pullFromDify() {
        if (!this.settings.apiKey || !this.settings.datasetId) {
            new Notice('请先配置 API Key 和知识库 ID');
            return;
        }
        try {
            await this.syncDocMap();

            // 筛选出本地不存在的文档
            const localFiles = this.app.vault.getMarkdownFiles();
            const localBasenames = new Set(localFiles.map(f => f.basename));
            const newEntries = Object.entries(this.docMap).filter(([name]) => !localBasenames.has(name));

            if (newEntries.length === 0) {
                new Notice('全部文件均已同步，无需拉取');
                return;
            }

            let success = 0;
            for (const [name, docId] of newEntries) {
                const downloadRes = await this.request('GET', `/datasets/${this.settings.datasetId}/documents/${docId}/download`);
                const downloadUrl = downloadRes.url;
                if (!downloadUrl) continue;

                const fileResponse = await requestUrl({ url: downloadUrl, method: 'GET' });
                await this.app.vault.create(name + '.md', fileResponse.text);
                success++;
            }
            await this.saveSettings();
            new Notice(`拉取完成：${success}/${newEntries.length} 成功`);
        } catch (e: any) {
            new Notice(`拉取失败: ${e.message}`);
        }
    }
}

class DifySyncSettingTab extends PluginSettingTab {
    plugin: DifySyncPlugin;

    constructor(app: App, plugin: DifySyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Dify 同步设置' });

        new Setting(containerEl)
            .setName('API 基础地址')
            .setDesc('Dify API 的基础 URL，例如 https://api.dify.ai/v1')
            .addText(text => text
                .setPlaceholder('https://api.dify.ai/v1')
                .setValue(this.plugin.settings.apiBase)
                .onChange(async (value) => {
                    this.plugin.settings.apiBase = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('你的 Dify 知识库 API 密钥')
            .addText(text => text
                .setPlaceholder('输入 API Key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('知识库 ID')
            .setDesc('要同步的 Dify 知识库 ID')
            .addText(text => text
                .setPlaceholder('输入知识库 ID')
                .setValue(this.plugin.settings.datasetId)
                .onChange(async (value) => {
                    this.plugin.settings.datasetId = value;
                    await this.plugin.saveSettings();
                }));
    }
}