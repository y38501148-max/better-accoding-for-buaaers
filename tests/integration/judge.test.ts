import { it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { judge, type Toolchain } from "../../src/judge/judge";
import { runProcess } from "../../src/judge/process";
import { newCase } from "../../src/workspace/store";
let dir: string;
const tc: Toolchain = {
  c: process.platform === "darwin" ? "clang" : "gcc",
  cpp: process.platform === "darwin" ? "clang++" : "g++",
  cArgs: ["-std=c99"],
  cppArgs: ["-std=c++17"],
  timeoutMs: 500,
  outputLimit: 4096,
};
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "评测 空格-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
it("compiles immutable C snapshot and closes stdin for EOF", async () => {
  const source = path.join(dir, "-main.c");
  await fs.writeFile(
    source,
    '#include <stdio.h>\nint main(){int n,s=0;while(scanf("%d",&n)==1)s+=n;printf("%d\\n",s);}',
  );
  const c = { ...newCase(), input: "1 2 3", expected: "6\n" };
  const r = await judge(source, dir, [c], tc);
  expect(r.compilation.exitCode).toBe(0);
  expect(r.cases[0].status).toBe("PASS");
});
it("compiles C++ and distinguishes unchecked from expected empty", async () => {
  const source = path.join(dir, "main.cpp");
  await fs.writeFile(
    source,
    '#include <iostream>\nint main(){std::cout<<"x";}',
  );
  const r = await judge(
    source,
    dir,
    [{ ...newCase(), hasExpectedOutput: false }, newCase()],
    tc,
  );
  expect(r.cases.map((x) => x.status)).toEqual(["UNCHECKED", "FAIL"]);
});
it("returns compile errors without running", async () => {
  const source = path.join(dir, "broken.c");
  await fs.writeFile(source, "int main( {");
  const r = await judge(source, dir, [newCase()], tc);
  expect(r.compilation.exitCode).not.toBe(0);
  expect(r.cases).toEqual([]);
});
it("terminates timeout, output floods and cancellation", async () => {
  const common = { cwd: dir, timeoutMs: 100, outputLimit: 1024 };
  expect(
    (
      await runProcess(
        process.execPath,
        ["-e", "setInterval(()=>{},1)"],
        common,
      )
    ).reason,
  ).toBe("TIMEOUT");
  const flood = await runProcess(
    process.execPath,
    ["-e", 'while(true)process.stdout.write("x".repeat(2048))'],
    { ...common, timeoutMs: 2000 },
  );
  expect(flood.reason).toBe("OUTPUT_LIMIT");
  expect(flood.stdout.length).toBeLessThanOrEqual(1024);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  expect(
    (
      await runProcess(process.execPath, ["-e", "setInterval(()=>{},1)"], {
        ...common,
        timeoutMs: 2000,
        signal: ac.signal,
      })
    ).reason,
  ).toBe("CANCELLED");
});
it("cleans up child process inherited pipes after parent exit", async () => {
  const r = await runProcess(
    process.execPath,
    [
      "-e",
      `require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});setTimeout(()=>process.exit(0),80);`,
    ],
    { cwd: dir, timeoutMs: 2000, outputLimit: 1024 },
  );
  expect(r.elapsedMs).toBeLessThan(1500);
});
it("reports nonzero exits and missing executable", async () => {
  const r = await runProcess(process.execPath, ["-e", "process.exit(3)"], {
    cwd: dir,
    timeoutMs: 2000,
    outputLimit: 1024,
  });
  expect(r.exitCode).toBe(3);
  await expect(
    runProcess("nonexistent-better-accoding-compiler", [], {
      cwd: dir,
      timeoutMs: 1000,
      outputLimit: 1024,
    }),
  ).rejects.toThrow("无法启动");
});
