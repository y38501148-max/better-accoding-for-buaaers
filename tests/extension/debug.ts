import * as vscode from "vscode";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceStore } from "../../src/workspace/store";
import type { Session } from "../../src/model";
import { problem } from "../fixtures/synthetic";
export async function run() {
  const extension = vscode.extensions.all.find(
    (e) => e.packageJSON.name === "better-accoding-for-buaaers",
  )!;
  const api = (await extension.activate()) as {
    store(root: string): WorkspaceStore;
    open(s: Session): Promise<void>;
    debugTestCase(id: string): Promise<void>;
  };
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const store = api.store(root);
  let binding = await store.import(problem);
  binding.cases[0].input = "41\n";
  binding = await store.saveCases(
    binding.bindingId,
    binding.revision,
    binding.cases,
  );
  const source = path.join(root, binding.sourceFile);
  await fs.writeFile(
    source,
    '#include <stdio.h>\nint main(void) {\n    int value = 0;\n    scanf("%d", &value);\n    printf("%d\\n", value + 1);\n    return 0;\n}\n',
  );
  await api.open({ root, binding });
  await new Promise((r) => setTimeout(r, 700));
  const point = new vscode.SourceBreakpoint(
    new vscode.Location(vscode.Uri.file(source), new vscode.Position(4, 0)),
  );
  vscode.debug.addBreakpoints([point]);
  let stopped = false,
    output = "",
    session: vscode.DebugSession | undefined;
  let resolveDone: () => void = () => {},
    rejectDone: (e: unknown) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timer = setTimeout(
    () => rejectDone(Error("Debug acceptance timed out")),
    60000,
  );
  void done.catch(() => {});
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory("lldb", {
    createDebugAdapterTracker(current) {
      session = current;
      return {
        onDidSendMessage(message) {
          if (message.type !== "event") return;
          if (message.event === "output") {
            output += message.body?.output ?? "";
          }
          if (message.event === "stopped")
            void (async () => {
              try {
                assert.equal(message.body.reason, "breakpoint");
                stopped = true;
                const trace = await current.customRequest("stackTrace", {
                  threadId: message.body.threadId,
                  startFrame: 0,
                  levels: 1,
                });
                const value = await current.customRequest("evaluate", {
                  expression: "value",
                  frameId: trace.stackFrames[0].id,
                  context: "watch",
                });
                assert.equal(
                  value.result,
                  "41",
                  "Selected test input reached scanf",
                );
                await current.customRequest("continue", {
                  threadId: message.body.threadId,
                });
              } catch (e) {
                rejectDone(e);
              }
            })();
          if (message.event === "terminated") resolveDone();
        },
      };
    },
  });
  try {
    await api.debugTestCase(binding.cases[0].id);
    await done;
    assert(stopped, "Source breakpoint hit");
    assert(
      output.includes("42"),
      "Program continued and produced expected output",
    );
    console.log(
      "macOS CodeLLDB: Chinese/space path, selected stdin, source breakpoint, variable value=41, continue/output=42 and termination passed.",
    );
  } finally {
    clearTimeout(timer);
    tracker.dispose();
    vscode.debug.removeBreakpoints([point]);
    if (session) await vscode.debug.stopDebugging(session);
  }
}
