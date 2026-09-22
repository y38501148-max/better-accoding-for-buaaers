import {
  bindingId,
  type Binding,
  type ContestSnapshot,
  type Problem,
} from "../model";
import { validateContestSnapshot } from "./index";
import { WorkspaceStore } from "./store";

/** Reconcile only a successfully fetched full roster; request failures never reach here. */
export async function syncContest(
  workspace: WorkspaceStore,
  snapshot: ContestSnapshot,
  prepare: (problem: Problem) => Promise<Problem> = async (p) => p,
  onlyBindingId?: string,
): Promise<Binding[]> {
  snapshot = validateContestSnapshot(snapshot);
  const previous = await workspace.contestRoster(snapshot.id);
  const bindings = (await workspace.list()).filter(
    (b) =>
      b.problem.target.kind === "contest" &&
      b.problem.target.contestId === snapshot.id,
  );
  if (onlyBindingId && !bindings.some((b) => b.bindingId === onlyBindingId))
    throw Error("当前题目不属于此比赛。");
  const known = new Set(
    previous?.problems.map((p) => p.id) ??
      bindings.map((b) => b.problem.target.problemId),
  );
  const remote = new Map(
    snapshot.problems.map((p) => [bindingId(p.target), p]),
  );
  const local = new Set(bindings.map((b) => b.bindingId));
  const updated: Binding[] = [];
  for (const b of bindings) {
    if (onlyBindingId && b.bindingId !== onlyBindingId) continue;
    const p = remote.get(b.bindingId);
    updated.push(
      p
        ? await workspace.sync(b, await prepare(p))
        : await workspace.markRemoved(b),
    );
  }
  if (!onlyBindingId) {
    for (const p of snapshot.problems) {
      if (!local.has(bindingId(p.target)) && !known.has(p.target.problemId))
        updated.push(await workspace.import(await prepare(p)));
    }
    // Commit the roster last. A partial run can be retried without losing new IDs.
    await workspace.recordContest(snapshot);
  }
  return updated;
}
