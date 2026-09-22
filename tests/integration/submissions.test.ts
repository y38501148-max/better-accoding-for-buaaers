import { it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SubmissionStore, isUncertain } from "../../src/submissions/store";
import { monitorSubmissions } from "../../src/submissions/monitor";
import { hash, type Target } from "../../src/model";
import type { Submission } from "../../src/accoding/adapters";
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-submissions-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
});
const target: Target = {
  kind: "contest",
  contestId: "7",
  problemId: "11",
  contestOrder: 0,
};
const snapshot = { target, language: "c", sourceHash: hash("synthetic code") };
const submission: Submission = {
  id: "99",
  target,
  result: "WT",
  creatorId: "5",
  problemId: "11",
};
it("rehydrates source-specific IDs, metadata and outcomes in a fresh store without resending", async () => {
  const store = new SubmissionStore(directory);
  const attempt = await store.begin("5", snapshot);
  await store.observe("5", submission, attempt.attemptId);
  const reopened = new SubmissionStore(directory);
  const records = await reopened.list("5", target);
  expect(records[0]).toMatchObject({
    ...snapshot,
    state: "Pending",
    submission,
  });
  const seen: string[] = [];
  await monitorSubmissions({
    submissions: records.flatMap((a) => (a.submission ? [a.submission] : [])),
    signal: new AbortController().signal,
    get: async (s) => {
      seen.push(s.id);
      expect(s.target).toEqual(target);
      return { ...s, result: "AC" };
    },
    update: (s) => reopened.observe("5", s),
  });
  expect(seen).toEqual(["99"]);
  expect((await new SubmissionStore(directory).list("5"))[0]).toMatchObject({
    state: "Final",
    submission: { result: "AC" },
  });
  expect(await store.list("6")).toEqual([]);
  expect(
    await store.list("5", { kind: "problemset", problemId: "11" }),
  ).toEqual([]);
});
it("keeps a sending record uncertain after interruption and requires explicit acknowledgement before retry", async () => {
  const store = new SubmissionStore(directory);
  const attempt = await store.begin("5", snapshot);
  const reopened = new SubmissionStore(directory);
  expect(isUncertain((await reopened.list("5"))[0])).toBe(true);
  await expect(reopened.begin("5", snapshot)).rejects.toThrow("不会自动重发");
  await reopened.uncertain("5", attempt.attemptId);
  const retry = await reopened.begin("5", snapshot, [attempt.attemptId]);
  expect(
    (await reopened.list("5")).filter(isUncertain).map((a) => a.attemptId),
  ).toEqual([retry.attemptId]);
  await reopened.observe("5", submission, retry.attemptId);
  await reopened.uncertain("5", retry.attemptId);
  expect((await reopened.list("5"))[1]).toMatchObject({
    state: "Pending",
    submission: { id: "99" },
  });
});
it("serializes independent windows so two concurrent requests cannot both begin an uncertain send", async () => {
  const stores = [
    new SubmissionStore(directory),
    new SubmissionStore(directory),
  ];
  const results = await Promise.allSettled(
    stores.map((s) => s.begin("5", snapshot)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await stores[0].list("5")).toHaveLength(1);
});
it("preserves completed results and rejects another account or source", async () => {
  const store = new SubmissionStore(directory),
    attempt = await store.begin("5", snapshot);
  await store.observe("5", { ...submission, result: "AC" }, attempt.attemptId);
  await store.observe("5", submission);
  expect((await store.list("5"))[0].submission?.result).toBe("AC");
  await expect(
    store.observe("5", { ...submission, creatorId: "6" }),
  ).rejects.toThrow("账号");
  await expect(
    store.observe(
      "5",
      { ...submission, target: { kind: "problemset", problemId: "11" } },
      attempt.attemptId,
    ),
  ).rejects.toThrow("来源");
});
it("migrates fragmented legacy logs without changing the original or merging distinct submissions", async () => {
  const file = path.join(directory, `${hash("5")}.json`);
  const legacy = JSON.stringify([
    {
      bindingId: "contest-7-11",
      state: "Draft",
      ...snapshot,
      createdAt: "2026-09-22T00:00:00Z",
    },
    { bindingId: "contest-7-11", state: "Sending" },
    { bindingId: "contest-7-11", state: "AcceptedByServer", submission },
    {
      bindingId: "contest-7-11",
      state: "Final",
      submission: { ...submission, result: "AC" },
    },
    {
      bindingId: "contest-7-11",
      state: "Final",
      submission: { ...submission, id: "98", result: "WA" },
    },
    { bindingId: "problem-11", state: "Sending" },
  ]);
  await fs.writeFile(file, legacy);
  const store = new SubmissionStore(directory),
    records = await store.list("5");
  expect(records).toHaveLength(3);
  expect(records[0]).toMatchObject({
    sourceHash: snapshot.sourceHash,
    submission: { id: "99", result: "AC" },
  });
  expect(records[1].submission?.id).toBe("98");
  expect(records[2].target).toEqual({ kind: "problemset", problemId: "11" });
  expect(isUncertain(records[2])).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe(legacy);
  expect(await new SubmissionStore(directory).list("5")).toEqual(records);
});
it("refuses a corrupt ledger without replacing it and prevents stale responses recreating cleared history", async () => {
  const store = new SubmissionStore(directory),
    file = path.join(directory, `${hash("5")}.v2.json`);
  await fs.writeFile(file, "broken ledger");
  await expect(store.begin("5", snapshot)).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("broken ledger");
  await store.clear();
  await store.observe("5", submission, undefined, () => false);
  expect(await store.list("5")).toEqual([]);
});
it("queries each unresolved ID and does not erase completed historical records", async () => {
  const store = new SubmissionStore(directory);
  for (const s of [
    submission,
    { ...submission, id: "100" },
    { ...submission, id: "98", result: "WA" },
  ])
    await store.observe("5", s);
  const seen: string[] = [];
  await monitorSubmissions({
    submissions: (await store.list("5")).map((a) => a.submission!),
    signal: new AbortController().signal,
    get: async (s) => {
      seen.push(s.id);
      return { ...s, result: "AC" };
    },
    update: (s) => store.observe("5", s),
  });
  expect(seen).toEqual(["99", "100"]);
  expect((await store.list("5")).map((a) => a.submission?.result)).toEqual([
    "AC",
    "AC",
    "WA",
  ]);
});
it("suppresses a response that arrives after cancellation or account switch", async () => {
  const abort = new AbortController();
  let finish: (s: Submission) => void = () => {};
  const response = new Promise<Submission>((resolve) => {
    finish = resolve;
  });
  const update = vi.fn(async () => {});
  const pending = monitorSubmissions({
    submissions: [submission],
    signal: abort.signal,
    get: () => response,
    update,
  });
  abort.abort();
  finish({ ...submission, result: "AC" });
  expect(await pending).toBe("stopped");
  expect(update).not.toHaveBeenCalled();
});
it("leaves WT pending when the query budget expires and can resume to a final result", async () => {
  vi.useFakeTimers();
  const update = vi.fn(async () => {});
  const options = {
    submissions: [submission],
    signal: new AbortController().signal,
    get: async () => submission,
    update,
    intervalMs: 1000,
    budgetMs: 1500,
  };
  const running = monitorSubmissions(options);
  await vi.advanceTimersByTimeAsync(3500);
  expect(await running).toBe("waiting");
  expect(update).toHaveBeenCalledWith(submission);
  expect(
    await monitorSubmissions({
      ...options,
      get: async () => ({ ...submission, result: "AC" }),
    }),
  ).toBe("complete");
});
it("merges a concurrent history refresh with the accepted POST without losing the source snapshot", async () => {
  const store = new SubmissionStore(directory),
    attempt = await store.begin("5", snapshot);
  await store.observe("5", { ...submission, result: "AC" });
  await store.observe("5", submission, attempt.attemptId);
  const records = await store.list("5");
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    attemptId: attempt.attemptId,
    sourceHash: snapshot.sourceHash,
    state: "Final",
    submission: { id: "99", result: "AC" },
  });
});

it("guards an uncertain contest attempt atomically before falling back to the problemset", async () => {
  const store = new SubmissionStore(directory);
  const first = await store.begin("5", snapshot);
  const fallback = {
    ...snapshot,
    target: { kind: "problemset" as const, problemId: "11" },
  };
  await expect(
    new SubmissionStore(directory).begin("5", fallback, [], [target]),
  ).rejects.toThrow("不会自动重发");
  const next = await store.begin("5", fallback, [first.attemptId], [target]);
  expect(next.target).toEqual(fallback.target);
  expect(
    (await store.list("5")).filter(isUncertain).map((a) => a.attemptId),
  ).toEqual([next.attemptId]);
});

it("preserves admin provenance on restart and polls equal IDs from different routes separately", async () => {
  const store = new SubmissionStore(directory);
  const adminTarget = {
    kind: "problemset" as const,
    problemId: "11",
    service: "admin" as const,
  };
  const admin = { ...submission, target: adminTarget };
  const attempt = await store.begin("5", { ...snapshot, target: adminTarget });
  await store.observe("5", admin, attempt.attemptId);
  const reloaded = await new SubmissionStore(directory).list("5", adminTarget);
  expect(reloaded[0].submission?.target).toEqual(adminTarget);
  expect(
    await store.list("5", { kind: "problemset", problemId: "11" }),
  ).toEqual([]);
  const queried: unknown[] = [];
  await monitorSubmissions({
    submissions: [submission, admin],
    signal: new AbortController().signal,
    get: async (s) => {
      queried.push(s.target);
      return { ...s, result: "AC" };
    },
    update: async () => {},
  });
  expect(queried).toEqual([target, adminTarget]);
  const pending = await store.begin("5", { ...snapshot, target: adminTarget });
  await expect(store.begin("5", snapshot, [], [adminTarget])).rejects.toThrow(
    "不会自动重发",
  );
  expect(pending.target).toEqual(adminTarget);
});
