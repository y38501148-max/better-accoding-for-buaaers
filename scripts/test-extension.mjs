import { runTests } from "@vscode/test-electron";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = process.cwd();
const profile = await mkdtemp(path.join(os.tmpdir(), "better-accoding-host-"));
const workspace = path.join(profile, "workspace");
await mkdir(workspace);
await writeFile(
  path.join(workspace, "unrelated.txt"),
  "Unrelated editor must stay open.",
);
await build({
  entryPoints: ["tests/extension/suite.ts"],
  outfile: ".vscode-test/extension-test.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
await runTests({
  version: process.env.VSCODE_VERSION || "1.96.4",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, ".vscode-test/extension-test.cjs"),
  launchArgs: [
    workspace,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-updates",
    "--user-data-dir",
    path.join(profile, "user"),
    "--extensions-dir",
    path.join(profile, "extensions"),
  ],
});
