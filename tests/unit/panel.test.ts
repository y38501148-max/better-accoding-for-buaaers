import { expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { Workbench } from "../../src/views/panel";
import { problem } from "../fixtures/synthetic";
import type { Binding } from "../../src/model";
vi.mock("vscode", () => ({
  Uri: {
    joinPath: (_root: unknown, ...parts: string[]) => parts.join("/"),
    file: (file: string) => file,
  },
}));
vi.mock("../../src/problems/images", () => ({
  IMAGE_DIRECTORY: ".better-accoding/images",
  localStatementHtml: async () => "<p>synthetic</p>",
}));
function setup() {
  let receive: (m: unknown) => void = () => {};
  let close: () => void = () => {};
  const posted: { type: string; requestId?: string; renderVersion?: number }[] =
    [];
  const panel = {
    webview: {
      cspSource: "vscode-resource:",
      options: {},
      html: "",
      asWebviewUri: (uri: string) => uri,
      postMessage: (m: (typeof posted)[number]) => {
        posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (fn: typeof receive) => {
        receive = fn;
      },
    },
    onDidDispose: (fn: typeof close) => {
      close = fn;
    },
  };
  const context = { extensionUri: "extension", subscriptions: [] };
  const workbench = new Workbench(
    context as unknown as vscode.ExtensionContext,
    () => {},
    () => {},
  );
  workbench.restore(panel as unknown as vscode.WebviewPanel);
  const binding: Binding = {
    schemaVersion: 2,
    bindingId: "problem-0",
    problem,
    revision: 0,
    cases: [],
    tombstones: [],
    fetchedAt: "",
    sourceFile: "main.c",
  };
  return {
    workbench,
    binding,
    posted,
    receive: (m: unknown) => receive(m),
    close: () => close(),
  };
}
it("queues an early flush until the current binding and restored draft are ready", async () => {
  const f = setup();
  const flushed = f.workbench.flush();
  expect(f.posted).toEqual([]);
  f.receive({ type: "ready" });
  await f.workbench.show(f.binding, "/synthetic");
  expect(f.posted.map((m) => m.type)).toEqual(["binding"]);
  f.receive({ type: "bindingReady", renderVersion: f.posted[0].renderVersion });
  expect(f.posted.at(-1)?.type).toBe("flush");
  f.receive({ type: "flushed", requestId: f.posted.at(-1)!.requestId });
  await flushed;
});
it("ignores readiness from an obsolete render and propagates save failures", async () => {
  const f = setup();
  await f.workbench.show(f.binding, "/synthetic");
  const previous = f.posted.at(-1)!.renderVersion;
  await f.workbench.show(f.binding, "/synthetic");
  const current = f.posted.at(-1)!.renderVersion;
  const flushed = f.workbench.flush();
  const rejected = expect(flushed).rejects.toThrow("draft conflict");
  f.receive({ type: "bindingReady", renderVersion: previous });
  expect(f.posted.at(-1)?.type).toBe("binding");
  f.receive({ type: "bindingReady", renderVersion: current });
  f.receive({
    type: "flushed",
    requestId: f.posted.at(-1)!.requestId,
    error: "draft conflict",
  });
  await rejected;
});
it("cancels queued operations if the panel closes before loading", async () => {
  const f = setup();
  const flushed = f.workbench.flush();
  const rejected = expect(flushed).rejects.toThrow("面板已关闭");
  f.close();
  await rejected;
  expect(f.posted).toEqual([]);
});
