import { expect, it } from "vitest";
import * as cheerio from "cheerio";
import katex from "katex";
import { renderStatement } from "../../src/problems/statement";
import { normalizeMathSource } from "../../webview/math";
const base = "https://accoding.buaa.edu.cn/";
const percentile = String.raw`x_p=\\begin{cases}x_{(\lfloor np\rfloor+1)}, &np\\not\\in \\mathbb{N} \\\\ \\dfrac{x_{(np)}+x_{(np+1)}}{2}, & np\\in\\mathbb{N}\\end{cases}`;

it.each(["markdown", "html"] as const)(
  "renders the mixed-escape percentile cases formula from %s",
  (format) => {
    const html = renderStatement(format, `$$${percentile}$$`, base);
    const text = cheerio.load(html).root().text().trim();
    const source = text.slice(2, -2);
    expect(() => katex.renderToString(source)).toThrow();
    const math = cheerio.load(
      katex.renderToString(normalizeMathSource(source), { trust: false }),
    );
    expect(math("mtable > mtr")).toHaveLength(2);
    expect(math("mfrac")).toHaveLength(1);
    expect(math(".katex-error")).toHaveLength(0);
    expect(math("annotation").text()).toContain(
      String.raw`np\not\in \mathbb{N} \\ \dfrac`,
    );
  },
);

it.each([
  String.raw`\begin{cases}a & x<0 \\ b & x\geq 0\end{cases}`,
  String.raw`\begin{matrix}a&b\\c&d\end{matrix}`,
  String.raw`x\%m + \{a,b\}`,
  String.raw`\text{\\begin{cases}literal\\end{cases}}`,
  String.raw`\\begin{cases}\unknowncommand\\end{cases}`,
])("preserves valid TeX and unrepairable formulas: %s", (source) => {
  expect(normalizeMathSource(source)).toBe(source);
});

it("preserves the escaped remainder operator through Markdown and renders its right operand", () => {
  const html = renderStatement(
    "markdown",
    String.raw`The bucket is $x\%m$.`,
    base,
  );
  const text = cheerio.load(html)("p").text();
  expect(text).toBe(String.raw`The bucket is $x\%m$.`);
  const formula = text.slice(text.indexOf("$") + 1, text.lastIndexOf("$"));
  const rendered = cheerio.load(
    katex.renderToString(formula, { trust: false }),
  );
  expect(rendered(".katex-html").text()).toBe("x%m");
});
it.each([
  String.raw`$x_i + \{a,b\} + \$5$`,
  String.raw`$$\begin{matrix}a&b\\c&d\end{matrix}$$`,
  String.raw`\(x\%m\)`,
  String.raw`\[x\%m\]`,
  String.raw`$a_1*b_2*c_3$`,
])("keeps formula bytes intact: %s", (source) => {
  const html = renderStatement("markdown", source, base);
  expect(cheerio.load(html)("p").text().trim()).toBe(source);
});
it("retains ordinary Markdown, code examples and HTML sanitization", () => {
  const source =
    String.raw`**bold** and \% outside. Inline ` +
    "`$x\\%m$`" +
    "\n\n```c\n$x\\%m$\n```\n\n" +
    String.raw`$x < m + \text{<img src=x onerror=alert(1)>}$` +
    "<script>bad()</script>";
  const html = renderStatement("markdown", source, base);
  const $ = cheerio.load(html);
  expect($("strong").text()).toBe("bold");
  expect($("p").first().text()).toContain("% outside.");
  expect($("p code").text()).toBe(String.raw`$x\%m$`);
  expect($("pre code").text()).toBe("$x\\%m$\n");
  expect($("script,img")).toHaveLength(0);
  expect($("p").last().text()).toContain(
    String.raw`x < m + \text{<img src=x onerror=alert(1)>}`,
  );
});
it("leaves unmatched delimiters readable", () => {
  expect(
    cheerio
      .load(renderStatement("markdown", "before $x and after", base))("p")
      .text(),
  ).toBe("before $x and after");
});

it("decodes Accoding subscripts and sum limits without losing the remainder operand", () => {
  const source = String.raw`$\sum\_{i=1}^{n}|x\_i-p| + x\%m$`;
  const text = cheerio
    .load(renderStatement("markdown", source, base))("p")
    .text();
  expect(text).toBe(String.raw`$\sum_{i=1}^{n}|x_i-p| + x\%m$`);
  const math = cheerio.load(
    katex.renderToString(text.slice(1, -1), { trust: false }),
  );
  expect(math("msubsup")).toHaveLength(1);
  expect(math("msub")).toHaveLength(1);
  expect(math(".katex-html").text()).toContain("x%m");
});
it("does not decode underscores in code or consume an even backslash run", () => {
  const source =
    "`x\\_i`\n\n    x\\_i\n\n" +
    String.raw`$$\begin{matrix}a\\_b\end{matrix}$$`;
  const $ = cheerio.load(renderStatement("markdown", source, base));
  expect($("p code").text()).toBe(String.raw`x\_i`);
  expect($("pre code").text()).toBe("x\\_i\n");
  expect($("p").last().text()).toContain(String.raw`a\\_b`);
});

it.each([
  [String.raw`k\\ge 2`, String.raw`k\ge 2`, "≥"],
  [String.raw`1 \\le n \\le 10^5`, String.raw`1 \le n \le 10^5`, "≤"],
  [String.raw`\\{0, 1\\}`, String.raw`\{0, 1\}`, "{0,1}"],
  [
    String.raw`a \\oplus b \\oplus \\cdots \\oplus c`,
    String.raw`a \oplus b \oplus \cdots \oplus c`,
    "⊕",
  ],
  [
    String.raw`\\sum_{i=0}^{63} x_i 2^i`,
    String.raw`\sum_{i=0}^{63} x_i 2^i`,
    "∑",
  ],
  [
    String.raw`S = \\left(\\sum_{j=1}^T X_j'\\right) \\bmod 2^{64}`,
    String.raw`S = \left(\sum_{j=1}^T X_j'\right) \bmod 2^{64}`,
    "mod",
  ],
])(
  "repairs uniformly doubled commands even when KaTeX accepts them: %s",
  (source, expected, symbol) => {
    // A successful parse alone does not prove these commands rendered correctly.
    const normalized = normalizeMathSource(source);
    expect(normalized).toBe(expected);
    const math = cheerio.load(
      katex.renderToString(normalized, { trust: false }),
    );
    expect(math(".katex-html").text()).toContain(symbol);
    expect(math("mspace[linebreak]")).toHaveLength(0);
  },
);

it("decodes doubled aligned environments and row breaks together", () => {
  const source = String.raw`\\begin{aligned}X_1 &= 1,\\\\ X_2 &= 2,\\\\ X_3 &= 3.\\end{aligned}`;
  const normalized = normalizeMathSource(source);
  expect(normalized).toBe(
    String.raw`\begin{aligned}X_1 &= 1,\\ X_2 &= 2,\\ X_3 &= 3.\end{aligned}`,
  );
  const math = cheerio.load(
    katex.renderToString(normalized, { displayMode: true }),
  );
  expect(math("mtable > mtr")).toHaveLength(3);
});

it.each([
  String.raw`a\\b`,
  String.raw`a\\[2pt]b`,
  String.raw`\begin{matrix}x&y\\alpha&beta\end{matrix}`,
  String.raw`\begin{aligned}a&=1\\\text{next}&=2\end{aligned}`,
  String.raw`\text{literal \\ braces} + \{x\}`,
  String.raw`x\\unknowncommand y`,
])(
  "preserves ordinary TeX row breaks, text and unknown commands: %s",
  (source) => {
    expect(normalizeMathSource(source)).toBe(source);
  },
);

it.each(["markdown", "html"] as const)(
  "preserves doubled commands through the %s statement pipeline",
  (format) => {
    const source = String.raw`$X = \\sum\_{i=0}^{63} x\_i 2^i$`;
    const html = renderStatement(format, source, base);
    const formula = cheerio.load(html).root().text().trim().slice(1, -1);
    // Only Markdown authors escape underscores for the Markdown stage.
    const expected =
      format === "markdown"
        ? String.raw`X = \sum_{i=0}^{63} x_i 2^i`
        : String.raw`X = \sum\_{i=0}^{63} x\_i 2^i`;
    expect(normalizeMathSource(formula)).toBe(expected);
  },
);
