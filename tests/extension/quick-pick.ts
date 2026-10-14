import * as vscode from "vscode";

// Exercise the real native language picker in the isolated Extension Host.
export async function withLanguagePick(
  action: () => Promise<void>,
  selection: "first" | "next" | "cancel" = "first",
) {
  const timer = setTimeout(() => {
    void (async () => {
      if (selection === "cancel") {
        await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      } else {
        if (selection === "next")
          await vscode.commands.executeCommand(
            "workbench.action.quickOpenSelectNext",
          );
        await vscode.commands.executeCommand(
          "workbench.action.acceptSelectedQuickOpenItem",
        );
      }
    })();
  }, 1500);
  try {
    await action();
  } finally {
    clearTimeout(timer);
  }
}
