import { build } from "esbuild";
import { rm, mkdir, cp, copyFile } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  minify: true,
});
await build({
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  target: "chrome120",
  minify: true,
});
await copyFile("webview/style.css", "dist/webview.css");
await cp("node_modules/katex/dist/fonts", "dist/katex/fonts", {
  recursive: true,
});
await copyFile(
  "node_modules/katex/dist/katex.min.css",
  "dist/katex/katex.min.css",
);
console.log("Built extension, workbench and local KaTeX resources.");
