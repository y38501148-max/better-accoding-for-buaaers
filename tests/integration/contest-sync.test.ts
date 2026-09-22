import { it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { syncContest } from "../../src/workspace/contest";
import type { ContestSnapshot } from "../../src/model";
import { problem } from "../fixtures/synthetic";
import * as disk from "../../src/workspace/fs";
let root: string, store: WorkspaceStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-contest-"));
  store = new WorkspaceStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const roster = (...ids: string[]): ContestSnapshot => ({
  id: "7",
  title: "Practice",
  startTime: "2026-09-22T00:00:00Z",
  problems: ids.map((id, i) => ({
    ...structuredClone(problem),
    title: `Problem ${id}`,
    label: String.fromCharCode(65 + i),
    target: { kind: "contest", contestId: "7", problemId: id, contestOrder: i },
  })),
});
const json = async (relative: string) =>
  JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
it("adds genuinely new problems without importing previously unselected problems", async () => {
  const initial = roster("1", "2");
  await store.import(initial.problems[0]);
  await store.recordContest(initial);
  await syncContest(store, roster("2", "1", "3"));
  const bindings = await store.list();
  expect(bindings.map((b) => b.problem.target.problemId).sort()).toEqual([
    "1",
    "3",
  ]);
  expect(
    bindings.find((b) => b.problem.target.problemId === "1")!.problem.label,
  ).toBe("B");
  const meta = await json("contests/7/contest.json");
  expect(meta.problems.map((p: { id: string }) => p.id)).toEqual([
    "2",
    "1",
    "3",
  ]);
  expect(meta.startTime).toBe(initial.startTime);
});
it("retains code, custom sample edits and files when removed, then restores availability", async () => {
  let b = await store.import(roster("1").problems[0]);
  await store.recordContest(roster("1"));
  await fs.writeFile(path.join(root, b.sourceFile), "USER SOURCE");
  await fs.writeFile(path.join(root, b.cases[0].inputFile!), "LOCAL INPUT\n");
  await syncContest(store, roster());
  b = await new WorkspaceStore(root).read(b.bindingId);
  expect(b.unavailable?.reason).toBe("removed");
  expect(b.cases[0].input).toBe("LOCAL INPUT\n");
  expect(await fs.readFile(path.join(root, b.sourceFile), "utf8")).toBe(
    "USER SOURCE",
  );
  expect(
    (await json(".better-accoding/workspace.json")).bindings[0].available,
  ).toBe(false);
  expect((await json("contests/7/1/problem.json")).unavailable.reason).toBe(
    "removed",
  );
  await syncContest(store, roster("2", "1"));
  b = await store.read(b.bindingId);
  expect(b.unavailable).toBeUndefined();
  expect(b.problem.label).toBe("B");
  expect(b.cases[0].input).toBe("LOCAL INPUT\n");
  expect(b.cases[0].locallyModified).toBe(true);
  expect(
    (await json(".better-accoding/workspace.json")).bindings.every(
      (b: { available: boolean }) => b.available,
    ),
  ).toBe(true);
});
it("single problem sync leaves the full roster baseline for later new additions", async () => {
  const b = await store.import(roster("1").problems[0]);
  await store.recordContest(roster("1", "2"));
  await syncContest(store, roster("1", "2", "3"), undefined, b.bindingId);
  expect((await store.list()).length).toBe(1);
  expect((await store.contestRoster("7"))!.problems.length).toBe(2);
  await syncContest(store, roster("1", "2", "3"));
  expect(
    (await store.list()).map((b) => b.problem.target.problemId).sort(),
  ).toEqual(["1", "3"]);
});
it.each(["duplicate", "wrong-contest", "bad-problem"])(
  "validates entire %s snapshot before any binding changes",
  async (kind) => {
    const b = await store.import(roster("1").problems[0]);
    await store.recordContest(roster("1"));
    const snapshot = roster("1", "2");
    if (kind === "duplicate") snapshot.problems.push(snapshot.problems[0]);
    if (kind === "wrong-contest")
      snapshot.problems[1].target = { kind: "problemset", problemId: "2" };
    if (kind === "bad-problem")
      snapshot.problems[1].title = null as unknown as string;
    const before = await fs.readFile(
      path.join(root, ".better-accoding/workspace.json"),
      "utf8",
    );
    await expect(syncContest(store, snapshot)).rejects.toThrow();
    expect((await store.read(b.bindingId)).revision).toBe(b.revision);
    expect(
      await fs.readFile(
        path.join(root, ".better-accoding/workspace.json"),
        "utf8",
      ),
    ).toBe(before);
  },
);
it("retries partial sync without losing a new problem or overwriting source", async () => {
  const b = await store.import(roster("1").problems[0]);
  await store.recordContest(roster("1"));
  await expect(
    syncContest(store, roster("1", "2", "3"), async (p) => {
      if (p.target.problemId === "3") throw Error("cancelled");
      return p;
    }),
  ).rejects.toThrow("cancelled");
  expect((await store.contestRoster("7"))!.problems.map((p) => p.id)).toEqual([
    "1",
  ]);
  await fs.writeFile(path.join(root, b.sourceFile), "KEEP");
  await syncContest(new WorkspaceStore(root), roster("1", "2", "3"));
  expect(await store.list()).toHaveLength(3);
  expect(await fs.readFile(path.join(root, b.sourceFile), "utf8")).toBe("KEEP");
});
it("rebuilds a missing or stale index after a committed binding write was interrupted", async () => {
  const b = await store.import(roster("1").problems[0]);
  const original = disk.atomicWrite;
  const spy = vi
    .spyOn(disk, "atomicWrite")
    .mockImplementation(async (file, data) => {
      if (file.endsWith("workspace.json")) throw Error("disk interrupted");
      return original(file, data);
    });
  await expect(store.markRemoved(b)).rejects.toThrow("disk interrupted");
  spy.mockRestore();
  await new WorkspaceStore(root).list();
  expect(
    (await json(".better-accoding/workspace.json")).bindings[0].available,
  ).toBe(false);
  await fs.unlink(path.join(root, ".better-accoding/workspace.json"));
  await new WorkspaceStore(root).list();
  expect(
    (await json(".better-accoding/workspace.json")).bindings[0].available,
  ).toBe(false);
});
it.each([".better-accoding/workspace.json", "contests/7/contest.json"])(
  "preserves an unknown %s format and stops sync before changing data",
  async (file) => {
    const b = await store.import(roster("1").problems[0]);
    await store.recordContest(roster("1"));
    const savedBinding = await fs.readFile(
      path.join(root, `.better-accoding/bindings/${b.bindingId}.json`),
      "utf8",
    );
    const raw = '{"schemaVersion":99}';
    await fs.writeFile(path.join(root, file), raw);
    await expect(syncContest(store, roster())).rejects.toThrow();
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe(raw);
    expect(
      await fs.readFile(
        path.join(root, `.better-accoding/bindings/${b.bindingId}.json`),
        "utf8",
      ),
    ).toBe(savedBinding);
  },
);
