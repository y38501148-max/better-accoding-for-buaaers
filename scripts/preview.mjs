// Development-only synthetic workbench harness. No OJ credentials or requests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const binding = {
  schemaVersion: 2,
  bindingId: "problem-0",
  revision: 0,
  sourceFile: "problems/0/main.c",
  fetchedAt: new Date().toISOString(),
  tombstones: [],
  problem: {
    target: { kind: "problemset", problemId: "0" },
    title: "两数相加 · 合成演示",
    label: "#0",
    statement: {
      format: "html",
      content: "",
      baseUrl: "https://accoding.buaa.edu.cn/",
    },
    languages: ["c", "c++"],
    warnings: [],
    special: false,
    timeLimit: "1000 ms",
    memoryLimit: "65536 KB",
  },
  cases: [
    {
      id: "case-1",
      name: "样例 1",
      source: "sample",
      input: "2\n1 2\n2 3\n",
      expected: "3\n5\n",
      hasExpectedOutput: true,
      enabled: true,
      revision: 0,
      comparison: "exact",
      upstreamSampleKey: "sample-1",
      locallyModified: false,
      baseline: { input: "2\n1 2\n2 3\n", expected: "3\n5\n" },
    },
  ],
};
const html =
  "<h2>题目描述</h2><p>给定整数 $a$ 和 $b$，计算 $a+b$。本页面使用合成题目展示工作台。</p><h2>输入</h2><p>第一行是数据组数，随后每行两个整数。</p><h2>输出</h2><p>每组输出一行结果。</p><h2>输入样例</h2><pre>2\n1 2\n2 3\n</pre><h2>输出样例</h2><pre>3\n5\n</pre>";
const host = `let draft;const binding=${JSON.stringify(binding)};window.__host={saves:[],commands:[],fail:false,delay:150};window.acquireVsCodeApi=()=>({getState:()=>draft,setState:s=>{draft=structuredClone(s);window.__draft=draft;},postMessage:m=>{if(m.type==='ready')setTimeout(()=>window.postMessage({type:'binding',root:'/synthetic',binding,html:${JSON.stringify(html)}},'*'),0);if(m.type==='save'){window.__host.saves.push(structuredClone(m));setTimeout(()=>{if(m.baseRevision!==binding.revision){window.postMessage({type:'saveError',requestId:m.requestId,message:'外部修改冲突',conflict:structuredClone(binding)},'*');return;}if(window.__host.fail){window.postMessage({type:'saveError',requestId:m.requestId,message:'模拟磁盘写入失败'},'*');return;}binding.revision++;binding.cases=structuredClone(m.cases);for(const c of binding.cases)c.revision++;window.postMessage({type:'saved',requestId:m.requestId,revision:binding.revision,cases:binding.cases},'*');},window.__host.delay);}if(m.type==='command')window.__host.commands.push({command:m.command,cases:structuredClone(binding.cases)});}});`;
const page = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webview.css"><link rel="stylesheet" href="/katex/katex.min.css"><body><div id="app"></div><script>${host}</script><script src="/webview.js"></script></body></html>`;
createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(page);
      return;
    }
    const relative = decodeURIComponent(req.url?.slice(1) ?? "");
    if (
      !/^(webview\.(js|css)|katex\/(katex.min.css|fonts\/[A-Za-z0-9_.-]+))$/.test(
        relative,
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    const ext = path.extname(relative);
    res.setHeader(
      "content-type",
      ext === ".js"
        ? "application/javascript"
        : ext === ".css"
          ? "text/css"
          : "application/octet-stream",
    );
    res.end(await readFile(path.join("dist", relative)));
  } catch {
    res.writeHead(500).end();
  }
}).listen(4173, "127.0.0.1", () =>
  console.log("Synthetic workbench preview: http://127.0.0.1:4173"),
);
