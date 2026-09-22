import * as vscode from "vscode";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { JudgeResult } from "../../src/judge/judge";
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
    editTestCaseInput(id: string): Promise<void>;
    runTestCase(id: string): Promise<void>;
    getResult(): JudgeResult | undefined;
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
  const totalWidth = layout.groups[0].size + layout.groups[1].size;
  if (totalWidth * 0.3 >= 220) {
    assert(
      Math.abs(ratio - 0.3) < 0.02,
      `Workbench ratio should be 30%, received ${ratio}`,
    );
  } else {
    // A narrow editor area cannot always fit two 220px groups (e.g. Stable's
    // startup auxiliary bar). Both groups must remain visible; code gets >= half.
    assert(layout.groups[0].size > 0, "Workbench remains visible");
    assert(
      layout.groups[1].size >= layout.groups[0].size - 2,
      `Code editor retains at least half the available width: ${JSON.stringify(layout.groups)}`,
    );
  }

  console.log("Editor layout ratio:", ratio);
  await api.editTestCaseInput(binding.cases[0].id);
  const inputDocument = vscode.window.activeTextEditor!.document;
  assert.equal(
    inputDocument.uri.scheme,
    "file",
    "Native editor opens a persistent file",
  );
  assert(inputDocument.uri.fsPath.endsWith(".in"));
  const change = new vscode.WorkspaceEdit();
  change.replace(
    inputDocument.uri,
    new vscode.Range(
      inputDocument.positionAt(0),
      inputDocument.positionAt(inputDocument.getText().length),
    ),
    "3 4\n",
  );
  assert(await vscode.workspace.applyEdit(change));
  // Do not save manually: running must flush dirty native test files itself.
  await fs.writeFile(
    path.join(root, binding.sourceFile),
    '#include <stdio.h>\nint main(void){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);return 0;}\n',
  );
  await api.runTestCase(binding.cases[0].id);
  assert.equal((await store.read(binding.bindingId)).cases[0].input, "3 4\n");
  assert.equal(
    api.getResult()?.cases[0].stdout.replace(/\r\n/g, "\n"),
    "7\n",
    "Immediate run used latest native-editor input",
  );
  console.log(
    "Native case editor: persistent .in file, unsaved edit flushed before Judge, latest input reached stdin.",
  );

  if (process.env.ACCODING_PREVIEW_CONTEST) {
    let first: Session | undefined;
    for (const order of [9, 2, 8, 0, 6, 1, 5, 3, 7, 4]) {
      const binding = await store.import({
        ...structuredClone(problem),
        target: {
          kind: "contest",
          contestId: "7",
          problemId: String(900 - order),
          contestOrder: order,
        },
        label: "旧缓存标签",
        title: `合成题目 ${String.fromCharCode(65 + order)}`,
      });
      if (order === 0) first = { root, binding };
    }
    await api.open(first!);
    console.log(
      "Synthetic contest A–J ready for native selection verification.",
    );
  }
  if (process.env.ACCODING_PREVIEW_HOLD)
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        process.env.ACCODING_PREVIEW_CONTEST ? 180000 : 45000,
      ),
    );
  console.log(
    "Extension Host: activation, commands, disk import, two-column layout, flush ACK and unrelated editor preservation passed.",
  );
}
