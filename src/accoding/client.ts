import { CookieJar } from "tough-cookie";
import { setTimeout as delay } from "node:timers/promises";
import { ADMIN_ORIGIN, ORIGIN } from "../model";
export class ApiError extends Error {
  constructor(
    public readonly kind:
      | "auth"
      | "forbidden"
      | "rate"
      | "server"
      | "protocol"
      | "network"
      | "unknown",
    message: string,
  ) {
    super(message);
  }
}
export interface Reply {
  status: number;
  url: string;
  text: string;
  headers: Headers;
}
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export class AccodingClient {
  private controller = new AbortController();
  private baseOrigin: typeof ORIGIN | typeof ADMIN_ORIGIN = ORIGIN;
  get origin() {
    return this.baseOrigin;
  }
  constructor(
    public jar = new CookieJar(),
    private transport: Transport = fetch,
  ) {}
  /** Cookies are scoped to the same trusted host, not its port. Isolate any
   * admin Set-Cookie changes so probing cannot replace the student session. */
  adminReader() {
    const reader = new AccodingClient(this.jar.cloneSync(), this.transport);
    reader.baseOrigin = ADMIN_ORIGIN;
    reader.controller = this.controller;
    return reader;
  }
  cancel() {
    this.controller.abort();
    this.controller = new AbortController();
  }
  async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: string;
      contentType?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      retries?: number;
    } = {},
  ): Promise<Reply> {
    const method = options.method ?? "GET";
    if (this.origin === ADMIN_ORIGIN && method !== "GET")
      throw new ApiError("forbidden", "管理端连接仅用于读取题目。");
    options = {
      ...options,
      signal: AbortSignal.any([
        this.controller.signal,
        options.signal ?? new AbortController().signal,
      ]),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, { ...options, method });
      } catch (e) {
        if (
          method === "POST" ||
          attempt >= (options.retries ?? 2) ||
          options.signal?.aborted ||
          !(e instanceof ApiError) ||
          !["network", "rate", "server"].includes(e.kind)
        )
          throw e;
        await delay(500 * 2 ** attempt, undefined, { signal: options.signal });
      }
    }
  }
  private async once(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: string;
      contentType?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<Reply> {
    let url = new URL(path, this.origin);
    let method = options.method,
      body = options.body;
    const signal = AbortSignal.any([
      this.controller.signal,
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(options.timeoutMs ?? 15000),
    ]);
    for (let redirects = 0; redirects <= 6; redirects++) {
      if (url.origin !== this.origin || url.username || url.password)
        throw new ApiError("protocol", "已阻止跨域重定向。");
      const headers: Record<string, string> = {
        Accept: "application/json, text/html;q=0.9",
        Cookie: await this.jar.getCookieString(url.href),
      };
      if (method === "POST") {
        headers["Content-Type"] =
          options.contentType ?? "application/x-www-form-urlencoded";
        headers.Origin = this.origin;
        headers.Referer = url.href;
      }
      let response: Response;
      try {
        response = await this.transport(url.href, {
          method,
          body,
          headers,
          redirect: "manual",
          signal,
        });
      } catch {
        if (signal.aborted && options.signal?.aborted)
          throw new Error("操作已取消。");
        throw new ApiError(
          options.method === "POST" ? "unknown" : "network",
          options.method === "POST"
            ? "提交结果不确定，请先查询记录，勿直接重发。"
            : "网络请求失败或超时。",
        );
      }
      for (const cookie of response.headers.getSetCookie())
        await this.jar.setCookie(cookie, url.href);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new ApiError("protocol", "重定向缺少位置。");
        url = new URL(location, url);
        if (
          response.status === 303 ||
          ([301, 302].includes(response.status) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if (response.status === 401)
        throw new ApiError("auth", "登录已失效，请重新登录。");
      if (response.status === 403)
        throw new ApiError(
          "forbidden",
          "当前账号无权执行此操作，或 CSRF 校验失败。",
        );
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        if (
          options.method === "GET" &&
          options.retries !== 0 &&
          Number.isFinite(seconds) &&
          seconds > 0
        )
          await delay(Math.min(seconds, 30) * 1000, undefined, { signal });
        throw new ApiError("rate", "请求过于频繁，请稍后重试。");
      }
      if (response.status >= 500)
        throw new ApiError(
          options.method === "POST" ? "unknown" : "server",
          options.method === "POST"
            ? "服务器异常，提交结果待确认。"
            : "Accoding 服务暂时不可用。",
        );
      if (!response.ok)
        throw new ApiError(
          "protocol",
          `请求被拒绝（HTTP ${response.status}）。`,
        );
      let buffer: string;
      try {
        buffer = await readLimited(response, 8 * 1024 * 1024);
      } catch (e) {
        if (options.signal?.aborted) throw new Error("操作已取消。");
        if (e instanceof ApiError) throw e;
        throw new ApiError(
          options.method === "POST" ? "unknown" : "network",
          options.method === "POST"
            ? "提交响应读取中断，请先查询记录，勿直接重发。"
            : "网络响应读取失败或超时。",
        );
      }
      return {
        status: response.status,
        url: url.href,
        text: buffer,
        headers: response.headers,
      };
    }
    throw new ApiError("protocol", "重定向次数过多。");
  }
  async json(
    path: string,
    options: Parameters<AccodingClient["request"]>[1] = {},
  ): Promise<unknown> {
    const reply = await this.request(path, options);
    if (
      new URL(reply.url).pathname === "/user/login" ||
      /<form[^>]*>[\s\S]*name=["']password/.test(reply.text)
    )
      throw new ApiError("auth", "请先登录 Accoding。");
    try {
      return JSON.parse(reply.text);
    } catch {
      throw new ApiError(
        "protocol",
        "服务端未返回预期 JSON，请检查权限或接口变化。",
      );
    }
  }
}
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError("protocol", "响应超过安全大小限制。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
