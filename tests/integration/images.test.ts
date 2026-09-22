import { it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import {
  cacheProblemImages,
  localStatementHtml,
  normalizedImage,
} from "../../src/problems/images";
import {
  imageLoader,
  publicAddress,
  IMAGE_LIMIT,
} from "../../src/problems/image-fetch";
import { AccodingClient } from "../../src/accoding/client";
import { ORIGIN, ADMIN_ORIGIN } from "../../src/model";
import { problem } from "../fixtures/synthetic";
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC",
  "base64",
);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-image-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});
function imageProblem(format: "html" | "markdown" = "markdown") {
  return {
    ...structuredClone(problem),
    statement: {
      format,
      content:
        format === "markdown"
          ? "![图](/images/example.png)\n![同图](/images/example.png)"
          : '<img alt="图" src="/images/example.png">',
      baseUrl: ORIGIN + "/problem/0/index",
    },
  };
}
it("caches deduplicated Markdown images and renders offline using only validated local URIs", async () => {
  const load = vi.fn(async () => ({ bytes: png, contentType: "image/png" }));
  const p = await cacheProblemImages(imageProblem(), root, load);
  expect(load).toHaveBeenCalledTimes(1);
  const paths: string[] = [];
  const html = await localStatementHtml(p, root, (file) => {
    paths.push(file);
    return "https://local-resource.test/image.png";
  });
  expect(paths).toHaveLength(2);
  expect(html).not.toContain(ORIGIN);
  expect(html).toContain("local-resource.test/image.png");
  expect(await fs.readFile(paths[0])).toEqual(png);
  const offline = await cacheProblemImages(imageProblem(), root, async () => {
    throw Error("offline");
  });
  expect(offline.statement.images).toEqual(p.statement.images);
});
it("preserves statement text and reports missing or corrupted images without a remote fallback", async () => {
  const p = await cacheProblemImages(imageProblem("html"), root, async () => ({
    bytes: png,
    contentType: "image/png",
  }));
  const file = Object.values(p.statement.images!)[0];
  await fs.writeFile(path.join(root, file), "corrupt");
  const html = await localStatementHtml(p, root, () => {
    throw Error("must not use corrupt asset");
  });
  expect(html).toContain("图片未缓存或已损坏");
  expect(html).not.toContain("<img");
  const failed = await cacheProblemImages(imageProblem(), root, async () => ({
    bytes: Buffer.from("<form>login</form>"),
    contentType: "text/html",
  }));
  expect(failed.warnings.some((w) => w.includes("图片未能缓存"))).toBe(true);
});
it("does not expose arbitrary workspace paths or symlinked image directories", async () => {
  const p = imageProblem("html");
  const cached = await cacheProblemImages(p, root, async () => ({
    bytes: png,
    contentType: "image/png",
  }));
  for (const key of Object.keys(cached.statement.images!))
    cached.statement.images![key] = "../../secret";
  expect(
    await localStatementHtml(cached, root, () => {
      throw Error("escaped");
    }),
  ).not.toContain("<img");
  if (process.platform !== "win32") {
    await fs.rm(path.join(root, ".better-accoding/images"), {
      recursive: true,
    });
    await fs.symlink(os.tmpdir(), path.join(root, ".better-accoding/images"));
    await expect(
      cacheProblemImages(p, root, async () => ({
        bytes: png,
        contentType: "image/png",
      })),
    ).rejects.toThrow("符号链接");
  }
});
it("sanitizes SVG scripts, foreign objects and external references while preserving local drawing references", async () => {
  const unsafe = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="bad()"><script>bad()</script><foreignObject><div>bad</div></foreignObject><path id="shape" style="fill:#123456;stroke-width:2" d="M0 0L10 10"/><use href="#shape"/><use href="https://evil.test/x.svg#shape"/><rect fill="url(https://evil.test/x)"/></svg>',
  );
  const clean = normalizedImage(unsafe, "image/svg+xml");
  const text = clean.bytes.toString();
  expect(text).not.toMatch(/script|foreignObject|onload|evil\.test|bad\(/);
  expect(text).toContain('href="#shape"');
  expect(text).toContain('viewBox="0 0 10 10"');
  expect(text).toContain('fill="#123456"');
  expect(text).toContain('stroke-width="2"');
  expect(normalizedImage(clean.bytes, "image/svg+xml").bytes).toEqual(
    clean.bytes,
  );
  const p = await cacheProblemImages(imageProblem(), root, async () => ({
    bytes: unsafe,
    contentType: "image/svg+xml",
  }));
  expect(await localStatementHtml(p, root, () => "/local.svg")).toContain(
    'src="/local.svg"',
  );
  expect(() =>
    normalizedImage(Buffer.from("<!DOCTYPE svg><svg/>"), "image/svg+xml"),
  ).toThrow("外部声明");
});
it("limits image bytes and retains cancellation instead of silently continuing an import", async () => {
  expect(() =>
    normalizedImage(Buffer.alloc(IMAGE_LIMIT + 1), "image/png"),
  ).toThrow("8 MiB");
  await expect(
    cacheProblemImages(imageProblem(), root, async () => {
      throw new DOMException("cancelled", "AbortError");
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const transport = vi.fn(async () => new Response(png));
  const client = new AccodingClient(undefined, transport),
    load = imageLoader(client);
  client.cancel();
  await expect(load(ORIGIN + "/image.png")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(transport).not.toHaveBeenCalled();
});
it("loads authenticated student and admin image bytes without UTF-8 corruption or cookie redirects", async () => {
  const seen: { url: string; cookie: string }[] = [];
  const client = new AccodingClient(undefined, async (url, init) => {
    seen.push({
      url,
      cookie: String((init.headers as Record<string, string>).Cookie),
    });
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  await client.jar.setCookie("sid=synthetic; Path=/; Secure", ORIGIN);
  const load = imageLoader(client);
  expect((await load(ORIGIN + "/image.png")).bytes).toEqual(png);
  expect((await load(ADMIN_ORIGIN + "/image.png")).bytes).toEqual(png);
  expect(seen.every((s) => s.cookie === "sid=synthetic")).toBe(true);
  const redirect = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://external.test/image.png" },
      }),
  );
  const redirectClient = new AccodingClient(undefined, redirect);
  await expect(
    imageLoader(redirectClient)(ORIGIN + "/image.png"),
  ).rejects.toThrow("跨域");
  expect(redirect).toHaveBeenCalledTimes(1);
});
function mockResponse(
  status: number,
  headers: Record<string, string>,
  body = png,
) {
  network.request.mockImplementation(
    (
      _options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const res = Object.assign(new PassThrough(), {
          statusCode: status,
          headers,
        }) as unknown as IncomingMessage;
        callback(res);
        queueMicrotask(() => {
          (res as unknown as PassThrough).end(body);
        });
      };
      return req;
    },
  );
}
it("pins external image connections to validated DNS addresses and sends no OJ credentials", async () => {
  network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mockResponse(200, { "content-type": "image/png" });
  const client = new AccodingClient();
  await client.jar.setCookie("sid=synthetic; Path=/; Secure", ORIGIN);
  expect(
    (await imageLoader(client)("https://images.example.test/a.png")).bytes,
  ).toEqual(png);
  const options = network.request.mock.calls[0][0];
  expect(options.hostname).toBe("93.184.216.34");
  expect(options.servername).toBe("images.example.test");
  expect(options.headers).toEqual({
    Host: "images.example.test",
    Accept: "image/*",
  });
});
it("blocks private DNS answers and redirects before making a private network request", async () => {
  network.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  await expect(
    imageLoader(new AccodingClient())("https://images.example.test/a.png"),
  ).rejects.toThrow("专用网络");
  expect(network.request).not.toHaveBeenCalled();
  network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mockResponse(302, { location: "https://127.0.0.1/private" });
  await expect(
    imageLoader(new AccodingClient())("https://images.example.test/a.png"),
  ).rejects.toThrow("专用网络");
  expect(network.request).toHaveBeenCalledTimes(1);
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    expect(publicAddress(address)).toBe(false);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
