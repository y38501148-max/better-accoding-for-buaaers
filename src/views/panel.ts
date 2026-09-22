import * as vscode from "vscode";
import { randomBytes, randomUUID } from "node:crypto";
import type { Binding } from "../model";
import { renderStatement } from "../problems/statement";
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
  private codeColumn?: vscode.ViewColumn;
  constructor(
    private context: vscode.ExtensionContext,
    private onMessage: (message: unknown) => void,
    private onClose: () => void,
  ) {}
  async open(source: vscode.Uri, restore = false) {
    if (!this.panel || restore) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0,
        groups: [{ size: 0.45 }, { size: 0.55 }],
      });
      this.codeColumn = vscode.ViewColumn.Two;
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
    } else
      this.panel.reveal(
        restore ? vscode.ViewColumn.One : this.panel.viewColumn,
        true,
      );
    const existing = vscode.window.visibleTextEditors.find(
      (e) =>
        e.document.uri.toString() === source.toString() &&
        e.viewColumn !== this.panel?.viewColumn,
    );
    const column =
      existing?.viewColumn ??
      (this.codeColumn !== this.panel.viewColumn
        ? this.codeColumn
        : undefined) ??
      vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(source, {
      viewColumn: column,
      preview: false,
      preserveFocus: false,
    });
    this.codeColumn = editor.viewColumn;
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
    const nonce = randomBytes(18).toString("hex");
    const resource = (name: string) =>
      p.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", name),
      );
    p.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${p.webview.cspSource} https:; font-src ${p.webview.cspSource}; style-src ${p.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource("webview.css")}"><link rel="stylesheet" href="${resource("katex/katex.min.css")}"></head><body><div id="app"></div><script nonce="${nonce}" src="${resource("webview.js")}"></script></body></html>`;
    p.webview.onDidReceiveMessage((m: unknown) => {
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
  show(binding: Binding, root: string) {
    this.post({
      type: "binding",
      binding,
      root,
      html: renderStatement(
        binding.problem.statement.format,
        binding.problem.statement.content,
        binding.problem.statement.baseUrl,
      ),
    });
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
      this.post({ type: "flush", requestId });
    });
  }
}
