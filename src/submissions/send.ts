import { AccodingClient, ApiError } from "../accoding/client";
import {
  ContestAdapter,
  ProblemsetAdapter,
  contestHasEnded,
  type Submission,
} from "../accoding/adapters";
import type { Problem, Target } from "../model";

class Cancelled extends Error {}

/** Resolve a fresh destination before any POST. Never retry after sending. */
export async function sendSubmission(
  client: AccodingClient,
  original: Target,
  code: string,
  hooks: {
    language: (
      problem: Problem,
      fallback: boolean,
    ) => Promise<string | undefined>;
    sending: (target: Target, language: string) => Promise<void>;
  },
): Promise<Submission | undefined> {
  const problemset = new ProblemsetAdapter(client);
  async function language(problem: Problem, fallback: boolean) {
    const selected = await hooks.language(problem, fallback);
    if (!selected) throw new Cancelled();
    if (!problem.languages.includes(selected))
      throw new ApiError("protocol", "提交语言已失效，请重新选择。");
    return selected;
  }
  async function standalone() {
    // Actual public form access is required; contest/admin permission is insufficient.
    const problem = await problemset.fetch(original.problemId);
    const target = {
      kind: "problemset" as const,
      problemId: original.problemId,
    };
    const lang = await language(problem, original.kind === "contest");
    return problemset.submit(target, code, lang, () =>
      hooks.sending(target, lang),
    );
  }
  try {
    if (original.kind === "problemset") return await standalone();
    const contest = new ContestAdapter(client);
    const snapshot = await contest.snapshot(original.contestId);
    const problem = snapshot.problems.find(
      (p) => p.target.problemId === original.problemId,
    );
    if (!problem || problem.target.kind !== "contest")
      throw new ApiError("forbidden", "当前比赛已不包含此题，请同步后确认。");
    if (contestHasEnded(snapshot)) return await standalone();
    const lang = await language(problem, false);
    // Rechecking inside the adapter also covers a contest ending during language selection.
    return await contest.submit(
      problem.target,
      code,
      lang,
      () => hooks.sending(problem.target, lang),
      standalone,
    );
  } catch (e) {
    if (e instanceof Cancelled) return undefined;
    throw e;
  }
}
