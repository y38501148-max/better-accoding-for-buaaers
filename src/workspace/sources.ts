import type { Binding, Target } from "../model";

export const cTemplate =
  "#include <stdio.h>\n\nint main() {\n    return 0;\n}\n";
// Expanded from the local VS Code Codeforces snippet; $0 is the editing cursor.
export const cppTemplate = [
  "#include <algorithm>",
  "#include <iostream>",
  "#include <queue>",
  "#include <vector>",
  "#include <unordered_map>",
  "#include <cstring>",
  "#include <iomanip>",
  "#include <cmath>",
  "#include <complex>",
  "#include <cassert>",
  "#define endl '\\n'",
  "#define x first",
  "#define y second",
  "#define lowbit(x) x&(-x)",
  "using namespace std;",
  "using cd = complex<double>;",
  "using PII = pair<int, int>;",
  "using LL = long long;",
  "using VVLL = vector<vector<LL>>;",
  "using VLL = vector<long long>;",
  "using VI = vector<int>;",
  "using VVI = vector<vector<int>>;",
  "using PLL = pair<LL, LL>;",
  "const double PI = acos(-1.0);",
  "",
  "const LL MOD = 1e9 + 7;",
  "",
  "struct Martix {",
  "    int n, m;",
  "    VVLL a;",
  "    Martix(int n, int m) : n(n), m(m), a(n, VLL(m, 0)) {}",
  "",
  "    Martix operator*(const Martix& other) const {",
  "        assert(m == other.n);",
  "        Martix res(n, other.m);",
  "",
  "        for (int i = 0; i < n; i++) {",
  "            for (int k = 0; k < m; k++) {",
  "                for (int j = 0; j < other.m; j++) {",
  "                    res.a[i][j] = (res.a[i][j] + (a[i][k] * other.a[k][j] % MOD)) % MOD;",
  "                }",
  "            }",
  "        }",
  "        return res;",
  "    }",
  "};",
  "",
  "void solve() {",
  "    ",
  "}",
  "",
  "int main() {",
  "    ios::sync_with_stdio(false);",
  "    cin.tie(0);",
  "    int T;",
  "    cin >> T;",
  "    while (T--) {",
  "        solve();",
  "    }",
  "    return 0;",
  "}",
  "",
].join("\n");

export function defaultSourceFiles(target: Target) {
  const base =
    target.kind === "problemset"
      ? `problems/${target.problemId}`
      : `contests/${target.contestId}/${target.problemId}`;
  return { c: `${base}/main.c`, cpp: `${base}/main.cpp` };
}
export function sourceLanguage(file: string): "c" | "cpp" {
  return /\.c$/i.test(file) ? "c" : "cpp";
}
export function localSourceChoices(binding: Binding) {
  const files = defaultSourceFiles(binding.problem.target);
  files[sourceLanguage(binding.sourceFile)] = binding.sourceFile;
  return [
    { label: "C", description: files.c, sourceFile: files.c },
    { label: "C++", description: files.cpp, sourceFile: files.cpp },
  ].sort(
    (a, b) =>
      Number(b.sourceFile === binding.sourceFile) -
      Number(a.sourceFile === binding.sourceFile),
  );
}
export function managedSourceFiles(binding: Binding) {
  return [
    ...new Set([
      ...Object.values(defaultSourceFiles(binding.problem.target)),
      binding.sourceFile,
    ]),
  ];
}
