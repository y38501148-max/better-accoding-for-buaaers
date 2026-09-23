import { expect, it } from "vitest";
import * as cheerio from "cheerio";
import katex from "katex";
import { renderStatement } from "../../src/problems/statement";
const base = "https://accoding.buaa.edu.cn/";
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
