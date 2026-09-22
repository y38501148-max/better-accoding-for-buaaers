import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, bindingId, targetSchema, type Target } from "../model";
import type { Submission } from "../accoding/adapters";
import { atomicWrite } from "../workspace/fs";
import { withWorkspaceLock } from "../workspace/lock";

const submissionSchema = z.object({
  id: z.string().regex(/^\d+$/),
  target: targetSchema,
  result: z.string(),
  problemId: z.string().optional(),
  creatorId: z.string().optional(),
  language: z.string().optional(),
  score: z.string().optional(),
  detail: z.string().optional(),
});
const attemptSchema = z.object({
  attemptId: z.string(),
  bindingId: z.string(),
  target: targetSchema,
  state: z.enum(["Sending", "UnknownOutcome", "Pending", "Final"]),
  language: z.string().optional(),
  sourceHash: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  submission: submissionSchema.optional(),
  retryAcknowledged: z.boolean().optional(),
});
export type SubmissionAttempt = z.infer<typeof attemptSchema>;
export const isPending = (s: Submission) => ["WT", "JG"].includes(s.result);
export const isUncertain = (a: SubmissionAttempt) =>
  !a.retryAcknowledged &&
  !a.submission &&
  ["Sending", "UnknownOutcome"].includes(a.state);

/** Account-private metadata only. Never stores source code, cookies or names. */
export class SubmissionStore {
  constructor(readonly directory: string) {}
  private locked<T>(action: () => Promise<T>) {
    return withWorkspaceLock(`${this.directory}.lock`, action);
  }
  private file(account: string) {
    return path.join(this.directory, `${hash(account)}.v2.json`);
  }
  private async read(account: string): Promise<SubmissionAttempt[]> {
    try {
      return z
        .object({ version: z.literal(2), attempts: z.array(attemptSchema) })
        .parse(JSON.parse(await fs.readFile(this.file(account), "utf8")))
        .attempts;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // The original append-only log remains untouched as a migration backup.
    let legacy: unknown;
    try {
      legacy = JSON.parse(
        await fs.readFile(
          path.join(this.directory, `${hash(account)}.json`),
          "utf8",
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const events = z
      .array(
        z.object({
          bindingId: z.string(),
          state: z.string(),
          target: targetSchema.optional(),
          language: z.string().optional(),
          sourceHash: z.string().optional(),
          createdAt: z.string().optional(),
          submission: submissionSchema.optional(),
        }),
      )
      .parse(legacy);
    const attempts: SubmissionAttempt[] = [];
    const drafts = new Map<string, Partial<SubmissionAttempt>>();
    for (const [index, event] of events.entries()) {
      if (event.state === "Draft") {
        drafts.set(event.bindingId, {
          target: event.target,
          language: event.language,
          sourceHash: event.sourceHash,
          createdAt: event.createdAt,
        });
        continue;
      }
      const draft = drafts.get(event.bindingId);
      const known =
        event.submission &&
        attempts.find(
          (a) =>
            a.bindingId === event.bindingId &&
            a.submission?.id === event.submission!.id,
        );
      const current =
        known ??
        [...attempts].reverse().find((a) => a.bindingId === event.bindingId);
      const match = event.bindingId.match(
        /^(?:problem-(\d+)|contest-(\d+)-(\d+))$/,
      );
      const target =
        event.submission?.target ??
        event.target ??
        draft?.target ??
        current?.target ??
        (match?.[1]
          ? { kind: "problemset" as const, problemId: match[1] }
          : match?.[2]
            ? {
                kind: "contest" as const,
                contestId: match[2],
                problemId: match[3],
                contestOrder: 0,
              }
            : undefined);
      if (!target || bindingId(target) !== event.bindingId)
        throw Error("旧提交记录来源异常，请保留文件后检查。");
      const time =
        event.createdAt ?? draft?.createdAt ?? current?.createdAt ?? "";
      let attempt = current;
      if (
        event.state === "Sending" ||
        !attempt ||
        (event.submission &&
          attempt.submission &&
          event.submission.id !== attempt.submission.id)
      ) {
        attempt = {
          attemptId: `legacy-${index}`,
          bindingId: event.bindingId,
          target,
          state: "Sending",
          createdAt: time,
          updatedAt: time,
          language: draft?.language,
          sourceHash: draft?.sourceHash,
        };
        attempts.push(attempt);
      }
      if (event.submission) {
        attempt.submission = event.submission;
        attempt.target = event.submission.target;
        attempt.state = isPending(event.submission) ? "Pending" : "Final";
      } else if (event.state === "UnknownOutcome" && !attempt.submission)
        attempt.state = "UnknownOutcome";
    }
    await this.write(account, attempts);
    return attempts;
  }
  private write(account: string, attempts: SubmissionAttempt[]) {
    return atomicWrite(
      this.file(account),
      JSON.stringify({ version: 2, attempts }),
    );
  }
  list(account: string, target?: Target) {
    return this.locked(async () =>
      (await this.read(account)).filter(
        (a) => !target || a.bindingId === bindingId(target),
      ),
    );
  }
  begin(
    account: string,
    snapshot: { target: Target; language: string; sourceHash: string },
    acknowledged: string[] = [],
    relatedTargets: Target[] = [],
  ): Promise<SubmissionAttempt> {
    return this.locked(async () => {
      const attempts = await this.read(account);
      const key = bindingId(snapshot.target);
      const guarded = new Set([key, ...relatedTargets.map(bindingId)]);
      if (
        attempts.some(
          (a) =>
            guarded.has(a.bindingId) &&
            isUncertain(a) &&
            !acknowledged.includes(a.attemptId),
        )
      )
        throw Error("存在尚未确认的提交，请先刷新记录核对。不会自动重发。");
      for (const a of attempts)
        if (guarded.has(a.bindingId) && acknowledged.includes(a.attemptId))
          a.retryAcknowledged = true;
      const time = new Date().toISOString();
      const attempt: SubmissionAttempt = {
        ...snapshot,
        attemptId: randomUUID(),
        bindingId: key,
        state: "Sending",
        createdAt: time,
        updatedAt: time,
      };
      attempts.push(attempt);
      await this.write(account, attempts);
      return attempt;
    });
  }
  uncertain(account: string, attemptId: string) {
    return this.locked(async () => {
      const attempts = await this.read(account),
        a = attempts.find((a) => a.attemptId === attemptId);
      if (!a) throw Error("提交记录已清理，无法更新。");
      if (!a.submission) a.state = "UnknownOutcome";
      a.updatedAt = new Date().toISOString();
      await this.write(account, attempts);
    });
  }
  observe(
    account: string,
    submission: Submission,
    attemptId?: string,
    shouldWrite: () => boolean = () => true,
  ) {
    return this.locked(async () => {
      if (!shouldWrite()) return;
      const attempts = await this.read(account),
        key = bindingId(submission.target);
      if (submission.creatorId && submission.creatorId !== account)
        throw Error("提交记录不属于当前账号。");
      let a = attemptId
        ? attempts.find((a) => a.attemptId === attemptId)
        : attempts.find(
            (a) => a.bindingId === key && a.submission?.id === submission.id,
          );
      if (attemptId && !a) throw Error("提交记录已清理，无法更新。");
      if (
        a &&
        (a.bindingId !== key ||
          (a.submission && a.submission.id !== submission.id))
      )
        throw Error("提交记录与来源不匹配。");
      if (!a) {
        a = {
          attemptId: randomUUID(),
          bindingId: key,
          target: submission.target,
          state: "Pending",
          createdAt: "",
          updatedAt: "",
        };
        attempts.push(a);
      }
      // A history refresh may discover the server ID before the POST handler
      // persists its response. Merge that row into the original source snapshot.
      const duplicate = attempts.find(
        (other) =>
          other !== a &&
          other.bindingId === key &&
          other.submission?.id === submission.id,
      );
      if (duplicate) {
        if (duplicate.state === "Final" && isPending(submission)) {
          a.submission = duplicate.submission;
          a.state = "Final";
        }
        attempts.splice(attempts.indexOf(duplicate), 1);
      }
      // An older in-flight WT response must not overwrite a completed record.
      if (a.state !== "Final" || !isPending(submission)) {
        a.submission = submission;
        a.target = submission.target;
        a.state = isPending(submission) ? "Pending" : "Final";
        a.updatedAt = new Date().toISOString();
      }
      await this.write(account, attempts);
    });
  }
  clear() {
    return this.locked(() =>
      fs.rm(this.directory, { recursive: true, force: true }),
    );
  }
}
