import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { hash, type Problem } from "../model";
import { atomicWrite, safePath } from "../workspace/fs";
import { renderStatement } from "./statement";
import { IMAGE_LIMIT, type ImageLoader } from "./image-fetch";
export const IMAGE_DIRECTORY = ".better-accoding/images";
const filePattern =
  /^\.better-accoding\/images\/[a-f0-9]{64}\.(png|jpg|gif|webp|svg)$/;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export function normalizedImage(
  bytes: Buffer,
  contentType: string,
): { bytes: Buffer; extension: string } {
  if (!bytes.length || bytes.length > IMAGE_LIMIT)
    throw Error("图片为空或超过 8 MiB。");
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { bytes, extension: "png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { bytes, extension: "jpg" };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")))
    return { bytes, extension: "gif" };
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return { bytes, extension: "webp" };
  if (!/^image\/svg\+xml(?:;|$)/i.test(contentType))
    throw Error("图片不是支持的 PNG/JPEG/GIF/WebP/SVG 格式。");
  const source = bytes.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source))
    throw Error("SVG 包含不支持的外部声明。");
  const $ = cheerio.load(source, { xmlMode: true });
  const svg = $.root().children("svg");
  if (svg.length !== 1 || $.root().children().length !== 1)
    throw Error("SVG 结构无效。");
  const tags = new Set(
    "svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask pattern marker title desc use symbol".split(
      " ",
    ),
  );
  const attributes = new Set(
    "id x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule mask font-family font-size font-weight font-style text-anchor dominant-baseline dx dy gradientUnits gradientTransform offset stop-color stop-opacity marker-start marker-mid marker-end markerWidth markerHeight refX refY orient patternUnits patternContentUnits patternTransform href xlink:href".split(
      " ",
    ),
  );
  svg
    .find("*")
    .addBack()
    .each((_i, element) => {
      if (element.type !== "tag" || !tags.has(element.name)) {
        $(element).remove();
        return;
      }
      // Preserve common SVG export presentation styles as plain attributes.
      // Stylesheets and arbitrary CSS are never retained in the cached file.
      for (const declaration of (element.attribs.style ?? "").split(";")) {
        const colon = declaration.indexOf(":");
        const name = declaration.slice(0, colon).trim();
        if (
          colon > 0 &&
          /^(fill|stroke|opacity|font|text-anchor|stop-color|stop-opacity)(-|$)/.test(
            name,
          ) &&
          attributes.has(name)
        ) {
          $(element).attr(
            name,
            declaration
              .slice(colon + 1)
              .trim()
              .replace(/\s*!important\s*$/i, ""),
          );
        }
      }
      for (const [name, value] of Object.entries(element.attribs)) {
        if (
          !attributes.has(name) ||
          ((name === "href" || name === "xlink:href") &&
            !/^#[\w:.-]+$/.test(value)) ||
          (/url\s*\(/i.test(value) &&
            !/^url\(\s*#[\w:.-]+\s*\)$/.test(value)) ||
          /javascript:|data:|https?:|\/\/|\\/i.test(value)
        )
          $(element).removeAttr(name);
      }
    });
  svg.attr("xmlns", "http://www.w3.org/2000/svg");
  svg.attr("xmlns:xlink", "http://www.w3.org/1999/xlink");
  return { bytes: Buffer.from($.xml(svg)), extension: "svg" };
}

async function readCached(root: string, file: string): Promise<Buffer> {
  if (!filePattern.test(file)) throw Error("图片缓存路径无效。");
  const absolute = await safePath(root, file);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > IMAGE_LIMIT) throw Error("图片缓存无效。");
  const bytes = await fs.readFile(absolute);
  if (!file.includes(`/${digest(bytes)}.`))
    throw Error("图片缓存内容校验失败。");
  const extension = filePattern.exec(file)![1];
  const checked = normalizedImage(
    bytes,
    extension === "svg" ? "image/svg+xml" : "image/*",
  );
  if (checked.extension !== extension || !checked.bytes.equals(bytes))
    throw Error("图片缓存格式或 SVG 内容无效。");
  return bytes;
}

/** Import-time work only. Rendering cached statements never makes a request. */
export async function cacheProblemImages(
  problem: Problem,
  root: string,
  load: ImageLoader,
): Promise<Problem> {
  const next = structuredClone(problem);
  const html = renderStatement(
    problem.statement.format,
    problem.statement.content,
    problem.statement.baseUrl,
  );
  const $ = cheerio.load(html);
  const urls = [
    ...new Set(
      $("img")
        .map((_i, e) => $(e).attr("src") ?? "")
        .get()
        .filter(Boolean),
    ),
  ];
  const images: Record<string, string> = {};
  next.statement.images = images;
  let failed = Math.max(0, urls.length - 40);
  const entries = urls.slice(0, 40).values();
  const worker = async () => {
    for (const url of entries) {
      const key = hash(url),
        indexFile = await safePath(root, `${IMAGE_DIRECTORY}/url-${key}.json`);
      try {
        const r = await load(url),
          image = normalizedImage(r.bytes, r.contentType);
        const file = `${IMAGE_DIRECTORY}/${digest(image.bytes)}.${image.extension}`;
        await atomicWrite(await safePath(root, file), image.bytes);
        await atomicWrite(indexFile, JSON.stringify({ file }));
        images[key] = file;
      } catch (e) {
        if (
          e instanceof Error &&
          (e.name === "AbortError" || e.message === "操作已取消。")
        )
          throw e;
        try {
          const old =
            problem.statement.images?.[key] ??
            JSON.parse(await fs.readFile(indexFile, "utf8")).file;
          await readCached(root, old);
          images[key] = old;
        } catch {
          failed++;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, urls.length) }, () => worker()),
  );
  if (failed)
    next.warnings.push(`${failed} 张图片未能缓存；联网后同步题面可重试。`);
  return next;
}

export async function localStatementHtml(
  problem: Problem,
  root: string,
  uri: (file: string) => string,
): Promise<string> {
  const $ = cheerio.load(
    renderStatement(
      problem.statement.format,
      problem.statement.content,
      problem.statement.baseUrl,
    ),
    null,
    false,
  );
  for (const element of $("img").toArray()) {
    const img = $(element),
      url = img.attr("src") ?? "";
    const file = problem.statement.images?.[hash(url)];
    try {
      if (!file) throw Error("图片尚未缓存");
      await readCached(root, file);
      img.attr("src", uri(await safePath(root, file)));
    } catch {
      const label = img.attr("alt") || "题面图片";
      const fallback = $("<span></span>").text(
        `[${label}：图片未缓存或已损坏，请联网同步题面]`,
      );
      img.replaceWith(fallback);
    }
  }
  return $.html();
}
