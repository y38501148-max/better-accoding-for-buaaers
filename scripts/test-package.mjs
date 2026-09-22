import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "esbuild";
const root = process.cwd();
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const profile = await mkdtemp(path.join(os.tmpdir(), "accoding-vsix-"));
const extensions = path.join(profile, "extensions");
const user = path.join(profile, "user");
const workspace = path.join(profile, "workspace");
await mkdir(workspace);
await writeFile(path.join(workspace, "unrelated.txt"), "Existing editor");
const executable = await downloadAndUnzipVSCode("1.96.4");
const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);
execFileSync(
  cli,
  [
    ...args,
    "--user-data-dir",
    user,
    "--extensions-dir",
    extensions,
    "--install-extension",
    process.env.ACCODING_INSTALL_SOURCE ??
      path.join(root, `release/${manifest.name}-${manifest.version}.vsix`),
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
const installed = (await readdir(extensions)).find((d) =>
  d.startsWith("muzermat.better-accoding-for-buaaers-"),
);
if (!installed) throw Error("VSIX installation not found");
await build({
  entryPoints: ["tests/extension/suite.ts"],
  outfile: ".vscode-test/packaged-suite.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: path.join(extensions, installed),
  extensionTestsPath: path.join(root, ".vscode-test/packaged-suite.cjs"),
  launchArgs: [
    workspace,
    "--user-data-dir",
    user,
    "--extensions-dir",
    extensions,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ],
});
console.log(
  "Clean profile installed extension and activated its bundled code successfully.",
);
