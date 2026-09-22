import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/** Coordinate writers from independent VS Code windows without stealing a live lock. */
export async function withWorkspaceLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(directory);
      try {
        await fs.writeFile(
          path.join(directory, "owner.json"),
          JSON.stringify({ pid: process.pid, host: os.hostname(), token }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid: number; host: string; token: string } | undefined;
      try {
        owner = JSON.parse(
          await fs.readFile(path.join(directory, "owner.json"), "utf8"),
        );
      } catch {
        /* A writer may still be creating its ownership record. */
      }
      if (
        owner &&
        owner.host === os.hostname() &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0
      ) {
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === "ESRCH";
        }
        if (dead) {
          const reclaimFile = path.join(directory, "reclaim");
          try {
            await fs.writeFile(reclaimFile, token, { flag: "wx" });
          } catch (e) {
            if (
              !["EEXIST", "ENOENT"].includes(
                (e as NodeJS.ErrnoException).code ?? "",
              )
            )
              throw e;
            if (Date.now() - started > 5000)
              throw new Error("中断的写入锁正在恢复；请保留文件并稍后重试。");
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          const current = JSON.parse(
            await fs.readFile(path.join(directory, "owner.json"), "utf8"),
          );
          if (current.token !== owner.token) {
            await fs.rm(reclaimFile, { force: true });
            continue;
          }
          // The exclusive reclaim marker prevents another contender from replacing
          // this dead owner before the directory is renamed.
          const reclaimed = `${directory}.abandoned-${token}`;
          await fs.rename(directory, reclaimed);
          await fs.rm(reclaimed, { recursive: true, force: true });
          continue;
        }
      }
      if (Date.now() - started > 5000)
        throw new Error(
          "另一窗口正在写入工作区，或存在未确认的写入锁。草稿已保留，请关闭占用窗口后重试。",
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    const owner = JSON.parse(
      await fs.readFile(path.join(directory, "owner.json"), "utf8"),
    );
    if (owner.token === token)
      await fs.rm(directory, { recursive: true, force: true });
  }
}
