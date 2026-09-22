import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { AccodingClient } from "../accoding/client";
import { ADMIN_ORIGIN, ORIGIN } from "../model";
export const IMAGE_LIMIT = 8 * 1024 * 1024;
export interface ImageReply {
  bytes: Buffer;
  contentType: string;
}
export type ImageLoader = (url: string) => Promise<ImageReply>;

// Untrusted image links must not turn the extension into a local-network client.
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Accept global unicast IPv6 only; mapped/private/link-local forms fail closed.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:0?db8|0{0,4}):|^2002:/i.test(address)
  );
}
async function publicImage(
  url: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<ImageReply> {
  signal.throwIfAborted();
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || redirects > 5)
    throw Error("图片地址或重定向不受支持。");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const abort = () => reject(deadline.reason);
        if (deadline.aborted) {
          abort();
          return;
        }
        deadline.addEventListener("abort", abort, { once: true });
        void lookup(host, { all: true }).then(
          (values) => {
            deadline.removeEventListener("abort", abort);
            resolve(values);
          },
          (error) => {
            deadline.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Error("不允许从本地或专用网络读取站外图片。");
  const address = addresses[0];
  const reply = await new Promise<{
    bytes: Buffer;
    contentType: string;
    location?: string;
  }>((resolve, reject) => {
    const req = request(
      {
        protocol: "https:",
        hostname: address.address,
        port: u.port || 443,
        servername: isIP(host) ? undefined : host,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Host: u.host, Accept: "image/*" },
        signal: deadline,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          res.resume();
          if (!res.headers.location) {
            reject(Error("图片重定向缺少地址。"));
            return;
          }
          resolve({
            bytes: Buffer.alloc(0),
            contentType: "",
            location: res.headers.location,
          });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error("图片暂时无法访问。"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > IMAGE_LIMIT) {
            res.destroy(Error("图片超过 8 MiB。"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            contentType: res.headers["content-type"] ?? "",
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
  // DNS is checked and the connection pinned for every redirect. Never send Cookie.
  return reply.location
    ? publicImage(new URL(reply.location, u).href, signal, redirects + 1)
    : reply;
}
export function imageLoader(client: AccodingClient): ImageLoader {
  const admin = client.adminReader();
  const signal = client.sessionSignal;
  return async (url) => {
    signal.throwIfAborted();
    const origin = new URL(url).origin;
    if (origin === ORIGIN || origin === ADMIN_ORIGIN) {
      const r = await (origin === ORIGIN ? client : admin).request(url, {
        signal,
        retries: 0,
        timeoutMs: 8000,
        maxBytes: IMAGE_LIMIT,
        accept: "image/*",
      });
      return {
        bytes: r.bytes,
        contentType: r.headers.get("content-type") ?? "",
      };
    }
    return publicImage(url, signal);
  };
}
