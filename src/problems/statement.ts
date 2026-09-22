import MarkdownIt from "markdown-it";
import sanitize from "sanitize-html";
import * as cheerio from "cheerio";
import type { Sample } from "../model";
const markdown = new MarkdownIt({ html: true, linkify: false });
export function cleanHtml(html: string, baseUrl: string): string {
  return sanitize(html, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "hr",
      "pre",
      "code",
      "blockquote",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "strong",
      "em",
      "b",
      "i",
      "del",
      "sub",
      "sup",
      "span",
      "div",
      "img",
      "a",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_name, attrs) => ({
        tagName: "a",
        attribs: {
          href: safeUrl(attrs.href, baseUrl),
          title: attrs.title ?? "",
        },
      }),
      img: (_name, attrs) => ({
        tagName: "img",
        attribs: { src: safeUrl(attrs.src, baseUrl), alt: attrs.alt ?? "" },
      }),
    },
  });
}
function safeUrl(value: string | undefined, base: string): string {
  try {
    const u = new URL(value ?? "", base);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}
export function renderStatement(
  format: "html" | "markdown",
  content: string,
  base: string,
): string {
  return cleanHtml(
    format === "markdown" ? markdown.render(content) : content,
    base,
  );
}
function sampleHeading(text: string): "input" | "expected" | undefined {
  const t = text.replace(/[\s:：#\d（）()_-]/g, "").toLowerCase();
  if (
    /^(输入样例|样例输入|输入示例|示例输入|sampleinput|inputsample|exampleinput)$/.test(
      t,
    )
  )
    return "input";
  if (
    /^(输出样例|样例输出|输出示例|示例输出|sampleoutput|outputsample|exampleoutput)$/.test(
      t,
    )
  )
    return "expected";
  return undefined;
}
export function extractSamples(
  format: "html" | "markdown",
  content: string,
): { samples: Sample[]; warnings: string[] } {
  const blocks: { kind: "input" | "expected"; text: string }[] = [];
  if (format === "markdown") {
    const tokens = markdown.parse(content, {});
    let kind: "input" | "expected" | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "heading_open")
        kind = sampleHeading(tokens[i + 1]?.content ?? "");
      // Some statements use bold paragraphs instead of headings.
      if (
        token.type === "inline" &&
        sampleHeading(token.content.replace(/\*\*/g, ""))
      )
        kind = sampleHeading(token.content.replace(/\*\*/g, ""));
      if ((token.type === "fence" || token.type === "code_block") && kind)
        blocks.push({ kind, text: token.content });
    }
  } else {
    const $ = cheerio.load(content);
    let kind: "input" | "expected" | undefined;
    $("h1,h2,h3,h4,h5,h6,pre").each((_i, el) => {
      if (el.tagName !== "pre") kind = sampleHeading($(el).text());
      else if (kind) blocks.push({ kind, text: $(el).text() });
    });
  }
  const inputs = blocks.filter((b) => b.kind === "input"),
    outputs = blocks.filter((b) => b.kind === "expected");
  const warnings: string[] = [];
  if (!inputs.length || inputs.length !== outputs.length)
    warnings.push("公开样例未能完整配对，请检查题面并手动补充用例。");
  return {
    samples: inputs.slice(0, outputs.length).map((b, i) => ({
      key: `sample-${i + 1}`,
      input: b.text,
      expected: outputs[i].text,
    })),
    warnings,
  };
}
