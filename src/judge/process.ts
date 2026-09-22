import { spawn } from "node:child_process";
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  reason?: "TIMEOUT" | "CANCELLED" | "OUTPUT_LIMIT";
}
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    timeoutMs: number;
    outputLimit: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        reason: "CANCELLED",
      });
      return;
    }
    const start = performance.now();
    let reason: ProcessResult["reason"];
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      }
    };
    const stop = (r: ProcessResult["reason"]) => {
      if (!reason) reason = r;
      kill();
    };
    const timer = setTimeout(() => stop("TIMEOUT"), options.timeoutMs);
    const cancel = () => stop("CANCELLED");
    options.signal?.addEventListener("abort", cancel, { once: true });
    const collect = (data: Buffer, isErr: boolean) => {
      const remaining = Math.max(
        0,
        options.outputLimit - stdout.length - stderr.length,
      );
      const part = data.subarray(0, remaining);
      if (isErr) stderr = Buffer.concat([stderr, part]);
      else stdout = Buffer.concat([stdout, part]);
      if (data.length > remaining) stop("OUTPUT_LIMIT");
    };
    child.stdout.on("data", (b: Buffer) => collect(b, false));
    child.stderr.on("data", (b: Buffer) => collect(b, true));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    };
    child.on("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`无法启动 ${command}，请检查工具链配置。`));
    });
    // Killing the group when the leader exits also closes inherited pipes of descendants.
    child.on("exit", kill);
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode,
        signal,
        elapsedMs: Math.round(performance.now() - start),
        reason,
      });
    });
  });
}
