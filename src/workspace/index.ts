import fs from "node:fs/promises";
import { z } from "zod";
import {
  bindingId,
  idSchema,
  targetSchema,
  type Binding,
  type ContestSnapshot,
} from "../model";
import { bindingSchema, problemSchema } from "./schema";
import { safePath, atomicWrite } from "./fs";
const rosterSchema = z.object({
  schemaVersion: z.literal(2),
  generatedBy: z.literal("betterAccoding"),
  id: idSchema,
  title: z.string(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  fetchedAt: z.string(),
  problems: z.array(
    z.object({
      id: idSchema,
      title: z.string(),
      label: z.string(),
      order: z.number().int().nonnegative(),
    }),
  ),
});
export type ContestRoster = z.infer<typeof rosterSchema>;
const workspaceSchema = z.object({
  schemaVersion: z.literal(2),
  generatedBy: z.literal("betterAccoding"),
  bindings: z.array(
    z.object({
      bindingId: z.string(),
      target: targetSchema,
      sourceFile: z.string(),
      revision: z.number(),
      available: z.boolean(),
    }),
  ),
});
async function optional(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function readContestRoster(
  root: string,
  id: string,
): Promise<ContestRoster | undefined> {
  const raw = await optional(
    await safePath(root, `contests/${idSchema.parse(id)}/contest.json`),
  );
  if (raw === undefined) return;
  const parsed = rosterSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== id)
    throw Error("比赛元数据版本未知或损坏，原文件已保留。");
  return parsed.data;
}
export function validateContestSnapshot(
  snapshot: ContestSnapshot,
): ContestSnapshot {
  const result = z
    .object({
      id: idSchema,
      title: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      problems: z.array(problemSchema),
    })
    .parse(snapshot);
  const ids = new Set<string>();
  for (const p of result.problems) {
    if (p.target.kind !== "contest" || p.target.contestId !== result.id)
      throw Error("比赛题目来源不匹配。");
    if (ids.has(p.target.problemId)) throw Error("比赛题目 ID 重复。");
    ids.add(p.target.problemId);
  }
  return result;
}
export async function writeContestRoster(
  root: string,
  snapshot: ContestSnapshot,
) {
  snapshot = validateContestSnapshot(snapshot);
  await readContestRoster(root, snapshot.id);
  const roster: ContestRoster = {
    schemaVersion: 2,
    generatedBy: "betterAccoding",
    id: snapshot.id,
    title: snapshot.title,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    fetchedAt: new Date().toISOString(),
    problems: snapshot.problems.map((p) => {
      if (p.target.kind !== "contest" || p.target.contestId !== snapshot.id)
        throw Error("比赛题目来源不匹配。");
      return {
        id: p.target.problemId,
        title: p.title,
        label: p.label,
        order: p.target.contestOrder,
      };
    }),
  };
  if (new Set(roster.problems.map((p) => p.id)).size !== roster.problems.length)
    throw Error("比赛题目 ID 重复。");
  await atomicWrite(
    await safePath(
      root,
      `contests/${idSchema.parse(snapshot.id)}/contest.json`,
    ),
    JSON.stringify(roster, null, 2),
  );
}
/** Derived index: binding transactions are authoritative. Caller holds the workspace lock. */
export async function writeWorkspaceIndex(root: string) {
  const destination = await safePath(root, ".better-accoding/workspace.json");
  const existing = await optional(destination);
  if (existing !== undefined && !workspaceSchema.safeParse(existing).success)
    throw Error("工作区索引版本未知或损坏，原文件已保留。");
  let files: string[] = [];
  try {
    files = await fs.readdir(await safePath(root, ".better-accoding/bindings"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const bindings: Binding[] = [];
  for (const file of files.sort()) {
    if (!/^(problem-\d+|contest-\d+-\d+)\.json$/.test(file)) continue;
    const binding = bindingSchema.parse(
      await optional(await safePath(root, `.better-accoding/bindings/${file}`)),
    );
    if (
      binding.bindingId !== file.slice(0, -5) ||
      binding.bindingId !== bindingId(binding.problem.target)
    )
      throw Error("索引来源不匹配。");
    bindings.push(binding);
  }
  const content = JSON.stringify(
    {
      schemaVersion: 2,
      generatedBy: "betterAccoding",
      bindings: bindings.map((b) => ({
        bindingId: b.bindingId,
        target: b.problem.target,
        sourceFile: b.sourceFile,
        revision: b.revision,
        available: !b.unavailable,
      })),
      contests: [
        ...new Set(
          bindings.flatMap((b) =>
            b.problem.target.kind === "contest"
              ? [b.problem.target.contestId]
              : [],
          ),
        ),
      ].map((id) => ({ id, metadataFile: `contests/${id}/contest.json` })),
    },
    null,
    2,
  );
  if (JSON.stringify(existing) !== JSON.stringify(JSON.parse(content)))
    await atomicWrite(destination, content);
}
