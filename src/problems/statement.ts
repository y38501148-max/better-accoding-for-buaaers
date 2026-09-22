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
  let kind: "input" | "expected" | undefined;
  let inputSection = false,
    inputDeclared = false,
    noInputDeclared = false;
  let sectionEmpty = false,
    sectionHasCode = false;
  const finishSection = () => {
    if (kind === "input" && sectionEmpty && !sectionHasCode)
      blocks.push({ kind: "input", text: "" });
  };
  const startSection = (heading: string) => {
    finishSection();
    kind = sampleHeading(heading);
    const title = heading.replace(/[\s:：#\d（）()_-]/g, "").toLowerCase();
    inputSection =
      kind === "input" ||
      /^(输入|输入格式|输入说明|输入描述|input|inputformat|inputdescription|inputspecification)$/.test(
        title,
      );
    inputDeclared ||= inputSection;
    sectionEmpty = false;
    sectionHasCode = false;
  };
  const paragraph = (text: string) => {
    const heading = text.replace(/\*\*/g, "");
    if (sampleHeading(heading)) {
      startSection(heading);
      return;
    }
    const normalized = text.replace(/\s/g, "").toLowerCase();
    // Interpret prose only, never a code block whose literal content is "无".
    if (
      inputSection &&
      /^(?:(?:本题|本题目|本样例|本例)?(?:无|没有|无需|不需要)(?:任何)?输入(?:数据)?|无|noinput(?:isrequired|isneeded)?|thereisnoinput)(?:[。.!！,，;；]|$)/.test(
        normalized,
      )
    ) {
      noInputDeclared = true;
      sectionEmpty = true;
    }
  };
  const code = (text: string) => {
    if (kind) blocks.push({ kind, text });
    sectionHasCode = true;
  };
  if (format === "markdown") {
    const tokens = markdown.parse(content, {});
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "heading_open") {
        startSection(tokens[i + 1]?.content ?? "");
        i++;
      } else if (token.type === "inline") paragraph(token.content);
      else if (token.type === "fence" || token.type === "code_block")
        code(token.content);
    }
  } else {
    const $ = cheerio.load(content);
    $("h1,h2,h3,h4,h5,h6,p,pre").each((_i, el) => {
      if (el.tagName === "pre") code($(el).text());
      else if (el.tagName === "p") paragraph($(el).text());
      else startSection($(el).text());
    });
  }
  finishSection();
  const inputs = blocks.filter((b) => b.kind === "input");
  const outputs = blocks.filter((b) => b.kind === "expected");
  const outputOnly =
    !inputs.length && outputs.length > 0 && (noInputDeclared || !inputDeclared);
  const warnings: string[] = [];
  if (!outputOnly && (!inputs.length || inputs.length !== outputs.length))
    warnings.push("公开样例未能完整配对，请检查题面并手动补充用例。");
  return {
    samples: (outputOnly
      ? outputs.map(() => ({ text: "" }))
      : inputs.slice(0, outputs.length)
    ).map((b, i) => ({
      key: `sample-${i + 1}`,
      input: b.text,
      expected: outputs[i].text,
    })),
    warnings,
  };
}
