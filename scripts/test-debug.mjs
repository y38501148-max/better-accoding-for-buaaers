import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
if (process.platform !== "darwin")
  throw Error("This acceptance script currently targets macOS CodeLLDB only.");
const root = process.cwd();
const profile = await mkdtemp(path.join(os.tmpdir(), "accoding-debug-"));
const workspace = path.join(profile, "调试 空格");
await mkdir(workspace);
const extensions = path.join(root, ".vscode-test/debug-extensions");
const executable = await downloadAndUnzipVSCode("1.96.4");
const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
execFileSync(
  cli,
  [
    ...args,
    "--user-data-dir",
    path.join(profile, "user"),
    "--extensions-dir",
    extensions,
    "--install-extension",
    "vadimcn.vscode-lldb@1.12.3",
  ],
  { stdio: "inherit" },
);
await build({
  entryPoints: ["tests/extension/debug.ts"],
  outfile: ".vscode-test/debug-test.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, ".vscode-test/debug-test.cjs"),
  launchArgs: [
    workspace,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--user-data-dir",
    path.join(profile, "user"),
    "--extensions-dir",
    extensions,
  ],
});
