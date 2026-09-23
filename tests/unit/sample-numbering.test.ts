import { expect, it } from "vitest";
import { extractSamples } from "../../src/problems/statement";

it.each(["markdown", "html"] as const)(
  "pairs three %s samples with numeric inline math headings and preserves whitespace",
  (format) => {
    const content = [1, 2, 3]
      .map((n) =>
        format === "markdown"
          ? `### 输入样例 $${n}$\r\n\r\n    ${n}  7 \r\n\r\n### 输出样例 $${n}$\r\n\r\n    answer ${n}\r\n    done\r\n`
          : `<h3>输入样例 $${n}$</h3><pre>${n}  7 \n</pre><h3>输出样例 $${n}$</h3><pre>answer ${n}\ndone\n</pre>`,
      )
      .join("\n");
    expect(extractSamples(format, content)).toEqual({
      samples: [1, 2, 3].map((n) => ({
        key: `sample-${n}`,
        input: `${n}  7 \n`,
        expected: `answer ${n}\ndone\n`,
      })),
      warnings: [],
    });
  },
);
it("retains a warning when a numbered sample is actually missing its output", () => {
  const parsed = extractSamples("markdown", "### 输入样例 $1$\n\n    data\n");
  expect(parsed.samples).toEqual([]);
  expect(parsed.warnings).toHaveLength(1);
});
it("does not treat arbitrary mathematical headings as numbered samples", () => {
  const parsed = extractSamples(
    "markdown",
    "### 输入样例 $x+1$\n\n    data\n\n### 输出样例 $x+1$\n\n    value\n",
  );
  expect(parsed.samples).toEqual([]);
  expect(parsed.warnings).toHaveLength(1);
});
