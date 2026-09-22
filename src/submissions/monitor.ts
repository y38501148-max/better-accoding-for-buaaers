import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "../accoding/client";
import { bindingId } from "../model";
import type { Submission } from "../accoding/adapters";
import { isPending } from "./store";

/** Query known IDs only. Abort also suppresses a response already in flight. */
export async function monitorSubmissions(options: {
  submissions: Submission[];
  signal: AbortSignal;
  get: (submission: Submission) => Promise<Submission>;
  update: (submission: Submission) => Promise<void>;
  retry?: (error: Error) => Promise<void>;
  intervalMs?: number;
  budgetMs?: number;
}): Promise<"complete" | "stopped" | "waiting"> {
  const pending = new Map(
    options.submissions
      .filter(isPending)
      .map((s) => [`${bindingId(s.target)}:${s.id}`, s]),
  );
  const failures = new Map<string, number>();
  const started = Date.now();
  let interval = options.intervalMs ?? 2000;
  while (
    pending.size &&
    !options.signal.aborted &&
    Date.now() - started < (options.budgetMs ?? 600000)
  ) {
    for (const [id, s] of pending) {
      if (options.signal.aborted) return "stopped";
      let updated: Submission;
      try {
        updated = await options.get(s);
        failures.delete(id);
      } catch (e) {
        if (options.signal.aborted) return "stopped";
        const count = (failures.get(id) ?? 0) + 1;
        if (
          !(e instanceof ApiError) ||
          ["auth", "forbidden"].includes(e.kind) ||
          count > 5
        )
          throw e;
        failures.set(id, count);
        await options.retry?.(e);
        continue;
      }
      if (options.signal.aborted) return "stopped";
      await options.update(updated);
      if (isPending(updated)) pending.set(id, updated);
      else pending.delete(id);
    }
    if (!pending.size) return "complete";
    try {
      await sleep(interval, undefined, { signal: options.signal });
    } catch (e) {
      if (options.signal.aborted) return "stopped";
      throw e;
    }
    interval = Math.min(3000, interval + 1000);
  }
  return options.signal.aborted
    ? "stopped"
    : pending.size
      ? "waiting"
      : "complete";
}
