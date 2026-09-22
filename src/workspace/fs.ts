import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export class ConflictError extends Error {}
export async function atomicWrite(
  file: string,
  content: string | Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function safePath(
  root: string,
  relative: string,
): Promise<string> {
  const dest = path.resolve(root, relative),
    base = path.resolve(root);
  if (dest === base || !dest.startsWith(base + path.sep))
    throw new Error("拒绝工作区之外的路径。");
  let p = dest;
  for (;;) {
    try {
      const stat = await fs.lstat(p);
      if (stat.isSymbolicLink()) throw new Error("数据路径不能包含符号链接。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (p === base) break;
    p = path.dirname(p);
  }
  return dest;
}
