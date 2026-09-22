import { it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { WorkspaceStore, newCase, safePath } from "../../src/workspace/store";
import { problem } from "../fixtures/synthetic";
import * as disk from "../../src/workspace/fs";
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

it("undo after a persisted deletion restores the official identity and clears its tombstone", async () => {
  let b = await store.import(problem);
  const original = structuredClone(b.cases[0]);
  b = await store.saveCases(b.bindingId, b.revision, []);
  b = await new WorkspaceStore(root).read(b.bindingId);
  b = await store.saveCases(b.bindingId, b.revision, [original]);
  expect(b.cases[0].source).toBe("sample");
  expect(b.cases[0].baseline).toEqual(original.baseline);
  expect(b.tombstones).not.toContain("sample-1");
  b = await store.sync(b, {
    ...problem,
    samples: [{ key: "sample-1", input: "new official\n", expected: "4\n" }],
  });
  expect(b.cases).toHaveLength(1);
  expect(b.cases[0].input).toBe("new official\n");
});

it("stores independently editable input/output files and original baselines", async () => {
  let b = await store.import(problem);
  expect(
    await fs.readFile(path.join(root, b.cases[0].inputFile!), "utf8"),
  ).toBe("1 2\n");
  expect(
    await fs.readFile(
      path.join(root, "problems/0/tests/originals", b.cases[0].id + ".in"),
      "utf8",
    ),
  ).toBe("1 2\n");
  b = await store.saveCases(b.bindingId, b.revision, [
    { ...newCase(), hasExpectedOutput: false },
    { ...newCase(), expected: "" },
  ]);
  expect(b.cases[0].expectedOutputFile).toBeUndefined();
  expect(
    await fs.readFile(path.join(root, b.cases[1].expectedOutputFile!), "utf8"),
  ).toBe("");
});
it("imports external bytes with a new revision and rejects a late Webview draft", async () => {
  const b = await store.import(problem);
  await fs.writeFile(
    path.join(root, b.cases[0].inputFile!),
    "external\n\t  \n",
  );
  await expect(
    store.saveCases(b.bindingId, b.revision, [
      { ...b.cases[0], input: "late draft" },
    ]),
  ).rejects.toThrow("其他窗口或外部编辑");
  const latest = await new WorkspaceStore(root).read(b.bindingId);
  expect(latest.cases[0].input).toBe("external\n\t  \n");
  expect(latest.cases[0].revision).toBe(b.cases[0].revision + 1);
  expect(latest.cases[0].locallyModified).toBe(true);
});
it("coordinates independent store instances instead of losing a concurrent write", async () => {
  const b = await store.import(problem);
  const other = new WorkspaceStore(root);
  await other.read(b.bindingId);
  const settled = await Promise.allSettled([
    store.saveCases(b.bindingId, b.revision, [...b.cases, newCase("one")]),
    other.saveCases(b.bindingId, b.revision, [...b.cases, newCase("two")]),
  ]);
  expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect((await store.read(b.bindingId)).cases).toHaveLength(2);
});
it("backs up the old embedded format before migrating and never overwrites unrelated files", async () => {
  const b = await store.import(problem);
  delete b.fileHashes;
  for (const c of b.cases) {
    delete c.inputFile;
    delete c.expectedOutputFile;
  }
  const file = path.join(
    root,
    ".better-accoding/bindings",
    b.bindingId + ".json",
  );
  const original = JSON.stringify(b);
  await fs.writeFile(file, original);
  await fs.rm(path.join(root, "problems/0/tests"), { recursive: true });
  const migrated = await new WorkspaceStore(root).read(b.bindingId);
  expect(migrated.cases[0].inputFile).toBeTruthy();
  const backups = await fs.readdir(path.join(root, ".better-accoding/backups"));
  expect(
    await fs.readFile(
      path.join(root, ".better-accoding/backups", backups[0]),
      "utf8",
    ),
  ).toBe(original);
});
it("rejects same-revision metadata edits rather than overwriting external changes", async () => {
  const b = await store.import(problem);
  const file = path.join(
    root,
    ".better-accoding/bindings",
    b.bindingId + ".json",
  );
  await fs.writeFile(
    file,
    JSON.stringify({ ...b, sourceFile: "problems/0/renamed.c" }),
  );
  await expect(
    store.saveCases(b.bindingId, b.revision, b.cases),
  ).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(file, "utf8")).sourceFile).toBe(
    "problems/0/renamed.c",
  );
});

async function interruptCommit(
  binding: Awaited<ReturnType<WorkspaceStore["import"]>>,
) {
  const metadata = path.join(
    root,
    ".better-accoding/bindings",
    binding.bindingId + ".json",
  );
  const originalWrite = disk.atomicWrite;
  const rename = vi
    .spyOn(disk, "atomicWrite")
    .mockImplementation(async (destination, content) => {
      if (destination === metadata)
        throw Object.assign(
          new Error("simulated interrupted metadata commit"),
          { code: "EIO" },
        );
      return originalWrite(destination, content);
    });
  try {
    await expect(
      store.saveCases(binding.bindingId, binding.revision, [
        { ...binding.cases[0], input: "new input\n", expected: "new output\n" },
      ]),
    ).rejects.toThrow("simulated interrupted");
  } finally {
    rename.mockRestore();
  }
  return {
    metadata,
    journal: path.join(
      root,
      ".better-accoding/transactions",
      binding.bindingId + ".json",
    ),
  };
}
it("recovers an interrupted multi-file save before exposing the new revision", async () => {
  const b = await store.import(problem);
  const { journal } = await interruptCommit(b);
  const restored = await new WorkspaceStore(root).read(b.bindingId);
  expect(restored.revision).toBe(b.revision + 1);
  expect(
    await fs.readFile(
      path.join(root, restored.cases[0].expectedOutputFile!),
      "utf8",
    ),
  ).toBe("new output\n");
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, "problems/0/tests/tests.json"), "utf8"),
  );
  expect(metadata.revision).toBe(restored.revision);
  await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves an external edit that conflicts with crash recovery", async () => {
  const b = await store.import(problem);
  const before = await fs.readFile(
    path.join(root, ".better-accoding/bindings", b.bindingId + ".json"),
    "utf8",
  );
  const { metadata, journal } = await interruptCommit(b);
  await fs.writeFile(
    path.join(root, b.cases[0].inputFile!),
    "new external text",
  );
  await expect(new WorkspaceStore(root).read(b.bindingId)).rejects.toThrow(
    "恢复事务时发现外部编辑",
  );
  expect(await fs.readFile(metadata, "utf8")).toBe(before);
  expect(
    await fs.readFile(path.join(root, b.cases[0].inputFile!), "utf8"),
  ).toBe("new external text");
  expect(await fs.readFile(journal, "utf8")).toContain("new input");
});

it("reclaims a lock left by a process that has actually exited", async () => {
  const b = await store.import(problem);
  const lock = path.join(root, ".better-accoding/write.lock");
  execFileSync(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const lock=process.argv[1];fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),token:require('node:crypto').randomUUID()}));`,
      lock,
    ],
    { timeout: 5000 },
  );
  const loaded = await new WorkspaceStore(root).read(b.bindingId);
  expect(loaded.cases[0].input).toBe(b.cases[0].input);
  await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
});
