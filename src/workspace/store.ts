import * as fs from "node:fs/promises";
import { extractSamples } from "../problems/statement";
import {
  readContestRoster,
  writeContestRoster,
  writeWorkspaceIndex,
} from "./index";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withWorkspaceLock } from "./lock";
import {
  commitCaseFiles,
  recoverCaseTransaction,
  readExternalCaseEdits,
  caseFile,
} from "./case-files";
import {
  bindingId,
  hash,
  caseSchema,
  type Binding,
  type Problem,
  type ContestSnapshot,
  type TestCase,
} from "../model";
import { problemSchema, bindingSchema } from "./schema";
export { ConflictError, atomicWrite, safePath } from "./fs";
import { ConflictError, safePath } from "./fs";
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
    comparison: "trim-line-end",
    locallyModified: false,
  };
}
export class WorkspaceStore {
  private pending: Promise<unknown> = Promise.resolve();
  private observed = new Map<string, { revision: number; hash: string }>();
  constructor(readonly root: string) {}
  private file(id: string) {
    if (!/^(problem-\d+|contest-\d+-\d+)$/.test(id))
      throw new Error("无效题目绑定。");
    return safePath(this.root, `.better-accoding/bindings/${id}.json`);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(async () =>
      withWorkspaceLock(
        await safePath(this.root, ".better-accoding/write.lock"),
        async () => {
          await writeWorkspaceIndex(this.root);
          const result = await action();
          await writeWorkspaceIndex(this.root);
          return result;
        },
      ),
    );
    this.pending = task.catch(() => {});
    return task;
  }
  async list(): Promise<Binding[]> {
    return this.serialize(async () => {
      const ids = new Set<string>();
      for (const relative of [
        ".better-accoding/bindings",
        ".better-accoding/transactions",
      ]) {
        try {
          for (const file of await fs.readdir(
            await safePath(this.root, relative),
          ))
            if (/^(problem-\d+|contest-\d+-\d+)\.json$/.test(file))
              ids.add(file.slice(0, -5));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const bindings: Binding[] = [];
      for (const id of ids)
        bindings.push(await this.remember(await this.readUnlocked(id)));
      return bindings;
    });
  }
  async read(id: string): Promise<Binding> {
    return this.serialize(async () =>
      this.remember(await this.readUnlocked(id)),
    );
  }
  private async remember(binding: Binding) {
    const raw = await fs.readFile(await this.file(binding.bindingId), "utf8");
    this.observed.set(binding.bindingId, {
      revision: binding.revision,
      hash: hash(raw),
    });
    return binding;
  }
  private async readUnlocked(id: string): Promise<Binding> {
    const file = await this.file(id);
    await recoverCaseTransaction(this.root, id);
    const rawJSON = await fs.readFile(file, "utf8");
    const raw = JSON.parse(rawJSON);
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("工作区数据版本不兼容或已损坏，原文件已保留；请勿覆盖。");
    if (parsed.data.bindingId !== bindingId(parsed.data.problem.target))
      throw new Error("绑定来源不匹配。");
    await safePath(this.root, parsed.data.sourceFile);
    const binding = parsed.data;
    const previous = structuredClone(binding);
    const observed = this.observed.get(id);
    const metadataChanged =
      observed?.revision === binding.revision &&
      observed.hash !== hash(rawJSON);
    const externalChanged = binding.fileHashes
      ? await readExternalCaseEdits(this.root, binding)
      : false;
    const migratedComparison = binding.comparisonDefaultsVersion !== 1;
    if (migratedComparison) {
      for (const c of [...binding.cases, ...(binding.deletedCases ?? [])]) {
        if (c.comparison === "exact") {
          c.comparison = "trim-line-end";
          c.revision++;
        }
      }
      binding.comparisonDefaultsVersion = 1;
      binding.revision++;
    }
    const repairedSamples = this.restoreOutputOnlySamples(binding);
    if (repairedSamples) binding.revision++;
    if (!binding.fileHashes) {
      // Back up the original format before the first file-model transaction.
      const backup = await safePath(
        this.root,
        `.better-accoding/backups/${id}-${hash(rawJSON)}.json`,
      );
      try {
        await fs.writeFile(backup, rawJSON, { flag: "wx", mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.writeFile(backup, rawJSON, { flag: "wx", mode: 0o600 });
        } else if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      await commitCaseFiles(this.root, binding, previous, rawJSON);
    } else {
      if (metadataChanged) binding.revision++;
      if (
        externalChanged ||
        metadataChanged ||
        repairedSamples ||
        migratedComparison
      ) {
        // External files already contain the new data. Commit their versions without
        // rewriting them, so queued Webview saves must resolve the revision conflict.
        if ((await fs.readFile(file, "utf8")) !== rawJSON)
          throw new ConflictError("读取期间元数据被外部修改，未覆盖文件。");
        await commitCaseFiles(this.root, binding, previous, rawJSON);
      }
    }
    return binding;
  }
  private restoreOutputOnlySamples(binding: Binding): boolean {
    if (binding.problem.samples.length) return false;
    const parsed = extractSamples(
      binding.problem.statement.format,
      binding.problem.statement.content,
    );
    if (
      !parsed.samples.length ||
      parsed.warnings.length ||
      parsed.samples.some((sample) => sample.input !== "")
    )
      return false;
    binding.problem.samples = parsed.samples;
    binding.problem.warnings = binding.problem.warnings.filter(
      (warning) =>
        warning !== "公开样例未能完整配对，请检查题面并手动补充用例。",
    );
    for (const sample of parsed.samples) {
      if (
        binding.tombstones.includes(sample.key) ||
        binding.cases.some((c) => c.upstreamSampleKey === sample.key)
      )
        continue;
      binding.cases.push({
        ...newCase(`样例 ${sample.key.replace("sample-", "")}`),
        source: "sample",
        input: "",
        expected: sample.expected,
        upstreamSampleKey: sample.key,
        baseline: { input: "", expected: sample.expected },
      });
    }
    return true;
  }
  contestRoster(id: string) {
    return this.serialize(() => readContestRoster(this.root, id));
  }
  recordContest(snapshot: ContestSnapshot) {
    return this.serialize(() => writeContestRoster(this.root, snapshot));
  }
  markRemoved(binding: Binding) {
    if (binding.problem.target.kind !== "contest")
      throw Error("只有比赛绑定可以标记为移除。");
    if (binding.unavailable) return this.read(binding.bindingId);
    return this.update(binding.bindingId, binding.revision, (b) => {
      b.unavailable = {
        reason: "removed",
        checkedAt: new Date().toISOString(),
      };
    });
  }
  async caseUriPath(id: string, caseId: string, kind: "input" | "expected") {
    const binding = await this.read(id);
    if (!binding.cases.some((c) => c.id === caseId))
      throw new Error("用例已不存在。");
    return safePath(this.root, caseFile(binding, caseId, kind));
  }
  async import(problem: Problem): Promise<Binding> {
    return this.serialize(async () => {
      problem = problemSchema.parse(problem);
      const id = bindingId(problem.target);
      try {
        return await this.remember(await this.readUnlocked(id));
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
            ? "#include <stdio.h>\n\nint main() {\n    return 0;\n}\n"
            : "#include <iostream>\n\nint main() {\n    return 0;\n}\n",
          { flag: "wx" },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const binding: Binding = {
        schemaVersion: 2,
        comparisonDefaultsVersion: 1,
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
      await commitCaseFiles(this.root, binding);
      return this.remember(binding);
    });
  }
  async update(
    id: string,
    baseRevision: number,
    change: (binding: Binding) => void,
  ): Promise<Binding> {
    return this.serialize(async () => {
      const binding = await this.readUnlocked(id);
      const previousJSON = await fs.readFile(await this.file(id), "utf8");
      const observed = this.observed.get(id);
      if (
        binding.revision === baseRevision &&
        observed?.revision === baseRevision &&
        observed.hash !== hash(previousJSON)
      )
        throw new ConflictError(
          "元数据在外部发生更改，草稿已保留，请重新载入后核对。",
        );
      if (binding.revision !== baseRevision)
        throw new ConflictError(
          "用例已被其他窗口或外部编辑修改。草稿保留，请重新载入并核对。",
        );
      const previous = structuredClone(binding);
      change(binding);
      binding.revision++;
      bindingSchema.parse(binding);
      await safePath(this.root, binding.sourceFile);
      await commitCaseFiles(this.root, binding, previous, previousJSON);
      return this.remember(binding);
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
      b.deletedCases ??= [];
      for (const previous of b.cases) {
        if (!validated.some((c) => c.id === previous.id)) {
          b.deletedCases = b.deletedCases.filter((c) => c.id !== previous.id);
          b.deletedCases.push(previous);
          if (previous.upstreamSampleKey)
            b.tombstones.push(previous.upstreamSampleKey);
        }
      }
      b.cases = validated.map((next) => {
        const previous =
          old.get(next.id) ?? b.deletedCases?.find((c) => c.id === next.id);
        if (previous?.upstreamSampleKey)
          b.tombstones = b.tombstones.filter(
            (key) => key !== previous.upstreamSampleKey,
          );
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
      b.deletedCases = b.deletedCases
        .filter((c) => !b.cases.some((current) => current.id === c.id))
        .slice(-100);
    });
  }
  async sync(binding: Binding, problem: Problem) {
    problem = problemSchema.parse(problem);
    if (bindingId(problem.target) !== binding.bindingId)
      throw new Error("拒绝更换同步来源。");
    return this.update(binding.bindingId, binding.revision, (b) => {
      b.problem = problem;
      delete b.unavailable;
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
