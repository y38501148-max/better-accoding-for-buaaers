import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  bindingId,
  caseSchema,
  targetSchema,
  type Binding,
  type Problem,
  type TestCase,
} from "../model";
const problemSchema = z.object({
  target: targetSchema,
  title: z.string(),
  label: z.string(),
  statement: z.object({
    format: z.enum(["html", "markdown"]),
    content: z.string(),
    baseUrl: z.string(),
  }),
  languages: z.array(z.string()),
  samples: z.array(
    z.object({ key: z.string(), input: z.string(), expected: z.string() }),
  ),
  warnings: z.array(z.string()),
  timeLimit: z.string().optional(),
  memoryLimit: z.string().optional(),
  special: z.boolean(),
});
const bindingSchema = z.object({
  schemaVersion: z.literal(2),
  bindingId: z.string().regex(/^(problem-\d+|contest-\d+-\d+)$/),
  problem: problemSchema,
  sourceFile: z.string(),
  selectedSubmissionLanguage: z.string().optional(),
  fetchedAt: z.string(),
  revision: z.number().int().nonnegative(),
  cases: z.array(caseSchema),
  tombstones: z.array(z.string()),
});
export class ConflictError extends Error {}
export async function atomicWrite(
  file: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function safePath(
  root: string,
  relative: string,
): Promise<string> {
  const dest = path.resolve(root, relative),
    base = path.resolve(root);
  if (dest === base || !dest.startsWith(base + path.sep))
    throw new Error("拒绝工作区之外的路径。");
  let p = dest;
  for (;;) {
    try {
      const stat = await fs.lstat(p);
      if (stat.isSymbolicLink()) throw new Error("数据路径不能包含符号链接。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (p === base) break;
    p = path.dirname(p);
  }
  return dest;
}
export function newCase(name = "自定义用例"): TestCase {
  return {
    id: randomUUID(),
    name,
    source: "custom",
    input: "",
    expected: "",
    hasExpectedOutput: true,
    enabled: true,
    revision: 0,
    comparison: "exact",
    locallyModified: false,
  };
}
export class WorkspaceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  private file(id: string) {
    if (!/^(problem-\d+|contest-\d+-\d+)$/.test(id))
      throw new Error("无效题目绑定。");
    return safePath(this.root, `.better-accoding/bindings/${id}.json`);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }
  async list(): Promise<Binding[]> {
    const dir = await safePath(this.root, ".better-accoding/bindings");
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => this.read(f.slice(0, -5))),
    );
  }
  async read(id: string): Promise<Binding> {
    const raw = JSON.parse(await fs.readFile(await this.file(id), "utf8"));
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("工作区数据版本不兼容或已损坏，原文件已保留；请勿覆盖。");
    if (parsed.data.bindingId !== bindingId(parsed.data.problem.target))
      throw new Error("绑定来源不匹配。");
    await safePath(this.root, parsed.data.sourceFile);
    return parsed.data;
  }
  async import(problem: Problem): Promise<Binding> {
    return this.serialize(async () => {
      problem = problemSchema.parse(problem);
      const id = bindingId(problem.target);
      try {
        return await this.read(id);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const base =
        problem.target.kind === "problemset"
          ? `problems/${problem.target.problemId}`
          : `contests/${problem.target.contestId}/${problem.target.problemId}`;
      const sourceFile = `${base}/main.${problem.languages.includes("c") ? "c" : "cpp"}`;
      const file = await safePath(this.root, sourceFile);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.writeFile(
          file,
          sourceFile.endsWith(".c")
            ? "#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n"
            : "#include <iostream>\n\nint main() {\n    return 0;\n}\n",
          { flag: "wx" },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const binding: Binding = {
        schemaVersion: 2,
        bindingId: id,
        problem,
        sourceFile,
        fetchedAt: new Date().toISOString(),
        revision: 0,
        cases: problem.samples.map((s, i) => ({
          ...newCase(`样例 ${i + 1}`),
          source: "sample",
          upstreamSampleKey: s.key,
          input: s.input,
          expected: s.expected,
          baseline: { input: s.input, expected: s.expected },
        })),
        tombstones: [],
      };
      await atomicWrite(await this.file(id), JSON.stringify(binding, null, 2));
      return binding;
    });
  }
  async update(
    id: string,
    baseRevision: number,
    change: (binding: Binding) => void,
  ): Promise<Binding> {
    return this.serialize(async () => {
      const binding = await this.read(id);
      if (binding.revision !== baseRevision)
        throw new ConflictError(
          "用例已被其他窗口或外部编辑修改。草稿保留，请重新载入并核对。",
        );
      change(binding);
      binding.revision++;
      bindingSchema.parse(binding);
      await safePath(this.root, binding.sourceFile);
      await atomicWrite(await this.file(id), JSON.stringify(binding, null, 2));
      return binding;
    });
  }
  async saveCases(
    id: string,
    baseRevision: number,
    cases: TestCase[],
  ): Promise<Binding> {
    const validated = z.array(caseSchema).max(500).parse(cases);
    if (new Set(validated.map((c) => c.id)).size !== validated.length)
      throw new Error("用例 ID 重复。");
    return this.update(id, baseRevision, (b) => {
      const old = new Map(b.cases.map((c) => [c.id, c]));
      for (const previous of b.cases)
        if (
          previous.upstreamSampleKey &&
          !validated.some((c) => c.id === previous.id)
        )
          b.tombstones.push(previous.upstreamSampleKey);
      b.cases = validated.map((next) => {
        const previous = old.get(next.id);
        const baseline = previous?.baseline;
        const changed =
          !previous ||
          ["input", "expected", "hasExpectedOutput", "comparison"].some(
            (k) => next[k as keyof TestCase] !== previous[k as keyof TestCase],
          );
        return {
          ...next,
          source:
            previous?.source ??
            (next.source === "imported" ? "imported" : "custom"),
          upstreamSampleKey: previous?.upstreamSampleKey,
          baseline,
          revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
          locallyModified: baseline
            ? next.input !== baseline.input ||
              next.expected !== baseline.expected
            : false,
        };
      });
    });
  }
  async sync(binding: Binding, problem: Problem) {
    if (bindingId(problem.target) !== binding.bindingId)
      throw new Error("拒绝更换同步来源。");
    return this.update(binding.bindingId, binding.revision, (b) => {
      b.problem = problem;
      b.fetchedAt = new Date().toISOString();
      for (const sample of problem.samples) {
        if (b.tombstones.includes(sample.key)) continue;
        const c = b.cases.find((x) => x.upstreamSampleKey === sample.key);
        if (!c) {
          b.cases.push({
            ...newCase(`样例 ${sample.key}`),
            source: "sample",
            input: sample.input,
            expected: sample.expected,
            upstreamSampleKey: sample.key,
            baseline: { input: sample.input, expected: sample.expected },
          });
          continue;
        }
        if (!c.locallyModified) {
          if (c.input !== sample.input || c.expected !== sample.expected)
            c.revision++;
          c.input = sample.input;
          c.expected = sample.expected;
        } else if (
          c.baseline?.input !== sample.input ||
          c.baseline?.expected !== sample.expected
        )
          b.problem.warnings.push(`${c.name}：官方样例更新，已保留本地修改。`);
        c.baseline = { input: sample.input, expected: sample.expected };
        c.locallyModified =
          c.input !== sample.input || c.expected !== sample.expected;
      }
    });
  }
}
