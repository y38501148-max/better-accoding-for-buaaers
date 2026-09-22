import * as vscode from "vscode";
import assert from "node:assert/strict";
import type { WorkspaceStore } from "../../src/workspace/store";
import type { Session } from "../../src/model";
import { problem } from "../fixtures/synthetic";
export async function run() {
  const extension = vscode.extensions.all.find(
    (e) => e.packageJSON.name === "better-accoding-for-buaaers",
  );
  assert(extension, "Extension installed");
  const api = (await extension.activate()) as {
    store(root: string): WorkspaceStore;
    commands: string[];
    open(s: Session): Promise<void>;
    getActive(): Session;
  };
  const commands = await vscode.commands.getCommands();
  for (const c of api.commands)
    assert(commands.includes("betterAccoding." + c), c);
  await vscode.commands.executeCommand(
    "workbench.view.extension.betterAccoding",
  );
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const store = api.store(root);
  const binding = await store.import(problem);
  const unrelated = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      "unrelated.txt",
    ),
  );
  await vscode.window.showTextDocument(unrelated);
  await api.open({ root, binding });
  assert.equal(api.getActive().binding.bindingId, "problem-0");
  assert(
    vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputWebview),
    ),
    "Statement panel exists",
  );
  assert(
    vscode.window.visibleTextEditors.some((e) =>
      e.document.uri.fsPath.endsWith("main.c"),
    ),
    "Native source editor visible",
  );
  assert(
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.toString() === unrelated.uri.toString(),
      ),
    "Unrelated editor retained",
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  await vscode.commands.executeCommand("betterAccoding.restoreLayout");
  assert(vscode.window.tabGroups.all.length >= 2);
  assert.equal((await store.read(binding.bindingId)).cases[0].input, "1 2\n");
  const layout = await vscode.commands.executeCommand<{
    groups: { size: number }[];
  }>("vscode.getEditorLayout");
  assert(layout && layout.groups.length === 2);
  const ratio =
    layout.groups[0].size / (layout.groups[0].size + layout.groups[1].size);
  assert(
    Math.abs(ratio - 0.3) < 0.02,
    `Workbench ratio should be 30%, received ${ratio}`,
  );
  console.log("Editor layout ratio:", ratio);
  if (process.env.ACCODING_PREVIEW_HOLD)
    await new Promise((resolve) => setTimeout(resolve, 45000));
  console.log(
    "Extension Host: activation, commands, disk import, two-column layout, flush ACK and unrelated editor preservation passed.",
  );
}
