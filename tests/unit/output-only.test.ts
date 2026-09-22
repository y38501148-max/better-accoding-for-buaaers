import { it, expect } from "vitest";
import { extractSamples } from "../../src/problems/statement";
import {
  contestLabel,
  problemLabel,
  compareBindings,
} from "../../src/problems/order";
import type { Binding } from "../../src/model";
import { problem } from "../fixtures/synthetic";
it("recognizes prose instead of a code block in a no-input sample", () => {
  const result = extractSamples(
    "markdown",
    "## 输入格式\r\n本题没有输入。\r\n## 输入样例\r\n本题没有输入。\r\n## 输出样例\r\n\r\n    hello  \r\n    world\r\n",
  );
  expect(result).toEqual({
    samples: [{ key: "sample-1", input: "", expected: "hello  \nworld\n" }],
    warnings: [],
  });
});
it.each([
  "## 输出样例\n```\nhello\n```",
  "## 输入格式\n无需任何输入。\n## 输出样例\n```\nhello\n```",
  "## Sample Input\nNo input is required.\n## Sample Output\n```\nhello\n```",
  "## 输入样例\n```\n```\n## 输出样例\n```\nhello\n```",
])("retains empty input with a real expected output", (source) => {
  expect(extractSamples("markdown", source)).toEqual({
    samples: [{ key: "sample-1", input: "", expected: "hello\n" }],
    warnings: [],
  });
});
it("handles HTML no-input prose with bold sample headings", () => {
  expect(
    extractSamples(
      "html",
      "<h2>输入格式</h2><p>无</p><p><strong>输入样例</strong></p><p>本题没有输入。</p><h2>输出样例</h2><pre>hello  \n</pre>",
    ),
  ).toEqual({
    samples: [{ key: "sample-1", input: "", expected: "hello  \n" }],
    warnings: [],
  });
});
it("does not mistake a missing required input or a literal code block for no input", () => {
  const missing = extractSamples(
    "markdown",
    "## 输入格式\n输入两个整数。\n## 输入样例\n## 输出样例\n```\nhello\n```",
  );
  expect(missing.samples).toEqual([]);
  expect(missing.warnings).toHaveLength(1);
  expect(
    extractSamples(
      "markdown",
      "## 输入样例\n```\n无\n```\n## 输出样例\n```\nhello\n```",
    ).samples[0].input,
  ).toBe("无\n");
});
it("keeps mixed empty and ordinary samples paired in order", () => {
  const result = extractSamples(
    "markdown",
    "## 输入样例 1\n本样例没有输入。\n## 输出样例 1\n```\nempty\n```\n## 输入样例 2\n```\nvalue\n```\n## 输出样例 2\n```\nfull\n```",
  );
  expect(result.samples.map((s) => [s.input, s.expected])).toEqual([
    ["", "empty\n"],
    ["value\n", "full\n"],
  ]);
  expect(result.warnings).toEqual([]);
});
it("uses official sequence rather than numeric IDs or old cached labels", () => {
  const make = (id: string, order: number) =>
    ({
      problem: {
        ...problem,
        label: "old",
        target: {
          kind: "contest",
          contestId: "7",
          problemId: id,
          contestOrder: order,
        },
      },
    }) as Binding;
  const ordered = [make("2", 9), make("99", 0), make("1", 1)].sort(
    compareBindings,
  );
  expect(ordered.map((b) => problemLabel(b.problem))).toEqual(["A", "B", "J"]);
  expect(ordered.map((b) => b.problem.target.problemId)).toEqual([
    "99",
    "1",
    "2",
  ]);
  expect([25, 26, 27].map(contestLabel)).toEqual(["Z", "AA", "AB"]);
});
