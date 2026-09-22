import { describe, it, expect } from "vitest";
import { parseImport, bindingId } from "../../src/model";
import { extractSamples, cleanHtml } from "../../src/problems/statement";
import { compare } from "../../src/judge/judge";
import { parseProblemPage } from "../../src/accoding/adapters";
import { problemPage } from "../fixtures/synthetic";
describe("source identity", () => {
  it("keeps zero and separates numeric modes", () => {
    expect(parseImport("0", "problemset")).toEqual({
      kind: "problemset",
      id: "0",
    });
    expect(parseImport("007", "contest").id).toBe("7");
    expect(() => parseImport("7")).toThrow();
  });
  it("rejects other origins, userinfo and traversal", () => {
    for (const u of [
      "http://accoding.buaa.edu.cn/problem/1/index",
      "https://evil.test/problem/1/index",
      "https://x@accoding.buaa.edu.cn/problem/1/index",
      "../1",
    ])
      expect(() => parseImport(u)).toThrow();
  });
  it("parses exact links", () => {
    expect(
      parseImport("https://accoding.buaa.edu.cn:4000/contest/1306/index"),
    ).toEqual({ kind: "contest", id: "1306" });
    expect(() =>
      parseImport("https://accoding.buaa.edu.cn:4001/contest/1306"),
    ).toThrow();
    expect(
      parseImport("https://accoding.buaa.edu.cn/contest-ng/index.html#/1306"),
    ).toEqual({ kind: "contest", id: "1306" });
    expect(
      parseImport("https://accoding.buaa.edu.cn/problem/1/index").kind,
    ).toBe("problemset");
  });
  it("does not share cross-source bindings", () =>
    expect(
      bindingId({
        kind: "contest",
        contestId: "1",
        problemId: "1",
        contestOrder: 0,
      }),
    ).not.toBe(bindingId({ kind: "problemset", problemId: "1" })));
});
describe("statements", () => {
  it("preserves whitespace and handles indented and fenced samples", () => {
    const { samples } = extractSamples(
      "markdown",
      "## 输入样例 1\n\n    a  \n    \tb\n\n## 输出样例 1\n\n```\nx  \n\n```\n",
    );
    expect(samples[0].input).toContain("a  \n");
    expect(samples[0].expected).toBe("x  \n\n");
  });
  it("warns about missing pairs", () =>
    expect(
      extractSamples("markdown", "## 输入样例\n```\na\n```").warnings.length,
    ).toBe(1));
  it("rejects scripts, forms, command links and unsafe images", () => {
    const html = cleanHtml(
      '<script>evil()</script><form><input name="_csrf" value="secret"></form><a href="command:evil">click</a><img src="javascript:evil()" onerror="evil()"><p>safe</p>',
      "https://accoding.buaa.edu.cn/",
    );
    expect(html).not.toMatch(/script|command:|onerror|secret|javascript:/);
    expect(html).toContain("safe");
  });
  it("extracts only statement and languages", () => {
    const p = parseProblemPage(
      problemPage,
      "https://accoding.buaa.edu.cn/problem/0/index",
      "0",
    );
    expect(p.problem.statement.content).not.toMatch(/ACCOUNT|CSRF|form|script/);
    expect(p.problem.languages).toEqual(["c"]);
    expect(p.problem.samples[0].input).toBe("1 2\n");
  });
  it("refuses HTML 200 list and wrong identity", () => {
    expect(() =>
      parseProblemPage(
        problemPage,
        "https://accoding.buaa.edu.cn/problem/index",
        "0",
      ),
    ).toThrow();
    expect(() =>
      parseProblemPage(
        "<h1>No access</h1>",
        "https://accoding.buaa.edu.cn/problem/0/index",
        "0",
      ),
    ).toThrow();
  });
});
describe("comparison semantics", () => {
  it("normalizes CRLF without trimming significant whitespace", () => {
    expect(compare("a\r\n", "a\n", "exact").equal).toBe(true);
    expect(compare("a", "a\n", "exact").equal).toBe(false);
    expect(compare("a \n", "a\n", "exact").equal).toBe(false);
  });
  it("has explicit whitespace modes", () => {
    expect(compare("a \t\n", "a\n", "trim-line-end").equal).toBe(true);
    expect(compare(" a\t b\n", "a b", "tokens").equal).toBe(true);
    expect(compare("", "\n", "exact").equal).toBe(false);
  });
  it("describes first mismatch and end of output", () =>
    expect(compare("a\nb", "a\nb\n", "exact")).toMatchObject({
      equal: false,
      line: 2,
      actual: "〈末尾〉",
      expected: "↵\n",
    }));
});
