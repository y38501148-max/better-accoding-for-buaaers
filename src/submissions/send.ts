import { AccodingClient, ApiError } from "../accoding/client";
import {
  ContestAdapter,
  ProblemsetAdapter,
  contestHasEnded,
  contestHasNotStarted,
  type Submission,
} from "../accoding/adapters";
import type { Problem, Target } from "../model";

class Cancelled extends Error {}
const denied = (e: unknown) =>
  e instanceof ApiError && ["auth", "forbidden"].includes(e.kind);

/** Each alternative is prepared before sending. A started POST is never retried. */
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
  let sent = false,
    fallbackStarted = false;
  async function language(problem: Problem) {
    const selected = await hooks.language(
      problem,
      original.kind === "contest" && problem.target.kind === "problemset",
    );
    if (!selected) throw new Cancelled();
    if (!problem.languages.includes(selected))
      throw new ApiError("protocol", "提交语言已失效，请重新选择。");
    return selected;
  }
  async function sending(target: Target, lang: string) {
    await hooks.sending(target, lang);
    sent = true;
  }
  async function standalone(admin: boolean): Promise<Submission> {
    const connection = admin
      ? client.adminSubmitter(original.problemId)
      : client;
    const adapter = new ProblemsetAdapter(connection);
    const problem = await adapter.fetch(original.problemId);
    if (problem.target.kind !== "problemset") throw Error("题库来源异常。");
    const lang = await language(problem);
    return adapter.submit(problem.target, code, lang, () =>
      sending(problem.target, lang),
    );
  }
  async function fallback(): Promise<Submission> {
    fallbackStarted = true;
    try {
      return await standalone(true);
    } catch (e) {
      // Only an unavailable admin preflight can advance to the student form.
      // Protocol drift and transport failures are not evidence of missing access.
      if (sent || !denied(e)) throw e;
      return standalone(false);
    }
  }
  try {
    if (original.kind === "problemset")
      return await standalone(original.service === "admin");
    const contest = new ContestAdapter(client);
    try {
      const snapshot = await contest.snapshot(original.contestId);
      const problem = snapshot.problems.find(
        (p) => p.target.problemId === original.problemId,
      );
      // A hidden pre-contest roster is not evidence that the problem was removed.
      if (
        !problem ||
        problem.target.kind !== "contest" ||
        contestHasEnded(snapshot) ||
        contestHasNotStarted(snapshot)
      )
        return await fallback();
      const lang = await language(problem);
      return await contest.submit(
        problem.target,
        code,
        lang,
        () => sending(problem.target, lang),
        fallback,
      );
    } catch (e) {
      if (sent || fallbackStarted || !denied(e)) throw e;
      return await fallback();
    }
  } catch (e) {
    if (e instanceof Cancelled) return undefined;
    throw e;
  }
}
