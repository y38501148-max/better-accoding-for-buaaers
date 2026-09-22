import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, type TestCase, type Comparison } from "../model";
import { runProcess, type ProcessResult } from "./process";
export function compare(actual: string, expected: string, mode: Comparison) {
  const normalize = (s: string) => {
    s = s.replace(/\r\n/g, "\n");
    if (mode === "trim-line-end")
      return s
        .split("\n")
        .map((l) => l.replace(/[ \t]+$/, ""))
        .join("\n");
    if (mode === "tokens") return s.match(/\S+/g)?.join("\n") ?? "";
    return s;
  };
  const a = normalize(actual),
    b = normalize(expected);
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return {
    equal: a === b,
    line: a.slice(0, index).split("\n").length,
    actual: visible(a.slice(index, index + 80)),
    expected: visible(b.slice(index, index + 80)),
  };
}
function visible(text: string) {
  return (
    text.replace(/ /g, "·").replace(/\t/g, "→").replace(/\n/g, "↵\n") ||
    "〈末尾〉"
  );
}
export interface Toolchain {
  c: string;
  cpp: string;
  cArgs: string[];
  cppArgs: string[];
  timeoutMs: number;
  outputLimit: number;
}
export interface CaseResult extends ProcessResult {
  contentHash: string;
  id: string;
  revision: number;
  status:
    | "PASS"
    | "FAIL"
    | "RE"
    | "TIMEOUT"
    | "CANCELLED"
    | "OUTPUT_LIMIT"
    | "UNCHECKED";
  diff?: ReturnType<typeof compare>;
}
export interface JudgeResult {
  runId: string;
  sourceHash: string;
  toolchainConfigHash: string;
  compilation: ProcessResult;
  cases: CaseResult[];
  directory: string;
}
export async function compile(
  source: string,
  storage: string,
  toolchain: Toolchain,
  signal?: AbortSignal,
  debug = false,
) {
  const ext = path.extname(source).toLowerCase();
  if (![".c", ".cpp", ".cc", ".cxx"].includes(ext))
    throw new Error("本地评测仅支持 C/C++ 文件。");
  const directory = path.join(storage, randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const code = await fs.readFile(source, "utf8");
  const snapshot = path.join(directory, `main${ext}`);
  await fs.writeFile(snapshot, code);
  const program = path.join(
    directory,
    process.platform === "win32" ? "program.exe" : "program",
  );
  const isC = ext === ".c";
  // Compile immutable bytes while preserving relative quoted includes and original diagnostics.
  const mapped = code.replace(
    /^/,
    "#line 1 " + JSON.stringify(source.replace(/\\/g, "/")) + "\n",
  );
  await fs.writeFile(snapshot, mapped);
  const flags = isC ? toolchain.cArgs : toolchain.cppArgs;
  const artifactArgument = (file: string) => {
    const relative = path.relative(path.dirname(source), file);
    return path.isAbsolute(relative) ? relative : `.${path.sep}${relative}`;
  };
  const args = [
    ...flags,
    ...(debug ? ["-g", "-O0"] : []),
    "-iquote",
    ".",
    artifactArgument(snapshot),
    "-o",
    artifactArgument(program),
  ];
  const configuredCompiler = isC ? toolchain.c : toolchain.cpp;
  const compiler =
    configuredCompiler.includes("/") || configuredCompiler.includes("\\")
      ? path.resolve(path.dirname(source), configuredCompiler)
      : configuredCompiler;
  // MinGW linkers may decode absolute Unicode paths through the system code page.
  // Relative artifact paths avoid repeating Unicode ancestors while retaining
  // the source directory as cwd for user-supplied include/library arguments.
  const result = await runProcess(compiler, args, {
    cwd: path.dirname(source),
    timeoutMs: 30000,
    outputLimit: toolchain.outputLimit,
    signal,
  });
  return { result, program, directory, sourceHash: hash(code) };
}
export async function judge(
  source: string,
  storage: string,
  cases: TestCase[],
  toolchain: Toolchain,
  signal?: AbortSignal,
): Promise<JudgeResult> {
  const snapshot = structuredClone(cases.filter((c) => c.enabled));
  const built = await compile(source, storage, toolchain, signal);
  const output: JudgeResult = {
    runId: path.basename(built.directory),
    sourceHash: built.sourceHash,
    toolchainConfigHash: hash(JSON.stringify(toolchain)),
    compilation: built.result,
    cases: [],
    directory: built.directory,
  };
  if (built.result.exitCode !== 0 || built.result.reason) return output;
  for (const c of snapshot) {
    const result = await runProcess(built.program, [], {
      cwd: path.dirname(source),
      input: c.input,
      timeoutMs: toolchain.timeoutMs,
      outputLimit: toolchain.outputLimit,
      signal,
    });
    const diff = c.hasExpectedOutput
      ? compare(result.stdout, c.expected, c.comparison)
      : undefined;
    const status =
      result.reason ??
      (result.exitCode !== 0
        ? "RE"
        : !diff
          ? "UNCHECKED"
          : diff.equal
            ? "PASS"
            : "FAIL");
    output.cases.push({
      ...result,
      id: c.id,
      revision: c.revision,
      contentHash: hash(
        JSON.stringify([
          c.input,
          c.expected,
          c.hasExpectedOutput,
          c.comparison,
        ]),
      ),
      status,
      diff,
    });
    if (status === "CANCELLED") break;
  }
  return output;
}
