import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, newCase, safePath } from "../../src/workspace/store";
import { problem } from "../fixtures/synthetic";
let root: string, store: WorkspaceStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-store-"));
  store = new WorkspaceStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("preserves source and modifications on reimport and sync", async () => {
  let b = await store.import(problem);
  await fs.writeFile(path.join(root, b.sourceFile), "KEEP USER CODE");
  b.cases[0].input = "local\n";
  b = await store.saveCases(b.bindingId, b.revision, b.cases);
  expect((await store.import(problem)).cases[0].input).toBe("local\n");
  b = await store.sync(b, {
    ...problem,
    samples: [{ key: "sample-1", input: "new\n", expected: "4\n" }],
  });
  expect(b.cases[0].input).toBe("local\n");
  expect(b.cases[0].baseline?.input).toBe("new\n");
  expect(await fs.readFile(path.join(root, b.sourceFile), "utf8")).toBe(
    "KEEP USER CODE",
  );
});
it("persists empty expected vs unchecked and exact whitespace", async () => {
  let b = await store.import(problem);
  b.cases = [
    { ...newCase(), input: "\t \n\n", expected: "", hasExpectedOutput: true },
    { ...newCase(), hasExpectedOutput: false },
  ];
  b = await store.saveCases(b.bindingId, b.revision, b.cases);
  const reload = await new WorkspaceStore(root).read(b.bindingId);
  expect(reload.cases.map((c) => c.hasExpectedOutput)).toEqual([true, false]);
  expect(reload.cases[0].input).toBe("\t \n\n");
});
it("rejects stale revisions and serializes concurrent saves", async () => {
  const b = await store.import(problem);
  const results = await Promise.allSettled([
    store.saveCases(b.bindingId, b.revision, [...b.cases, newCase()]),
    store.saveCases(b.bindingId, b.revision, []),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await store.read(b.bindingId)).cases).toHaveLength(2);
});
it("does not resurrect deleted official samples", async () => {
  let b = await store.import(problem);
  b = await store.saveCases(b.bindingId, b.revision, []);
  b = await store.sync(b, problem);
  expect(b.cases).toEqual([]);
  expect(b.tombstones).toContain("sample-1");
});
it("rejects traversal and symlink escapes", async () => {
  await expect(safePath(root, "../escape")).rejects.toThrow();
  await fs.symlink(os.tmpdir(), path.join(root, "link"));
  await expect(safePath(root, "link/out")).rejects.toThrow();
});
it("preserves unknown schema without overwriting it", async () => {
  const b = await store.import(problem);
  const f = path.join(root, ".better-accoding/bindings", b.bindingId + ".json");
  const original = JSON.stringify({ ...b, schemaVersion: 99 });
  await fs.writeFile(f, original);
  await expect(store.import(problem)).rejects.toThrow();
  expect(await fs.readFile(f, "utf8")).toBe(original);
});

it("keeps custom ordering and original metadata across edits and sync", async () => {
  let b = await store.import(problem);
  const original = b.cases[0];
  const custom = {
    ...newCase(),
    name: "Custom",
    input: "  9\n",
    expected: "",
    hasExpectedOutput: false,
  };
  b = await store.saveCases(b.bindingId, b.revision, [
    custom,
    { ...original, input: "changed" },
  ]);
  b = await store.sync(b, problem);
  expect(b.cases.map((c) => c.name)).toEqual(["Custom", "样例 1"]);
  expect(b.cases[1].locallyModified).toBe(true);
  expect(b.cases[0].hasExpectedOutput).toBe(false);
});
