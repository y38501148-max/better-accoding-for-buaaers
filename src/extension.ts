import * as vscode from "vscode";
import { problemLabel, compareBindings } from "./problems/order";
import { cacheProblemImages } from "./problems/images";
import { imageLoader } from "./problems/image-fetch";
import {
  SubmissionStore,
  isUncertain,
  isPending,
  type SubmissionAttempt,
} from "./submissions/store";
import { sendSubmission } from "./submissions/send";
import { monitorSubmissions } from "./submissions/monitor";
import { fetchContestSnapshotForImport } from "./accoding/import";
import { syncContest } from "./workspace/contest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { CookieJar } from "tough-cookie";
import { AccodingClient, ApiError } from "./accoding/client";
import {
  login,
  currentUser,
  ContestAdapter,
  ProblemsetAdapter,
  type Submission,
} from "./accoding/adapters";
import {
  parseImport,
  caseSchema,
  hash,
  problemUrl,
  targetLabel,
  type Binding,
  type Session,
  type TestCase,
} from "./model";
import {
  WorkspaceStore,
  ConflictError,
  safePath,
  newCase,
} from "./workspace/store";
import {
  judge,
  compile,
  type Toolchain,
  type JudgeResult,
} from "./judge/judge";
import { runProcess } from "./judge/process";
import { Workbench } from "./views/panel";
const prefix = "betterAccoding.";
const commandNames = [
  "login",
  "logout",
  "importProblem",
  "importContest",
  "importFromUrl",
  "syncProblem",
  "syncContest",
  "openProblem",
  "restoreLayout",
  "selectProblem",
  "selectContestProblem",
  "bindFile",
  "addTestCase",
  "importTestCases",
  "duplicateTestCase",
  "deleteTestCase",
  "restoreOfficialSample",
  "judge",
  "runTestCase",
  "debugTestCase",
  "cancelRun",
  "selectSubmissionLanguage",
  "selectSubmissionTarget",
  "submit",
  "refreshSubmissions",
  "resumeSubmissions",
  "openOnWebsite",
  "checkEnvironment",
  "exportDiagnostics",
  "clearPrivateData",
] as const;
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("save"),
    root: z.string(),
    bindingId: z.string(),
    baseRevision: z.number().int().nonnegative(),
    requestId: z.string().uuid(),
    cases: z.array(caseSchema).max(500),
  }),
  z.object({
    type: z.literal("command"),
    command: z.enum([
      ...commandNames,
      "settings",
      "importMenu",
      "restoreDeletedSamples",
      "rerunFailed",
      "editInput",
      "editExpected",
      "useOutput",
    ]),
    root: z.string(),
    bindingId: z.string().optional(),
    caseId: z.string().optional(),
  }),
  z.object({
    type: z.literal("copyDraft"),
    text: z.string().max(8 * 1024 * 1024),
  }),
]);
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Better Accoding");
  const diagnostics =
    vscode.languages.createDiagnosticCollection("betterAccoding");
  let client = new AccodingClient();
  let user: Awaited<ReturnType<typeof currentUser>> | undefined;
  let active: Session | undefined;
  let runAbort: AbortController | undefined;
  let polling: AbortController | undefined;
  let submitting = false;
  let switching = false;
  const stores = new Map<string, WorkspaceStore>();
  const results = new Map<string, JudgeResult>();
  const deleted = new Map<string, TestCase[]>();
  const sessionKey = (s: Session) => `${s.root}:${s.binding.bindingId}`;
  const store = (root: string) => {
    let s = stores.get(root);
    if (!s) {
      s = new WorkspaceStore(root);
      stores.set(root, s);
    }
    return s;
  };
  const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const error = (e: unknown) => {
    const message =
      e instanceof z.ZodError
        ? "数据格式异常，请检查接口或工作区。"
        : e instanceof Error
          ? e.message
          : "操作失败。";
    void vscode.window.showErrorMessage(message);
    workbench.post({ type: "notice", text: message });
  };
  const workbench = new Workbench(
    context,
    (m) => void receive(m).catch(error),
    () => polling?.abort(),
  );
  const treeChange = new vscode.EventEmitter<void>();
  type Entry = { label: string; session?: Session; children?: Entry[] };
  const tree: vscode.TreeDataProvider<Entry> = {
    onDidChangeTreeData: treeChange.event,
    getTreeItem(entry) {
      const item = new vscode.TreeItem(
        entry.label,
        entry.children
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      if (entry.session)
        item.command = {
          command: prefix + "openProblem",
          title: "打开题目",
          arguments: [entry.session],
        };
      return item;
    },
    async getChildren(entry) {
      if (entry) return entry.children ?? [];
      const groups: Entry[] = [];
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        if (f.uri.scheme !== "file") continue;
        const bindings = await store(f.uri.fsPath).list();
        const map = new Map<string, Entry[]>();
        for (const b of bindings) {
          const key =
            b.problem.target.kind === "contest"
              ? `比赛 #${b.problem.target.contestId}`
              : "题库";
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push({
            label: `${problemLabel(b.problem)} · ${b.problem.title}${b.unavailable ? " [已移除]" : ""}`,
            session: { root: f.uri.fsPath, binding: b },
          });
        }
        if (!map.size) continue;
        groups.push({
          label: f.name,
          children: [...map].map(([label, children]) => ({
            label,
            children: children.sort((a, b) =>
              compareBindings(a.session!.binding, b.session!.binding),
            ),
          })),
        });
      }
      return groups;
    },
  };
  context.subscriptions.push(
    output,
    diagnostics,
    treeChange,
    vscode.window.registerTreeDataProvider("betterAccoding.problems", tree),
  );
  function trusted() {
    if (!vscode.workspace.isTrusted)
      throw new Error("请先信任工作区，再执行此操作。");
    if (vscode.env.remoteName)
      throw new Error("当前版本尚未验收远程工作区，请在本地 VS Code 使用。");
  }
  function requireActive(): Session {
    if (!active) throw new Error("请先导入或打开题目。");
    return active;
  }
  async function saveCaseDocuments(root: string, bindings: Binding[]) {
    const files = new Set(
      bindings
        .flatMap((b) => b.cases)
        .flatMap((c) =>
          [c.inputFile, c.expectedOutputFile].filter((x): x is string => !!x),
        )
        .map((file) => path.resolve(root, file)),
    );
    for (const document of vscode.workspace.textDocuments) {
      if (
        document.uri.scheme === "file" &&
        document.isDirty &&
        files.has(document.uri.fsPath) &&
        !(await document.save())
      )
        throw new Error("用例文件未能保存，已取消操作以保留草稿。");
    }
  }
  async function refreshActive() {
    const s = requireActive();
    await saveCaseDocuments(s.root, [s.binding]);
    s.binding = await store(s.root).read(s.binding.bindingId);
    return s;
  }
  async function chooseRoot() {
    const folders =
      vscode.workspace.workspaceFolders?.filter(
        (f) => f.uri.scheme === "file",
      ) ?? [];
    if (!folders.length) throw new Error("请先在 VS Code 中打开本地文件夹。");
    const chosen =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: "选择题目保存的工作区",
          });
    return chosen?.uri.fsPath;
  }
  function toolchain(): Toolchain {
    const c = vscode.workspace.getConfiguration("betterAccoding");
    return {
      c: c.get("compiler.c", process.platform === "darwin" ? "clang" : "gcc"),
      cpp: c.get(
        "compiler.cpp",
        process.platform === "darwin" ? "clang++" : "g++",
      ),
      cArgs: c.get("compiler.cArgs", ["-std=c99", "-Wall", "-Wextra", "-O2"]),
      cppArgs: c.get("compiler.cppArgs", [
        "-std=c++17",
        "-Wall",
        "-Wextra",
        "-O2",
      ]),
      timeoutMs: c.get("run.timeoutMs", 2000),
      outputLimit: c.get("run.outputLimit", 1048576),
    };
  }
  async function show(s: Session, restore = false) {
    if (switching) throw new Error("正在切换题目，请稍后。");
    switching = true;
    try {
      await workbench.flush();
      const binding = await store(s.root).read(s.binding.bindingId);
      const source = await safePath(s.root, binding.sourceFile);
      await workbench.open(vscode.Uri.file(source), restore);
      active = { root: s.root, binding };
      await vscode.commands.executeCommand(
        "setContext",
        "betterAccoding.hasActiveProblem",
        true,
      );
      polling?.abort();
      await workbench.show(binding, s.root);
      await restoreSubmissions(s);
      treeChange.fire();
      await context.workspaceState.update("lastBinding", {
        root: s.root,
        bindingId: binding.bindingId,
      });
    } finally {
      switching = false;
    }
  }
  async function saveSource(s: Session) {
    trusted();
    const source = await safePath(s.root, s.binding.sourceFile);
    const doc = await vscode.workspace.openTextDocument(source);
    if (!(await doc.save())) throw new Error("源码保存失败，操作已取消。");
    return source;
  }
  async function authenticate() {
    const username = await vscode.window.showInputBox({
      title: "登录 Accoding",
      prompt: "账号（邮箱），仅保存会话，不保存密码",
      ignoreFocusOut: true,
    });
    if (!username) return false;
    const password = await vscode.window.showInputBox({
      title: "登录 Accoding",
      prompt: "密码",
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return false;
    const candidate = await login(username, password);
    client.cancel();
    polling?.abort();
    client = candidate.client;
    user = candidate.user;
    await context.secrets.store(
      "accoding.session",
      JSON.stringify(await client.jar.serialize()),
    );
    workbench.post({
      type: "submissions",
      root: active?.root,
      bindingId: active?.binding.bindingId,
      submissions: [],
      uncertain: [],
      focus: false,
    });
    if (active) await restoreSubmissions(active);
    workbench.post({ type: "notice", text: "已登录 Accoding" });
    return true;
  }
  async function ensureUser() {
    try {
      user = await currentUser(client);
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind !== "auth") throw e;
      user = undefined;
      await context.secrets.delete("accoding.session");
      if (!(await authenticate())) throw new Error("登录已取消。");
    }
    await context.secrets.store(
      "accoding.session",
      JSON.stringify(await client.jar.serialize()),
    );
    return user!;
  }
  async function importItems(mode?: "problemset" | "contest") {
    trusted();
    const input = await vscode.window.showInputBox({
      title:
        mode === "contest"
          ? "导入比赛"
          : mode === "problemset"
            ? "按题号导入"
            : "粘贴 Accoding 题目或比赛链接",
      prompt: mode
        ? "输入 ID 或完整链接"
        : "输入完整链接；纯数字请从命令面板选择“按题号”或“按比赛”",
    });
    if (input === undefined) return;
    const target = parseImport(input, mode);
    const root = await chooseRoot();
    if (!root) return;
    const snapshot =
      target.kind === "contest"
        ? await fetchContestSnapshotForImport(client, target.id, (message) =>
            output.appendLine(message),
          )
        : undefined;
    const problems = snapshot?.problems ?? [
      await new ProblemsetAdapter(client).fetch(target.id),
    ];
    if (snapshot) await store(root).contestRoster(snapshot.id);
    const picked =
      target.kind === "problemset"
        ? problems
        : await vscode.window
            .showQuickPick(
              problems.map((problem) => ({
                label: `${problemLabel(problem)} · ${problem.title}`,
                picked: true,
                problem,
              })),
              { canPickMany: true, placeHolder: "选择要导入的题目" },
            )
            .then((items) => items?.map((i) => i.problem));
    if (!picked?.length) return;
    const loadImages = imageLoader(client);
    let first: Binding | undefined;
    for (const p of picked) {
      const b = await store(root).import(
        await cacheProblemImages(p, root, loadImages),
      );
      first ??= b;
    }
    if (snapshot) await store(root).recordContest(snapshot);
    treeChange.fire();
    if (first) await show({ root, binding: first });
  }
  async function selectProblem(currentContest = false) {
    const target = active?.binding.problem.target;
    const contestId =
      currentContest && target?.kind === "contest"
        ? target.contestId
        : undefined;
    const all: { label: string; description: string; session: Session }[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== "file") continue;
      if (contestId && f.uri.fsPath !== active!.root) continue;
      for (const b of (await store(f.uri.fsPath).list()).sort(
        compareBindings,
      )) {
        if (
          contestId &&
          (b.problem.target.kind !== "contest" ||
            b.problem.target.contestId !== contestId)
        )
          continue;
        all.push({
          label: `${problemLabel(b.problem)} · ${b.problem.title}${b.unavailable ? " [已移除]" : ""}`,
          description: `${f.name} · ${b.bindingId}`,
          session: { root: f.uri.fsPath, binding: b },
        });
      }
    }
    const choice = await vscode.window.showQuickPick(all, {
      placeHolder: contestId
        ? `比赛 #${contestId} · 按题序选择题目`
        : "选择题目（每种提交来源独立保存）",
    });
    if (choice) await show(choice.session);
  }
  async function updateCases(change: (cases: TestCase[]) => void) {
    await workbench.flush();
    const s = await refreshActive();
    const cases = structuredClone(s.binding.cases);
    change(cases);
    s.binding = await store(s.root).saveCases(
      s.binding.bindingId,
      s.binding.revision,
      cases,
    );
    await workbench.show(s.binding, s.root);
  }
  async function chooseCase(id?: string) {
    const s = requireActive();
    if (id) {
      const c = s.binding.cases.find((c) => c.id === id);
      if (!c) throw new Error("用例已不存在。");
      return c;
    }
    const item = await vscode.window.showQuickPick(
      s.binding.cases.map((c) => ({
        label: c.name,
        description: c.enabled ? "启用" : "禁用",
        c,
      })),
      { placeHolder: "选择用例" },
    );
    return item?.c;
  }
  async function run(caseId?: string, failed = false) {
    trusted();
    await workbench.flush();
    const s = await refreshActive();
    const source = await saveSource(s);
    if (runAbort) throw new Error("已有评测正在进行，请先停止。");
    let cases = s.binding.cases;
    if (caseId)
      cases = cases
        .filter((c) => c.id === caseId)
        .map((c) => ({ ...c, enabled: true }));
    if (failed) {
      const old = results.get(sessionKey(s));
      cases = cases.filter((c) =>
        old?.cases.some(
          (r) => r.id === c.id && !["PASS", "UNCHECKED"].includes(r.status),
        ),
      );
    }
    if (!cases.some((c) => c.enabled))
      throw new Error("没有启用的用例，请先添加或启用用例。");
    const abort = new AbortController();
    runAbort = abort;
    workbench.post({ type: "notice", text: "正在编译和运行…" });
    try {
      const r = await judge(
        source,
        path.join(storage, "builds"),
        cases,
        toolchain(),
        abort.signal,
      );
      results.set(sessionKey(s), r);
      workbench.post({
        type: "result",
        root: s.root,
        bindingId: s.binding.bindingId,
        result: r,
        sourceStale:
          hash(
            vscode.workspace.textDocuments
              .find((d) => d.uri.fsPath === source)
              ?.getText() ?? (await fs.readFile(source, "utf8")),
          ) !== r.sourceHash,
        configurationStale:
          hash(JSON.stringify(toolchain())) !== r.toolchainConfigHash,
      });
      const ds: vscode.Diagnostic[] = [];
      for (const line of r.compilation.stderr.split("\n")) {
        const m = line.match(/^(.+):(\d+):(\d+):\s*(error|warning):\s*(.*)$/);
        if (m && path.resolve(m[1]) === source)
          ds.push(
            new vscode.Diagnostic(
              new vscode.Range(
                Math.max(0, +m[2] - 1),
                Math.max(0, +m[3] - 1),
                Math.max(0, +m[2] - 1),
                +m[3],
              ),
              m[5],
              m[4] === "error"
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning,
            ),
          );
      }
      diagnostics.set(vscode.Uri.file(source), ds);
    } finally {
      if (runAbort === abort) runAbort = undefined;
    }
  }
  async function debug(caseId?: string) {
    trusted();
    await workbench.flush();
    const s = await refreshActive();
    const c = await chooseCase(caseId);
    if (!c) return;
    const extension =
      process.platform === "darwin"
        ? "vadimcn.vscode-lldb"
        : "ms-vscode.cpptools";
    if (!vscode.extensions.getExtension(extension)) {
      await vscode.commands.executeCommand(
        "workbench.extensions.search",
        extension,
      );
      throw new Error(`调试需要安装 ${extension}，安装后重试。`);
    }
    const source = await saveSource(s);
    const built = await compile(
      source,
      path.join(storage, "debug"),
      toolchain(),
      undefined,
      true,
    );
    if (built.result.exitCode !== 0)
      throw new Error(`调试编译失败：${built.result.stderr.slice(0, 4000)}`);
    const input = path.join(built.directory, "stdin.in");
    await fs.writeFile(input, c.input);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(source));
    const config: vscode.DebugConfiguration =
      process.platform === "darwin"
        ? {
            type: "lldb",
            request: "launch",
            name: `Accoding · ${c.name}`,
            program: built.program,
            cwd: path.dirname(source),
            stdio: [input, null, null],
            // This macOS backend needs explicit stdin redirection at process launch.
            processCreateCommands: [
              `process launch -i ${JSON.stringify(input)}`,
            ],
            terminal: "console",
            stopOnEntry: false,
          }
        : {
            type: "cppdbg",
            request: "launch",
            name: `Accoding · ${c.name}`,
            program: built.program,
            cwd: path.dirname(source),
            MIMode: "gdb",
            miDebuggerPath: vscode.workspace
              .getConfiguration("betterAccoding")
              .get("debug.gdb", "gdb"),
            externalConsole: false,
            setupCommands: [
              {
                text: `-interpreter-exec console "set args < ${input.replace(/\\/g, "/").replace(/"/g, '\\"')}"`,
              },
            ],
            stopAtEntry: false,
          };
    if (!(await vscode.debug.startDebugging(folder, config)))
      throw new Error("调试器未能启动，请查看调试控制台。");
  }
  async function chooseLanguage(
    s: Session,
    languages = s.binding.problem.languages,
  ) {
    const choice = await vscode.window.showQuickPick(languages, {
      placeHolder: "选择 OJ 实际支持的提交语言（本地编译标准单独设置）",
    });
    if (!choice) return false;
    s.binding = await store(s.root).update(
      s.binding.bindingId,
      s.binding.revision,
      (b) => {
        b.selectedSubmissionLanguage = choice;
      },
    );
    if (active === s) await workbench.show(s.binding, s.root);
    return true;
  }
  let submissionCacheGeneration = 0;
  const submissionStore = new SubmissionStore(
    path.join(context.globalStorageUri.fsPath, "submissions"),
  );
  function sameSubmissionContext(
    s: Session,
    account: string,
    connection = client,
  ) {
    return (
      client === connection &&
      user?.id === account &&
      !!active &&
      sessionKey(active) === sessionKey(s)
    );
  }
  async function submissionAttempts(s: Session, account: string) {
    const target = s.binding.problem.target;
    return (await submissionStore.list(account)).filter(
      (a) =>
        a.bindingId === s.binding.bindingId ||
        (target.kind === "contest" &&
          a.target.kind === "problemset" &&
          a.target.problemId === target.problemId),
    );
  }
  async function postSubmissions(
    s: Session,
    account: string,
    focus = false,
    status?: string,
    valid: () => boolean = () => true,
  ) {
    const connection = client;
    const generation = submissionCacheGeneration;
    const attempts = await submissionAttempts(s, account);
    if (
      !valid() ||
      generation !== submissionCacheGeneration ||
      !sameSubmissionContext(s, account, connection)
    )
      return;
    workbench.post({
      type: "submissions",
      root: s.root,
      bindingId: s.binding.bindingId,
      submissions: attempts
        .flatMap((a) => (a.submission ? [a.submission] : []))
        .reverse(),
      uncertain: attempts.filter(isUncertain).map((a) => ({
        createdAt: a.createdAt,
        language: a.language,
        target: a.target,
      })),
      focus,
      status,
    });
  }
  async function restoreSubmissions(s: Session, publish = true) {
    const account = user?.id;
    if (!account) return;
    if (publish) await postSubmissions(s, account);
    const attempts = await submissionAttempts(s, account);
    const pending = attempts.flatMap((a) =>
      a.submission && isPending(a.submission) ? [a.submission] : [],
    );
    if (pending.length && sameSubmissionContext(s, account))
      void poll(s, pending, account).catch(error);
  }
  async function submit() {
    trusted();
    if (submitting) throw new Error("正在提交，请勿重复点击。");
    submitting = true;
    let sent = false;
    let attempt: SubmissionAttempt | undefined;
    let s: Session | undefined;
    let account: string | undefined;
    try {
      await workbench.flush();
      s = await refreshActive();
      const identity = await ensureUser();
      account = identity.id;
      const unresolved = (await submissionAttempts(s, account)).filter(
        isUncertain,
      );
      const acknowledged: string[] = [];
      if (unresolved.length) {
        await postSubmissions(s, account, true);
        const choice = await vscode.window.showWarningMessage(
          "上一次提交结果不确定。请先刷新本人记录核对；再次提交可能产生重复记录。",
          { modal: true },
          "已核对，仍要再次提交",
        );
        if (choice !== "已核对，仍要再次提交") return;
        acknowledged.push(...unresolved.map((a) => a.attemptId));
      }
      const source = await saveSource(s);
      const code = await fs.readFile(source, "utf8");
      const connection = client;
      const original = s.binding.problem.target;
      const submission = await sendSubmission(connection, original, code, {
        language: async (problem, fallback) => {
          if (fallback && sameSubmissionContext(s!, account!, connection))
            workbench.post({
              type: "notice",
              text: `比赛路径暂不可用，将使用${targetLabel(problem.target)}提交，不计比赛成绩。`,
            });
          if (
            !problem.languages.includes(
              s!.binding.selectedSubmissionLanguage ?? "",
            ) &&
            !(await chooseLanguage(s!, problem.languages))
          )
            return undefined;
          return s!.binding.selectedSubmissionLanguage;
        },
        sending: async (target, language) => {
          if (!sameSubmissionContext(s!, account!, connection))
            throw Error("账号或当前题目已切换，请重新点击交题。");
          attempt = await submissionStore.begin(
            account!,
            {
              target,
              language,
              sourceHash: hash(code),
            },
            acknowledged,
            [
              original,
              { kind: "problemset", problemId: original.problemId },
              {
                kind: "problemset",
                problemId: original.problemId,
                service: "admin",
              },
            ],
          );
          sent = true;
        },
      });
      if (!submission) return;
      await submissionStore.observe(account, submission, attempt!.attemptId);
      await postSubmissions(s, account, true);
      if (sameSubmissionContext(s, account)) {
        workbench.post({
          type: "notice",
          text: `已通过${targetLabel(submission.target)}提交 #${submission.id}，OJ：${submission.result}${submission.target.kind === "problemset" && original.kind === "contest" ? "（不计比赛成绩）" : ""}`,
        });
        void restoreSubmissions(s).catch(error);
      }
    } catch (e) {
      if (sent && s && account && attempt) {
        await submissionStore.uncertain(account, attempt.attemptId);
        await postSubmissions(
          s,
          account,
          true,
          "提交结果待确认，请刷新记录。不会自动重发。",
        );
      }
      throw e;
    } finally {
      submitting = false;
    }
  }
  async function poll(s: Session, submissions: Submission[], account: string) {
    if (!sameSubmissionContext(s, account) || !workbench.panel) return;
    polling?.abort();
    const abort = new AbortController();
    const connection = client;
    polling = abort;
    const valid = () =>
      !abort.signal.aborted &&
      sameSubmissionContext(s, account, connection) &&
      !!workbench.panel;
    try {
      const result = await monitorSubmissions({
        submissions,
        signal: abort.signal,
        get: async (submission) => {
          if (!valid()) {
            abort.abort();
            return submission;
          }
          const t = submission.target;
          return t.kind === "contest"
            ? new ContestAdapter(connection).get(t, submission.id)
            : new ProblemsetAdapter(
                t.service === "admin" ? connection.adminReader() : connection,
              ).get(t, submission.id);
        },
        update: async (submission) => {
          if (!valid()) return;
          await submissionStore.observe(account, submission, undefined, valid);
          if (valid())
            await postSubmissions(s, account, false, undefined, valid);
        },
      });
      if (result === "waiting" && valid())
        await postSubmissions(
          s,
          account,
          false,
          "仍在评测。点击“恢复查询”可继续查询。",
          valid,
        );
    } catch (e) {
      if (valid())
        await postSubmissions(
          s,
          account,
          false,
          `查询已暂停：${e instanceof Error ? e.message : "网络异常"} 点击“恢复查询”重试。`,
          valid,
        );
    }
  }
  async function refreshSubmissions() {
    const s = requireActive();
    const identity = await ensureUser();
    const connection = client;
    const generation = submissionCacheGeneration;
    const valid = () =>
      sameSubmissionContext(s, identity.id, connection) &&
      generation === submissionCacheGeneration;
    const t = s.binding.problem.target;
    const attempts = await submissionAttempts(s, identity.id);
    const queries = [
      t.kind === "contest"
        ? new ContestAdapter(connection).list(t)
        : new ProblemsetAdapter(
            t.service === "admin" ? connection.adminReader() : connection,
          ).list(t, identity.id),
    ];
    if (t.kind === "contest") {
      const services = new Set(
        attempts.flatMap((a) =>
          a.target.kind === "problemset" ? [a.target.service ?? "student"] : [],
        ),
      );
      for (const service of services) {
        const target = {
          kind: "problemset" as const,
          problemId: t.problemId,
          ...(service === "admin" ? { service: "admin" as const } : {}),
        };
        queries.push(
          new ProblemsetAdapter(
            service === "admin" ? connection.adminReader() : connection,
          ).list(target, identity.id),
        );
      }
    }
    const results = await Promise.allSettled(queries);
    if (!valid()) return;
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(
          result.reason instanceof Error
            ? result.reason.message
            : "记录查询失败",
        );
        continue;
      }
      for (const entry of result.value.filter(
        (e) => !e.creatorId || e.creatorId === identity.id,
      ))
        await submissionStore.observe(identity.id, entry, undefined, valid);
    }
    if (!valid()) return;
    await postSubmissions(
      s,
      identity.id,
      true,
      failures.length ? `部分记录未刷新：${failures.join("；")}` : undefined,
    );
    await restoreSubmissions(s, false);
  }
  async function sync(all = false) {
    trusted();
    await workbench.flush();
    const s = await refreshActive();
    const t = s.binding.problem.target;
    const loadImages = imageLoader(client);
    if (t.kind === "problemset") {
      s.binding = await store(s.root).sync(
        s.binding,
        await cacheProblemImages(
          await new ProblemsetAdapter(client).fetch(t.problemId),
          s.root,
          loadImages,
        ),
      );
    } else {
      const snapshot = await fetchContestSnapshotForImport(
        client,
        t.contestId,
        (message) => output.appendLine(message),
      );
      const workspace = store(s.root);
      const affected = (await workspace.list()).filter(
        (b) =>
          b.problem.target.kind === "contest" &&
          b.problem.target.contestId === t.contestId &&
          (all || b.bindingId === s.binding.bindingId),
      );
      await saveCaseDocuments(s.root, affected);
      const updated = await syncContest(
        workspace,
        snapshot,
        (p) => cacheProblemImages(p, s.root, loadImages),
        all ? undefined : s.binding.bindingId,
      );
      s.binding =
        updated.find((b) => b.bindingId === s.binding.bindingId) ?? s.binding;
    }
    await workbench.show(s.binding, s.root);
    treeChange.fire();
  }
  async function bindFile() {
    trusted();
    await workbench.flush();
    const s = await refreshActive();
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "C/C++": ["c", "cpp", "cc", "cxx"] },
    });
    if (!files?.length) return;
    const relative = path.relative(s.root, files[0].fsPath);
    await safePath(s.root, relative);
    s.binding = await store(s.root).update(
      s.binding.bindingId,
      s.binding.revision,
      (b) => {
        b.sourceFile = relative;
      },
    );
    await show(s);
  }
  async function importCases() {
    trusted();
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { 输入文件: ["in"] },
    });
    if (!files?.length) return;
    const cases: TestCase[] = [];
    for (const file of files) {
      const input = await fs.readFile(file.fsPath, "utf8");
      let expected = "",
        hasExpectedOutput = true;
      try {
        expected = await fs.readFile(
          file.fsPath.replace(/\.in$/i, ".out"),
          "utf8",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        hasExpectedOutput = false;
      }
      cases.push({
        ...newCase(path.basename(file.fsPath)),
        source: "imported",
        input,
        expected,
        hasExpectedOutput,
      });
    }
    await updateCases((cs) => cs.push(...cases));
  }
  async function environment() {
    trusted();
    const tc = toolchain();
    const report: string[] = [
      `${process.platform} ${process.arch}`,
      `VS Code ${vscode.version}`,
    ];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "better-accoding-"));
    try {
      for (const [compiler, ext] of [
        [tc.c, "c"],
        [tc.cpp, "cpp"],
      ]) {
        const version = await runProcess(compiler, ["--version"], {
          cwd: dir,
          timeoutMs: 10000,
          outputLimit: 4096,
        });
        const source = path.join(dir, `probe.${ext}`);
        await fs.writeFile(
          source,
          '#include <stdio.h>\nint main(void){puts("ready");return 0;}\n',
        );
        const c = await compile(source, dir, tc);
        const r =
          c.result.exitCode === 0
            ? await runProcess(c.program, [], {
                cwd: dir,
                timeoutMs: 2000,
                outputLimit: 4096,
              })
            : c.result;
        report.push(
          `${compiler}: ${version.stdout.split("\n")[0]}\n编译/运行: ${r.exitCode === 0 && r.stdout === "ready\n" ? "通过" : r.stderr}`,
        );
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    output.appendLine(report.join("\n"));
    output.show();
  }
  async function execute(command: string, caseId?: string, arg?: Session) {
    switch (command) {
      case "login":
        if (submitting)
          throw new Error("提交正在发送，请等待本次操作结束后切换账号。");
        return authenticate();
      case "logout":
        if (submitting)
          throw new Error("提交正在发送，请等待本次操作结束后退出。");
        client.cancel();
        polling?.abort();
        client = new AccodingClient();
        user = undefined;
        await context.secrets.delete("accoding.session");
        workbench.post({
          type: "submissions",
          root: active?.root,
          bindingId: active?.binding.bindingId,
          submissions: [],
          uncertain: [],
          focus: false,
        });
        return;
      case "importProblem":
        return importItems("problemset");
      case "importContest":
        return importItems("contest");
      case "importFromUrl":
        return importItems();
      case "openProblem":
        return arg ? show(arg) : selectProblem();
      case "selectContestProblem":
        return selectProblem(true);
      case "selectProblem":
      case "selectSubmissionTarget":
        return selectProblem();
      case "restoreLayout":
        return show(requireActive(), true);
      case "bindFile":
        return bindFile();
      case "syncProblem":
        return sync();
      case "syncContest":
        return sync(true);
      case "judge":
        return run();
      case "runTestCase": {
        await workbench.flush();
        await refreshActive();
        const c = await chooseCase(caseId);
        if (c) return run(c.id);
        return;
      }
      case "rerunFailed":
        return run(undefined, true);
      case "debugTestCase":
        return debug(caseId);
      case "cancelRun":
        runAbort?.abort();
        polling?.abort();
        return;
      case "submit":
        return submit();
      case "refreshSubmissions":
        return refreshSubmissions();
      case "resumeSubmissions":
        await ensureUser();
        return restoreSubmissions(requireActive());
      case "selectSubmissionLanguage":
        await workbench.flush();
        return chooseLanguage(await refreshActive());
      case "addTestCase":
        return updateCases((cases) => cases.push(newCase()));
      case "restoreDeletedSamples": {
        trusted();
        await workbench.flush();
        const s = await refreshActive();
        s.binding = await store(s.root).update(
          s.binding.bindingId,
          s.binding.revision,
          (b) => {
            b.tombstones = [];
          },
        );
        s.binding = await store(s.root).sync(s.binding, s.binding.problem);
        await workbench.show(s.binding, s.root);
        return;
      }
      case "importTestCases":
        return importCases();
      case "duplicateTestCase":
      case "deleteTestCase":
      case "restoreOfficialSample": {
        await workbench.flush();
        await refreshActive();
        const c = await chooseCase(caseId);
        if (!c) return;
        return updateCases((cases) => {
          const i = cases.findIndex((x) => x.id === c.id);
          if (command === "deleteTestCase") {
            const key = sessionKey(requireActive());
            const ds = deleted.get(key) ?? [];
            ds.push(c);
            deleted.set(key, ds);
            cases.splice(i, 1);
          } else if (command === "duplicateTestCase")
            cases.splice(i + 1, 0, {
              ...c,
              ...newCase(`${c.name} 副本`),
              input: c.input,
              expected: c.expected,
              hasExpectedOutput: c.hasExpectedOutput,
            });
          else if (c.baseline) {
            cases[i].input = c.baseline.input;
            cases[i].expected = c.baseline.expected;
          }
        });
      }
      case "useOutput": {
        await workbench.flush();
        const s = await refreshActive();
        const c = await chooseCase(caseId);
        if (!c) return;
        const r = results.get(sessionKey(s))?.cases.find((x) => x.id === c.id);
        if (!r) return;
        if (
          (await vscode.window.showWarningMessage(
            "当前程序输出未经独立验证。确定将其用作预期输出？",
            { modal: true },
            "填入",
          )) === "填入"
        )
          await updateCases((cases) => {
            const c = cases.find((c) => c.id === caseId)!;
            c.expected = r.stdout;
            c.hasExpectedOutput = true;
          });
        return;
      }
      case "editInput":
      case "editExpected": {
        await workbench.flush();
        const s = await refreshActive();
        const c = await chooseCase(caseId);
        if (!c) return;
        if (command === "editExpected" && !c.hasExpectedOutput)
          throw new Error("请先启用校验输出，再编辑预期输出文件。");
        const file = await store(s.root).caseUriPath(
          s.binding.bindingId,
          c.id,
          command === "editInput" ? "input" : "expected",
        );
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.file(file),
        );
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
        });
        return;
      }
      case "openOnWebsite":
        return vscode.env.openExternal(
          vscode.Uri.parse(problemUrl(requireActive().binding.problem.target)),
        );
      case "checkEnvironment":
        return environment();
      case "settings": {
        const pick = await vscode.window.showQuickPick(
          [
            { label: "编译器与运行设置", command: "configure" },
            { label: "登录 / 切换账号", command: "login" },
            { label: "退出登录", command: "logout" },
            { label: "检查编译环境", command: "checkEnvironment" },
            { label: "导出脱敏诊断", command: "exportDiagnostics" },
          ],
          { placeHolder: "设置与账号" },
        );
        if (!pick) return;
        if (pick.command === "configure")
          return vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:muzermat.better-accoding-for-buaaers",
          );
        return execute(pick.command);
      }
      case "importMenu": {
        const pick = await vscode.window.showQuickPick([
          { label: "按题号导入", mode: "problemset" },
          { label: "按比赛导入", mode: "contest" },
          { label: "粘贴完整链接", mode: "url" },
        ]);
        if (pick)
          return importItems(
            pick.mode === "url"
              ? undefined
              : (pick.mode as "problemset" | "contest"),
          );
        return;
      }
      case "exportDiagnostics": {
        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(
            {
              extension: context.extension.packageJSON.version,
              vscode: vscode.version,
              platform: process.platform,
              arch: process.arch,
              trusted: vscode.workspace.isTrusted,
              remote: Boolean(vscode.env.remoteName),
              bindingCount: (
                await Promise.all([...stores.values()].map((s) => s.list()))
              ).flat().length,
            },
            null,
            2,
          ),
          language: "json",
        });
        return vscode.window.showTextDocument(doc);
      }
      case "clearPrivateData": {
        if (submitting)
          throw new Error("提交正在发送，请等待本次操作结束后清理记录。");
        polling?.abort();
        submissionCacheGeneration++;
        await submissionStore.clear();
        workbench.post({
          type: "submissions",
          root: active?.root,
          bindingId: active?.binding.bindingId,
          submissions: [],
          uncertain: [],
          focus: false,
        });
        return;
      }
    }
  }
  async function receive(raw: unknown) {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("已拒绝无效工作台消息。");
    const m = parsed.data;
    if (m.type === "ready") {
      if (active) {
        await workbench.show(active.binding, active.root);
        await restoreSubmissions(active);
      }
      return;
    }
    if (m.type === "copyDraft") {
      await vscode.env.clipboard.writeText(m.text);
      return;
    }
    if (
      !active ||
      m.bindingId !== active.binding.bindingId ||
      m.root !== active.root
    ) {
      if (m.type === "save")
        workbench.post({
          type: "saveError",
          requestId: m.requestId,
          message: "题目已切换，旧草稿未覆盖当前题目。",
        });
      else if (
        m.type === "command" &&
        [
          "importFromUrl",
          "importMenu",
          "selectProblem",
          "settings",
          "login",
        ].includes(m.command)
      )
        await execute(m.command);
      return;
    }
    if (m.type === "save") {
      try {
        trusted();
        const saved = await store(active.root).saveCases(
          m.bindingId,
          m.baseRevision,
          m.cases,
        );
        active.binding = saved;
        workbench.post({
          type: "saved",
          requestId: m.requestId,
          revision: saved.revision,
          cases: saved.cases,
        });
      } catch (e) {
        workbench.post({
          type: "saveError",
          requestId: m.requestId,
          message: e instanceof Error ? e.message : "保存失败",
          conflict:
            e instanceof ConflictError
              ? await store(m.root)
                  .read(m.bindingId)
                  .catch(() => undefined)
              : undefined,
        });
      }
      return;
    }
    await execute(m.command, m.caseId);
  }
  for (const name of commandNames)
    context.subscriptions.push(
      vscode.commands.registerCommand(prefix + name, (arg?: Session) =>
        Promise.resolve(execute(name, undefined, arg)).catch(error),
      ),
    );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const s = active;
      if (
        !s ||
        event.document.uri.scheme !== "file" ||
        event.document.uri.fsPath !== path.resolve(s.root, s.binding.sourceFile)
      )
        return;
      const result = results.get(sessionKey(s));
      if (result)
        workbench.post({
          type: "resultState",
          root: s.root,
          bindingId: s.binding.bindingId,
          sourceStale: hash(event.document.getText()) !== result.sourceHash,
        });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const s = active;
      if (!s || !event.affectsConfiguration("betterAccoding")) return;
      const result = results.get(sessionKey(s));
      if (result)
        workbench.post({
          type: "resultState",
          root: s.root,
          bindingId: s.binding.bindingId,
          configurationStale:
            hash(JSON.stringify(toolchain())) !== result.toolchainConfigHash,
        });
    }),
  );
  async function externalCaseChanged(uri: vscode.Uri) {
    const s = active;
    if (!s || uri.scheme !== "file") return;
    const tracked = s.binding.cases.some((c) =>
      [c.inputFile, c.expectedOutputFile].some(
        (file) => file && path.resolve(s.root, file) === uri.fsPath,
      ),
    );
    if (!tracked) return;
    try {
      const binding = await store(s.root).read(s.binding.bindingId);
      if (active !== s || binding.revision <= s.binding.revision) return;
      s.binding = binding;
      workbench.post({
        type: "externalCases",
        root: s.root,
        bindingId: binding.bindingId,
        binding,
      });
    } catch (e) {
      if (active === s) error(e);
    }
  }
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void externalCaseChanged(document.uri);
    }),
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/tests/*.{in,out}"),
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidChange((uri) => {
        void externalCaseChanged(uri);
      }),
      watcher.onDidCreate((uri) => {
        void externalCaseChanged(uri);
      }),
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        if (f.uri.scheme !== "file") continue;
        const s = store(f.uri.fsPath);
        for (const b of await s.list()) {
          const old = path.resolve(s.root, b.sourceFile);
          const change = event.files.find(
            (e) =>
              old === e.oldUri.fsPath ||
              old.startsWith(e.oldUri.fsPath + path.sep),
          );
          if (change) {
            const next = path.join(
              change.newUri.fsPath,
              path.relative(change.oldUri.fsPath, old),
            );
            try {
              await s.update(b.bindingId, b.revision, (b) => {
                b.sourceFile = path.relative(s.root, next);
              });
            } catch (e) {
              error(e);
            }
          }
        }
        treeChange.fire();
      }
    }),
  );
  context.subscriptions.push({
    dispose() {
      client.cancel();
      runAbort?.abort();
      polling?.abort();
      workbench.panel?.dispose();
    },
  });
  const serialized = await context.secrets.get("accoding.session");
  if (serialized) {
    try {
      client = new AccodingClient(await CookieJar.deserialize(serialized));
      user = await currentUser(client);
    } catch (e) {
      user = undefined;
      if (!(e instanceof ApiError) || e.kind === "auth") {
        client = new AccodingClient();
        await context.secrets.delete("accoding.session");
      }
    }
  }
  const last = context.workspaceState.get<{ root: string; bindingId: string }>(
    "lastBinding",
  );
  if (
    last &&
    vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === last.root)
  ) {
    try {
      active = {
        root: last.root,
        binding: await store(last.root).read(last.bindingId),
      };
    } catch {
      /* Keep original data for recovery. */
    }
  }
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("betterAccoding.workbench", {
      async deserializeWebviewPanel(panel, state: unknown) {
        const parsed = z
          .object({ root: z.string(), bindingId: z.string() })
          .safeParse(state);
        if (
          !parsed.success ||
          !vscode.workspace.workspaceFolders?.some(
            (f) => f.uri.scheme === "file" && f.uri.fsPath === parsed.data.root,
          )
        ) {
          panel.dispose();
          return;
        }
        try {
          active = {
            root: parsed.data.root,
            binding: await store(parsed.data.root).read(parsed.data.bindingId),
          };
          workbench.restore(panel);
        } catch (e) {
          panel.dispose();
          error(e);
        }
      },
    }),
  );
  return {
    store,
    commands: commandNames,
    open: show,
    getActive: () => active,
    debugTestCase: debug,
    runTestCase: run,
    editTestCaseInput: (id: string) => execute("editInput", id),
    getResult: () => (active ? results.get(sessionKey(active)) : undefined),
  };
}
export function deactivate() {}
