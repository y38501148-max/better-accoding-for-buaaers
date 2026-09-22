import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
const files = execFileSync(
  process.execPath,
  ["node_modules/@vscode/vsce/vsce", "ls", "--no-dependencies"],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/);
for (const required of [
  "dist/extension.js",
  "dist/webview.js",
  "dist/webview.css",
  "dist/katex/katex.min.css",
  "media/icon.png",
  "LICENSE",
  "PRIVACY.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  await access(required);
  if (!files.includes(required))
    throw Error(`Missing package resource: ${required}`);
}
if (!files.some((f) => f.startsWith("dist/katex/fonts/")))
  throw Error("KaTeX fonts missing");
for (const file of files) {
  if (
    /(^|\/)(\.env[^/]*|tests|node_modules|release|\.git|\.vscode-test)(\/|$)|\.(log|vsix|map)$/.test(
      file,
    )
  )
    throw Error(`Unexpected package entry: ${file}`);
  if (/\.(json|js|md)$/.test(file)) {
    const text = await readFile(file, "utf8");
    if (
      /gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
        text,
      )
    )
      throw Error(`Credential pattern found in ${file}`);
  }
}
console.log(
  `Package allowlist verified: ${files.length} files; local fonts present.`,
);
