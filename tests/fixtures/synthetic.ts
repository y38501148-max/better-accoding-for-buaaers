import type { Problem } from "../../src/model";
export const problem: Problem = {
  target: { kind: "problemset", problemId: "0" },
  title: "合成求和题",
  label: "#0",
  statement: {
    format: "markdown",
    content: "## 输入样例\n\n    1 2\n\n## 输出样例\n\n    3\n",
    baseUrl: "https://accoding.buaa.edu.cn/problem/0/index",
  },
  languages: ["c", "c++"],
  samples: [{ key: "sample-1", input: "1 2\n", expected: "3\n" }],
  warnings: [],
  special: false,
};
export const problemPage = `<html><body><nav>DO NOT CACHE ACCOUNT</nav><div class="markdown-body"><h1 class="problem-title">合成题</h1><p>时间限制: 1000 ms 内存限制: 65536 kb</p><h2>输入样例</h2><pre><code>1 2\n</code></pre><h2>输出样例</h2><pre><code>3\n</code></pre><script>steal()</script></div><form action="./submit"><input name="_csrf" value="SYNTHETIC-CSRF"><select name="lang"><option value="c">C</option></select><textarea name="code"></textarea></form></body></html>`;
export const contest = {
  id: 7,
  title: "Synthetic",
  problems: [
    {
      id: 22,
      title: "B",
      description: problem.statement.content,
      test_setting: JSON.stringify({ supported_languages: "c++,c" }),
      contest_problem_list: { order: 90 },
    },
    {
      id: 11,
      title: "A",
      description: problem.statement.content,
      test_setting: JSON.stringify({ supported_languages: "c" }),
      contest_problem_list: { order: 30 },
    },
  ],
};
