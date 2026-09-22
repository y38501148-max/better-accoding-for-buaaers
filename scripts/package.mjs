import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("release", { recursive: true });
execFileSync(
  process.execPath,
  [
    "node_modules/@vscode/vsce/vsce",
    "package",
    "--no-dependencies",
    "--out",
    "release/",
  ],
  { stdio: "inherit" },
);
