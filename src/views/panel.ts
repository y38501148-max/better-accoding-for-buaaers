import * as vscode from "vscode";
import { randomBytes, randomUUID } from "node:crypto";
import type { Binding } from "../model";
import { localStatementHtml, IMAGE_DIRECTORY } from "../problems/images";
export class Workbench {
  panel?: vscode.WebviewPanel;
  private pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private renderVersion = 0;
  private bindingReady = false;
  constructor(
    private context: vscode.ExtensionContext,
    private onMessage: (message: unknown) => void,
    private onClose: () => void,
  ) {}
  async open(
    source: vscode.Uri,
    restore = false,
    managedSources: vscode.Uri[] = [source],
  ) {
    const managed = new Set(managedSources.map((uri) => uri.toString()));
    // Save only bound problem sources before replacing their editor tabs.
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.isDirty &&
        managed.has(document.uri.toString()) &&
        !(await document.save())
      )
        throw new Error("源码未能保存，已取消切题以保留编辑内容。");
    }
    const applyLayout =
      !this.panel ||
      restore ||
      vscode.window.tabGroups.all.length !== 2 ||
      this.panel.viewColumn !== vscode.ViewColumn.One;
    if (applyLayout) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0,
        groups: [{}, {}],
      });
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "betterAccoding.workbench",
        "Accoding 工作台",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, "dist"),
            vscode.Uri.joinPath(this.context.extensionUri, "media"),
          ],
        },
      );
      this.initialize(this.panel);
    } else this.panel.reveal(vscode.ViewColumn.One, true);
    await vscode.window.showTextDocument(source, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
      preserveFocus: false,
    });
    const stale = vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          managed.has(tab.input.uri.toString()) &&
          (tab.input.uri.toString() !== source.toString() ||
            group.viewColumn !== vscode.ViewColumn.Two),
      ),
    );
    if (stale.length) await vscode.window.tabGroups.close(stale, true);
    if (applyLayout) {
      const layout = await vscode.commands.executeCommand<{
        groups: { size?: number }[];
      }>("vscode.getEditorLayout");
      const width =
        layout?.groups.reduce((sum, group) => sum + (group.size ?? 0), 0) ?? 0;
      if (width > 0) {
        // Apply pixel sizes after revealing both groups so VS Code does not expand
        // an undersized group on focus. Respect the editor's minimum width.
        const left = Math.min(width / 2, Math.max(220, width * 0.3));
        await vscode.commands.executeCommand("vscode.setEditorLayout", {
          orientation: 0,
          groups: [{ size: left }, { size: width - left }],
        });
      }
    }
  }
  async openCaseFile(document: vscode.TextDocument) {
    return vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
    });
  }
  restore(panel: vscode.WebviewPanel) {
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    this.initialize(panel);
  }
  private initialize(p: vscode.WebviewPanel) {
    this.bindingReady = false;
    const nonce = randomBytes(18).toString("hex");
    const resource = (name: string) =>
      p.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", name),
      );
    p.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${p.webview.cspSource}; font-src ${p.webview.cspSource}; style-src ${p.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource("webview.css")}"><link rel="stylesheet" href="${resource("katex/katex.min.css")}"></head><body><div id="app"></div><script nonce="${nonce}" src="${resource("webview.js")}"></script></body></html>`;
    p.webview.onDidReceiveMessage((m: unknown) => {
      if (p !== this.panel) return;
      if (typeof m === "object" && m !== null && "type" in m) {
        if (m.type === "ready") this.bindingReady = false;
        if (m.type === "bindingReady") {
          if ("renderVersion" in m && m.renderVersion === this.renderVersion) {
            this.bindingReady = true;
            for (const requestId of this.pending.keys())
              this.post({ type: "flush", requestId });
          }
          return;
        }
      }
      if (
        typeof m === "object" &&
        m !== null &&
        "type" in m &&
        m.type === "flushed" &&
        "requestId" in m &&
        typeof m.requestId === "string"
      ) {
        const req = this.pending.get(m.requestId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(m.requestId);
          if ("error" in m && m.error) req.reject(new Error(String(m.error)));
          else req.resolve();
        }
        return;
      }
      this.onMessage(m);
    });
    p.onDidDispose(() => {
      this.panel = undefined;
      this.renderVersion++;
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error("面板已关闭，操作取消。"));
      }
      this.pending.clear();
      this.onClose();
    });
    this.context.subscriptions.push(p);
  }
  post(message: unknown) {
    void this.panel?.webview.postMessage(message);
  }
  async show(binding: Binding, root: string) {
    const panel = this.panel;
    if (!panel) return;
    const version = ++this.renderVersion;
    this.bindingReady = false;
    const html = await localStatementHtml(binding.problem, root, (file) =>
      panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(),
    );
    if (this.panel !== panel || version !== this.renderVersion) return;
    panel.webview.options = {
      ...panel.webview.options,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(vscode.Uri.file(root), IMAGE_DIRECTORY),
      ],
    };
    this.post({ type: "binding", binding, root, html, renderVersion: version });
  }
  async flush() {
    if (!this.panel) return;
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("未收到用例保存确认，已取消操作以保护草稿。"));
      }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      if (this.bindingReady) this.post({ type: "flush", requestId });
    });
  }
}
