import { z } from "zod";
import { createHash } from "node:crypto";
export const ORIGIN = "https://accoding.buaa.edu.cn";
export const ADMIN_ORIGIN = "https://accoding.buaa.edu.cn:4000";
export const idSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform(String);
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("problemset"), problemId: idSchema }),
  z.object({
    kind: z.literal("contest"),
    contestId: idSchema,
    problemId: idSchema,
    contestOrder: z.number().int().nonnegative(),
  }),
]);
export type Target = z.infer<typeof targetSchema>;
export const comparisonSchema = z.enum(["exact", "trim-line-end", "tokens"]);
export type Comparison = z.infer<typeof comparisonSchema>;
export interface Sample {
  key: string;
  input: string;
  expected: string;
}
export interface Problem {
  target: Target;
  title: string;
  label: string;
  statement: { format: "markdown" | "html"; content: string; baseUrl: string };
  languages: string[];
  samples: Sample[];
  warnings: string[];
  timeLimit?: string;
  memoryLimit?: string;
  special: boolean;
}
export const caseSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]+$/),
  name: z.string().max(200),
  source: z.enum(["sample", "custom", "imported"]),
  inputFile: z.string().optional(),
  expectedOutputFile: z.string().optional(),
  input: z.string().max(4 * 1024 * 1024),
  expected: z.string().max(4 * 1024 * 1024),
  hasExpectedOutput: z.boolean(),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  comparison: comparisonSchema,
  upstreamSampleKey: z.string().optional(),
  locallyModified: z.boolean(),
  baseline: z.object({ input: z.string(), expected: z.string() }).optional(),
});
export type TestCase = z.infer<typeof caseSchema>;
export interface Binding {
  schemaVersion: 2;
  bindingId: string;
  problem: Problem;
  sourceFile: string;
  selectedSubmissionLanguage?: string;
  fetchedAt: string;
  revision: number;
  cases: TestCase[];
  tombstones: string[];
  deletedCases?: TestCase[];
  fileHashes?: Record<string, string>;
}
export interface Session {
  root: string;
  binding: Binding;
}
export function bindingId(target: Target): string {
  return target.kind === "problemset"
    ? `problem-${target.problemId}`
    : `contest-${target.contestId}-${target.problemId}`;
}
export function targetLabel(target: Target): string {
  return target.kind === "problemset"
    ? `题库 #${target.problemId}`
    : `比赛 #${target.contestId} · #${target.problemId}`;
}
export function problemUrl(target: Target): string {
  return target.kind === "problemset"
    ? `${ORIGIN}/problem/${target.problemId}/index`
    : `${ORIGIN}/contest-ng/index.html#/${target.contestId}`;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function parseImport(
  value: string,
  mode?: "problemset" | "contest",
): { kind: "problemset" | "contest"; id: string } {
  value = value.trim();
  if (/^\d+$/.test(value) && mode)
    return { kind: mode, id: BigInt(value).toString() };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入非负整数题号/比赛 ID，或完整 Accoding 链接。");
  }
  if (
    ![ORIGIN, ADMIN_ORIGIN].includes(url.origin) ||
    url.username ||
    url.password
  )
    throw new Error("仅接受 Accoding 学生端或 4000 管理端 HTTPS 链接。");
  const p = url.pathname.match(/^\/problem\/(\d+)(?:\/index)?\/?$/);
  const c =
    url.pathname === "/contest-ng/index.html"
      ? url.hash.match(/^#\/(\d+)(?:\/.*)?$/)
      : url.pathname.match(
          /^\/contest\/(\d+)(?:\/index|\/problem|\/edit)?\/?$/,
        );
  if (p) return { kind: "problemset", id: BigInt(p[1]).toString() };
  if (c) return { kind: "contest", id: BigInt(c[1]).toString() };
  throw new Error("无法识别题目或比赛链接；比赛内字母不能单独作为题号。");
}
