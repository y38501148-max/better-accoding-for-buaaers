import * as cheerio from "cheerio";
import { z } from "zod";
import { AccodingClient, ApiError } from "./client";
import {
  ORIGIN,
  idSchema,
  type Problem,
  type Target,
  type ContestSnapshot,
} from "../model";
import { cleanHtml, extractSamples } from "../problems/statement";
const userSchema = z.object({ id: idSchema, nickname: z.string().optional() });
type ReadOptions = { retries?: number; timeoutMs?: number };
export async function currentUser(
  client: AccodingClient,
  options?: ReadOptions,
) {
  const result = userSchema.safeParse(
    await client.json("/api/users/me", options),
  );
  if (!result.success || result.data.id === "0")
    throw new ApiError("auth", "请先登录 Accoding。");
  return result.data;
}
export function loginForm(html: string, url: string) {
  const $ = cheerio.load(html);
  const form = $("input[name=password]").closest("form");
  const csrf = form.find("input[name=_csrf]").attr("value");
  const action = new URL(form.attr("action") || url, url);
  if (!csrf || action.origin !== ORIGIN || action.pathname !== "/user/login")
    throw new ApiError("protocol", "登录表单发生变化，无法安全登录。");
  return { csrf, action: action.href };
}
export async function login(username: string, password: string) {
  const candidate = new AccodingClient();
  const page = await candidate.request("/user/login");
  const form = loginForm(page.text, page.url);
  await candidate.request(form.action, {
    method: "POST",
    body: new URLSearchParams({
      _csrf: form.csrf,
      username,
      password,
    }).toString(),
  });
  const user = await currentUser(candidate);
  return { client: candidate, user };
}
const contestSchema = z.object({
  id: idSchema,
  title: z.string(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  problems: z.array(
    z.object({
      id: idSchema,
      title: z.string(),
      description: z.string(),
      test_setting: z.string(),
      contest_problem_list: z.object({ order: z.number() }),
    }),
  ),
});
const settingsSchema = z.object({
  supported_languages: z.string(),
  time_limit: z.union([z.string(), z.number()]).optional(),
  memory_limit: z.union([z.string(), z.number()]).optional(),
  special_judge: z.unknown().optional(),
  special_compared: z.unknown().optional(),
});
export class ContestAdapter {
  constructor(private client: AccodingClient) {}
  async fetch(id: string, options?: ReadOptions): Promise<Problem[]> {
    return (await this.snapshot(id, options)).problems;
  }
  async snapshot(id: string, options?: ReadOptions): Promise<ContestSnapshot> {
    id = idSchema.parse(id);
    const parsed = contestSchema.safeParse(
      await this.client.json(`/api/contests/${id}`, options),
    );
    if (!parsed.success || parsed.data.id !== id)
      throw new ApiError("protocol", "比赛数据缺失、无权限或接口结构变化。");
    const problems = [...parsed.data.problems].sort(
      (a, b) => a.contest_problem_list.order - b.contest_problem_list.order,
    );
    if (new Set(problems.map((p) => p.id)).size !== problems.length)
      throw new ApiError("protocol", "比赛出现重复题目 ID，无法安全映射题序。");
    const mapped: Problem[] = problems.map((p, index) => {
      let raw: unknown;
      try {
        raw = JSON.parse(p.test_setting);
      } catch {
        throw new ApiError("protocol", "题目评测设置不是有效 JSON。");
      }
      const s = settingsSchema.parse(raw);
      const samples = extractSamples("markdown", p.description);
      return {
        target: {
          kind: "contest",
          contestId: id,
          problemId: p.id,
          contestOrder: index,
        },
        title: p.title,
        label: String.fromCharCode(65 + index),
        statement: {
          format: "markdown",
          content: p.description,
          baseUrl: `${this.client.origin}/contest-ng/index.html`,
        },
        languages: s.supported_languages
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        ...samples,
        timeLimit: s.time_limit?.toString(),
        memoryLimit: s.memory_limit?.toString(),
        special:
          Boolean(s.special_judge) ||
          (s.special_compared !== undefined &&
            !["0", "", 0, false].includes(s.special_compared as string)),
      };
    });
    return {
      id: parsed.data.id,
      title: parsed.data.title,
      startTime: parsed.data.start_time,
      endTime: parsed.data.end_time,
      problems: mapped,
    };
  }
  async submit(
    target: Extract<Target, { kind: "contest" }>,
    code: string,
    lang: string,
    onSending?: () => Promise<void>,
  ): Promise<Submission> {
    const problem = (await this.fetch(target.contestId)).find(
      (p) => p.target.problemId === target.problemId,
    );
    if (!problem || problem.target.kind !== "contest")
      throw new ApiError("forbidden", "当前比赛已不包含此题，请同步后确认。");
    if (!problem.languages.includes(lang))
      throw new ApiError("protocol", "提交语言已失效，请重新选择。");
    await onSending?.();
    return parseSubmission(
      await this.client.json(`/api/contests/${target.contestId}/submissions`, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          code,
          lang,
          order: problem.target.contestOrder,
        }),
      }),
      problem.target,
    );
  }
  async list(
    target: Extract<Target, { kind: "contest" }>,
  ): Promise<Submission[]> {
    const data = z
      .array(z.unknown())
      .parse(
        await this.client.json(`/api/contests/${target.contestId}/submissions`),
      );
    return data
      .map((x) => parseSubmission(x, target))
      .filter((s) => s.problemId === target.problemId);
  }
  async get(
    target: Extract<Target, { kind: "contest" }>,
    id: string,
  ): Promise<Submission> {
    const s = parseSubmission(
      await this.client.json(
        `/api/contests/${target.contestId}/submission/${idSchema.parse(id)}`,
      ),
      target,
    );
    if (s.id !== id || (s.problemId && s.problemId !== target.problemId))
      throw new ApiError("protocol", "提交记录与目标不匹配。");
    return s;
  }
}
export function parseProblemPage(html: string, url: string, id: string) {
  const u = new URL(url);
  const $ = cheerio.load(html);
  if (u.pathname === "/user/login" || $("input[name=password]").length)
    throw new ApiError("auth", "请先登录 Accoding。");
  if (
    u.origin !== ORIGIN ||
    u.pathname !== `/problem/${id}/index` ||
    !$("h1.problem-title").length ||
    /题目不存在，或者你没有权限/.test(html)
  )
    throw new ApiError(
      "forbidden",
      "题目不存在或题库无访问权限；比赛权限不能替代题库权限。",
    );
  const heading = $("h1.problem-title");
  const body = heading.closest(".markdown-body").clone();
  body.find("script,form,input,select,textarea,button").remove();
  // Keep only the statement subtree; never persist the surrounding logged-in page.
  const content = cleanHtml(body.html() ?? "", url);
  const form = $("select[name=lang]").closest("form");
  const action = new URL(form.attr("action") || "", url);
  const languages = form
    .find("select[name=lang] option")
    .map((_i, el) => $(el).attr("value") ?? "")
    .get()
    .filter(Boolean);
  const csrf = form.find("input[name=_csrf]").attr("value");
  if (
    action.origin !== ORIGIN ||
    action.pathname !== `/problem/${id}/submit` ||
    !languages.length ||
    !csrf
  )
    throw new ApiError("protocol", "题目提交表单不完整或发生变化。");
  const text = body.text();
  const problem: Problem = {
    target: { kind: "problemset", problemId: id },
    title: heading.text(),
    label: `#${id}`,
    statement: { format: "html", content, baseUrl: url },
    languages,
    ...extractSamples("html", content),
    timeLimit: text.match(/时间限制[:：]\s*(\d+\s*\w+)/)?.[1],
    memoryLimit: text.match(/内存限制[:：]\s*(\d+\s*\w+)/)?.[1],
    special: /special judge|交互题|特殊评测/i.test(text),
  };
  return { problem, action: action.href, csrf };
}
export const submissionSchema = z.object({
  id: idSchema,
  result: z.string().min(1),
  problem_id: idSchema.optional(),
  creator_id: idSchema.optional(),
  lang: z.string().optional(),
  language: z.string().optional(),
  score: z.union([z.number(), z.string()]).nullable().optional(),
  detail: z.string().nullable().optional(),
});
export interface Submission {
  id: string;
  target: Target;
  result: string;
  problemId?: string;
  creatorId?: string;
  language?: string;
  score?: string;
  detail?: string;
}
export function parseSubmission(value: unknown, target: Target): Submission {
  const result = submissionSchema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      "protocol",
      "未收到可识别的提交 ID 和状态；请查询记录确认结果。",
    );
  const s = result.data;
  return {
    id: s.id,
    target,
    result: s.result,
    problemId: s.problem_id,
    creatorId: s.creator_id,
    language: s.lang ?? s.language,
    score: s.score?.toString(),
    detail: s.detail?.slice(0, 65536),
  };
}
export class ProblemsetAdapter {
  constructor(private client: AccodingClient) {}
  private async page(id: string) {
    id = idSchema.parse(id);
    const r = await this.client.request(`/problem/${id}/index`);
    return parseProblemPage(r.text, r.url, id);
  }
  async fetch(id: string) {
    return (await this.page(id)).problem;
  }
  async submit(
    target: Extract<Target, { kind: "problemset" }>,
    code: string,
    lang: string,
    onSending?: () => Promise<void>,
  ): Promise<Submission> {
    const { problem, action, csrf } = await this.page(target.problemId);
    if (!problem.languages.includes(lang))
      throw new ApiError("protocol", "提交语言已失效，请重新选择。");
    const identity = await currentUser(this.client);
    const before = new Set(
      (await this.list(target, identity.id)).map((s) => s.id),
    );
    await onSending?.();
    const r = await this.client.request(action, {
      method: "POST",
      body: new URLSearchParams({ _csrf: csrf, code, lang }).toString(),
    });
    // Accept a concrete ID only. A redirected list does not prove which submission was created.
    if (r.headers.get("content-type")?.includes("application/json"))
      return parseSubmission(JSON.parse(r.text), target);
    const match = new URL(r.url).pathname.match(
      /^\/submission\/(\d+)(?:\/index)?$/,
    );
    if (match) return this.get(target, match[1]);
    if (new URL(r.url).pathname === `/problem/${target.problemId}/submission`) {
      const $ = cheerio.load(r.text);
      const candidates = new Set<string>();
      $("a[href]").each((_i, el) => {
        const match = ($(el).attr("href") ?? "").match(/^\/submission\/(\d+)$/);
        if (match && !before.has(match[1])) candidates.add(match[1]);
      });
      const matches: Submission[] = [];
      for (const id of [...candidates].slice(0, 10)) {
        const record = await this.get(target, id);
        if (
          record.creatorId !== identity.id ||
          record.language !== lang ||
          record.problemId !== target.problemId
        )
          continue;
        const detail = await this.client.request(`/submission/${id}`);
        if (new URL(detail.url).pathname !== `/submission/${id}`) continue;
        const $detail = cheerio.load(detail.text);
        const presented = $detail("pre > code").text();
        const prefix = presented.match(
          /^\/\* \r?\n[\s\S]*?\r?\n\*\/\r?\n\r?\n/,
        );
        if (
          !prefix ||
          !prefix[0].includes(`Submission_id: ${id}`) ||
          !prefix[0].includes(`Problem_id: ${target.problemId}`)
        )
          continue;
        if (
          presented.slice(prefix[0].length).replace(/\r\n/g, "\n") ===
          code.replace(/\r\n/g, "\n")
        )
          matches.push(record);
      }
      if (matches.length === 1) return matches[0];
    }
    throw new ApiError(
      "unknown",
      "服务器已响应，但未返回明确提交 ID。请刷新本人记录确认，禁止自动重发。",
    );
  }
  async list(
    target: Extract<Target, { kind: "problemset" }>,
    userId: string,
  ): Promise<Submission[]> {
    const r = await this.client.request(
      `/problem/${target.problemId}/submission`,
    );
    const $ = cheerio.load(r.text);
    if (
      new URL(r.url).pathname !== `/problem/${target.problemId}/submission` ||
      $("input[name=password]").length
    )
      throw new ApiError("auth", "无法读取题库记录，请重新登录。");
    const ids: string[] = [];
    $("[id^=submission_id]").each((_i, el) => {
      const row = $(el).closest("tr");
      const owner = row.find(`a[href="/user/${idSchema.parse(userId)}/index"]`);
      const id = $(el).text().trim();
      if (owner.length && /^\d+$/.test(id)) ids.push(id);
    });
    if (!ids.length) return [];
    return this.query(target, ids);
  }
  private async query(target: Target, ids: string[]) {
    const q = new URLSearchParams({ submission_id: JSON.stringify(ids) });
    const data = z
      .array(z.unknown())
      .parse(await this.client.json(`/submission/getSubmissionApi?${q}`));
    return data
      .map((x) => parseSubmission(x, target))
      .filter((s) => ids.includes(s.id));
  }
  async get(target: Extract<Target, { kind: "problemset" }>, id: string) {
    const list = await this.query(target, [idSchema.parse(id)]);
    const s = list.find((s) => s.id === id);
    if (!s || (s.problemId && s.problemId !== target.problemId))
      throw new ApiError("protocol", "未找到对应题目的提交记录。");
    return s;
  }
}
