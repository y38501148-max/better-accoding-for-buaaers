import fs from "node:fs/promises";
import { z } from "zod";
import { hash, type Binding } from "../model";
import { bindingSchema } from "./schema";
import { renderStatement } from "../problems/statement";
import { atomicWrite, safePath, ConflictError } from "./fs";

export function problemDirectory(binding: Binding) {
  const target = binding.problem.target;
  return target.kind === "problemset"
    ? `problems/${target.problemId}`
    : `contests/${target.contestId}/${target.problemId}`;
}
export function caseFile(
  binding: Binding,
  id: string,
  kind: "input" | "expected",
) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效用例 ID。");
  return `${problemDirectory(binding)}/tests/${id}.${kind === "input" ? "in" : "out"}`;
}
function contents(binding: Binding) {
  const files: Record<string, string> = {};
  const directory = problemDirectory(binding);
  for (const c of binding.cases) {
    c.inputFile = caseFile(binding, c.id, "input");
    c.expectedOutputFile = c.hasExpectedOutput
      ? caseFile(binding, c.id, "expected")
      : undefined;
    files[c.inputFile] = c.input;
    if (c.expectedOutputFile) files[c.expectedOutputFile] = c.expected;
    if (c.baseline) {
      files[`${directory}/tests/originals/${c.id}.in`] = c.baseline.input;
      files[`${directory}/tests/originals/${c.id}.out`] = c.baseline.expected;
    }
  }
  files[`${directory}/tests/tests.json`] = JSON.stringify(
    {
      schemaVersion: 2,
      bindingId: binding.bindingId,
      revision: binding.revision,
      cases: binding.cases.map((c, order) => {
        const { input, expected, baseline } = c;
        return {
          id: c.id,
          name: c.name,
          source: c.source,
          inputFile: c.inputFile,
          expectedOutputFile: c.expectedOutputFile,
          hasExpectedOutput: c.hasExpectedOutput,
          enabled: c.enabled,
          revision: c.revision,
          comparison: c.comparison,
          upstreamSampleKey: c.upstreamSampleKey,
          locallyModified: c.locallyModified,
          order,
          contentHash: hash(
            JSON.stringify([
              input,
              expected,
              c.hasExpectedOutput,
              c.comparison,
            ]),
          ),
          baselineHash: baseline ? hash(JSON.stringify(baseline)) : undefined,
        };
      }),
      tombstones: binding.tombstones,
    },
    null,
    2,
  );
  files[`${directory}/problem.json`] = JSON.stringify(
    {
      schemaVersion: 2,
      bindingId: binding.bindingId,
      target: binding.problem.target,
      title: binding.problem.title,
      label: binding.problem.label,
      sourceFile: binding.sourceFile,
      supportedLanguages: binding.problem.languages,
      selectedSubmissionLanguage: binding.selectedSubmissionLanguage,
      statementFormat: binding.problem.statement.format,
      fetchedAt: binding.fetchedAt,
      statementHash: hash(binding.problem.statement.content),
      unavailable: binding.unavailable,
    },
    null,
    2,
  );
  files[
    `${directory}/${binding.problem.statement.format === "markdown" ? "problem.md" : "statement.html"}`
  ] =
    binding.problem.statement.format === "markdown"
      ? binding.problem.statement.content
      : renderStatement(
          "html",
          binding.problem.statement.content,
          binding.problem.statement.baseUrl,
        );
  return files;
}
const journalSchema = z.object({
  version: z.literal(1),
  beforeBindingHash: z.string().nullable(),
  binding: bindingSchema,
  writes: z.record(
    z.object({ before: z.string().nullable(), content: z.string() }),
  ),
});
async function readOptional(
  root: string,
  file: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(await safePath(root, file), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
const digest = (value: string | undefined) =>
  value === undefined ? null : hash(value);
const metadataPath = (id: string) => `.better-accoding/bindings/${id}.json`;
const journalPath = (id: string) => `.better-accoding/transactions/${id}.json`;

/** Caller holds the workspace lock. Replay only recognized old/new bytes. */
export async function recoverCaseTransaction(root: string, id: string) {
  const raw = await readOptional(root, journalPath(id));
  if (raw === undefined) return;
  const transaction = journalSchema.parse(JSON.parse(raw));
  if (transaction.binding.bindingId !== id)
    throw new Error("事务与题目来源不匹配，已保留待恢复文件。");
  const allowed = contents(structuredClone(transaction.binding));
  const nextJSON = JSON.stringify(transaction.binding, null, 2);
  const currentJSON = await readOptional(root, metadataPath(id));
  if (
    ![transaction.beforeBindingHash, hash(nextJSON)].includes(
      digest(currentJSON),
    )
  )
    throw new ConflictError(
      "恢复事务时发现元数据被外部修改；原数据和恢复记录均已保留。",
    );
  // Validate every target and byte version before changing any file.
  for (const [file, write] of Object.entries(transaction.writes)) {
    if (!(file in allowed) || allowed[file] !== write.content)
      throw new Error("事务包含非用例文件，拒绝恢复。");
    const current = await readOptional(root, file);
    if (![write.before, hash(write.content)].includes(digest(current)))
      throw new ConflictError(
        `恢复事务时发现外部编辑：${file}。已保留文件和恢复记录，请先备份并核对。`,
      );
  }
  for (const [file, write] of Object.entries(transaction.writes)) {
    if ((await readOptional(root, file)) !== write.content)
      await atomicWrite(await safePath(root, file), write.content);
  }
  await atomicWrite(await safePath(root, metadataPath(id)), nextJSON);
  await fs.rm(await safePath(root, journalPath(id)));
}

/** Files are durable before the JSON revision/ACK becomes visible. */
export async function commitCaseFiles(
  root: string,
  binding: Binding,
  previous?: Binding,
  previousJSON?: string,
) {
  const planned = contents(binding);
  const old = previous ? contents(structuredClone(previous)) : {};
  // Preserve deleted files for undo/recovery, including external edits: never erase them.
  if (previous)
    for (const c of previous.deletedCases ?? []) {
      old[caseFile(previous, c.id, "input")] = c.input;
      if (c.hasExpectedOutput)
        old[caseFile(previous, c.id, "expected")] = c.expected;
    }
  const writes: Record<string, { before: string | null; content: string }> = {};
  binding.fileHashes = {};
  for (const [file, content] of Object.entries(planned)) {
    const current = await readOptional(root, file);
    const expected =
      previous?.fileHashes?.[file] ??
      (previous?.fileHashes && file in old && current !== undefined
        ? hash(old[file])
        : null);
    if (digest(current) !== expected && current !== content)
      throw new ConflictError(
        `用例文件已在外部修改：${file}。请重新载入后核对，草稿未覆盖该文件。`,
      );
    // Initial migration may create files that did not exist in the old JSON format.
    if (
      current === undefined &&
      previous?.fileHashes &&
      file in previous.fileHashes
    )
      throw new ConflictError(
        `用例文件已丢失：${file}。原始内容仍保存在元数据中，请先恢复文件。`,
      );
    binding.fileHashes[file] = hash(content);
    if (current !== content)
      writes[file] = { before: digest(current), content };
  }
  const currentJSON = await readOptional(root, metadataPath(binding.bindingId));
  if (digest(currentJSON) !== digest(previousJSON))
    throw new ConflictError("元数据在保存期间被外部修改，未覆盖原文件。");
  const transaction = {
    version: 1 as const,
    beforeBindingHash: digest(previousJSON),
    binding,
    writes,
  };
  await atomicWrite(
    await safePath(root, journalPath(binding.bindingId)),
    JSON.stringify(transaction),
  );
  await recoverCaseTransaction(root, binding.bindingId);
}

/** Import edits made directly to .in/.out, bumping the version before any UI save. */
export async function readExternalCaseEdits(root: string, binding: Binding) {
  if (!binding.fileHashes) return false;
  let changed = false;
  for (const c of binding.cases) {
    let caseChanged = false;
    for (const kind of ["input", "expected"] as const) {
      if (kind === "expected" && !c.hasExpectedOutput) continue;
      const file = caseFile(binding, c.id, kind);
      const value = await readOptional(root, file);
      if (value === undefined)
        throw new ConflictError(
          `用例文件已丢失：${file}。元数据中的原始内容已保留。`,
        );
      if (value.length > 4 * 1024 * 1024)
        throw new Error(`用例文件超过 4 MiB：${file}`);
      if (hash(value) !== binding.fileHashes[file]) {
        c[kind] = value;
        binding.fileHashes[file] = hash(value);
        caseChanged = true;
      }
    }
    if (caseChanged) {
      c.revision++;
      c.locallyModified =
        !!c.baseline &&
        (c.input !== c.baseline.input || c.expected !== c.baseline.expected);
      changed = true;
    }
  }
  if (changed) binding.revision++;
  return changed;
}
