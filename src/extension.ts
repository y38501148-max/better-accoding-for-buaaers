import * as vscode from "vscode";
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
  type Binding,
  type Session,
  type TestCase,
} from "./model";
import {
  WorkspaceStore,
  safePath,
  atomicWrite,
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
            label: `${b.problem.label} ${b.problem.title}`,
            session: { root: f.uri.fsPath, binding: b },
          });
        }
        if (!map.size) continue;
        groups.push({
          label: f.name,
          children: [...map].map(([label, children]) => ({ label, children })),
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
  async function refreshActive() {
    const s = requireActive();
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
      workbench.show(binding, s.root);
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
    const problems =
      target.kind === "problemset"
        ? [await new ProblemsetAdapter(client).fetch(target.id)]
        : await new ContestAdapter(client).fetch(target.id);
    const picked =
      target.kind === "problemset"
        ? problems
        : await vscode.window
            .showQuickPick(
              problems.map((problem) => ({
                label: `${problem.label} ${problem.title}`,
                picked: true,
                problem,
              })),
              { canPickMany: true, placeHolder: "选择要导入的题目" },
            )
            .then((items) => items?.map((i) => i.problem));
    if (!picked?.length) return;
    let first: Binding | undefined;
    for (const p of picked) {
      const b = await store(root).import(p);
      first ??= b;
    }
    treeChange.fire();
    if (first) await show({ root, binding: first });
  }
  async function selectProblem() {
    const all: { label: string; description: string; session: Session }[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== "file") continue;
      for (const b of await store(f.uri.fsPath).list())
        all.push({
          label: `${b.problem.label} ${b.problem.title}`,
          description: `${f.name} · ${b.bindingId}`,
          session: { root: f.uri.fsPath, binding: b },
        });
    }
    const choice = await vscode.window.showQuickPick(all, {
      placeHolder: "选择题目（每种提交来源独立保存）",
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
    workbench.show(s.binding, s.root);
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
  async function chooseLanguage(s: Session) {
    const choice = await vscode.window.showQuickPick(
      s.binding.problem.languages,
      { placeHolder: "选择 OJ 实际支持的提交语言（本地编译标准单独设置）" },
    );
    if (!choice) return false;
    s.binding = await store(s.root).update(
      s.binding.bindingId,
      s.binding.revision,
      (b) => {
        b.selectedSubmissionLanguage = choice;
      },
    );
    if (active === s) workbench.show(s.binding, s.root);
    return true;
  }
  const submissionFile = (userId: string) =>
    path.join(
      context.globalStorageUri.fsPath,
      "submissions",
      `${hash(userId)}.json`,
    );
  let privateWrites: Promise<unknown> = Promise.resolve();
  function persistSubmission(userId: string, s: Session, entry: unknown) {
    const task = privateWrites.then(() => writeSubmission(userId, s, entry));
    privateWrites = task.catch(() => {});
    return task;
  }
  async function writeSubmission(userId: string, s: Session, entry: unknown) {
    const file = submissionFile(userId);
    let data: unknown[] = [];
    try {
      data = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    data.push({ bindingId: s.binding.bindingId, ...(entry as object) });
    await atomicWrite(file, JSON.stringify(data));
  }
  async function submit() {
    trusted();
    if (submitting) throw new Error("正在提交，请勿重复点击。");
    submitting = true;
    let sent = false;
    let s: Session | undefined;
    let account: string | undefined;
    try {
      await workbench.flush();
      s = await refreshActive();
      const identity = await ensureUser();
      account = identity.id;
      let history: Array<{ bindingId: string; state: string }> = [];
      try {
        history = JSON.parse(
          await fs.readFile(submissionFile(account), "utf8"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const previous = history
        .filter((x) => x.bindingId === s!.binding.bindingId)
        .at(-1);
      if (previous && ["Sending", "UnknownOutcome"].includes(previous.state)) {
        const choice = await vscode.window.showWarningMessage(
          "上一次提交结果不确定。请先刷新本人记录核对；再次提交可能产生重复记录。",
          { modal: true },
          "已核对，仍要再次提交",
        );
        if (choice !== "已核对，仍要再次提交") return;
      }
      if (!s.binding.selectedSubmissionLanguage && !(await chooseLanguage(s)))
        return;
      const source = await saveSource(s);
      const code = await fs.readFile(source, "utf8");
      const target = s.binding.problem.target;
      await persistSubmission(account, s, {
        state: "Draft",
        target,
        language: s.binding.selectedSubmissionLanguage,
        sourceHash: hash(code),
        createdAt: new Date().toISOString(),
      });
      const markSending = async () => {
        await persistSubmission(account!, s!, {
          state: "Sending",
          createdAt: new Date().toISOString(),
        });
        sent = true;
      };
      const submission =
        target.kind === "contest"
          ? await new ContestAdapter(client).submit(
              target,
              code,
              s.binding.selectedSubmissionLanguage!,
              markSending,
            )
          : await new ProblemsetAdapter(client).submit(
              target,
              code,
              s.binding.selectedSubmissionLanguage!,
              markSending,
            );
      await persistSubmission(account, s, {
        state: "AcceptedByServer",
        submission,
      });
      workbench.post({
        type: "notice",
        text: `已提交 #${submission.id}，OJ：${submission.result}`,
      });
      void poll(s, submission, account).catch(error);
    } catch (e) {
      if (sent && s && account) {
        await persistSubmission(account, s, {
          state: "UnknownOutcome",
          createdAt: new Date().toISOString(),
        });
        workbench.post({
          type: "notice",
          text: "提交结果待确认，请刷新记录。不会自动重发。",
        });
      }
      throw e;
    } finally {
      submitting = false;
    }
  }
  async function poll(s: Session, submission: Submission, account: string) {
    polling?.abort();
    const abort = new AbortController();
    polling = abort;
    const began = Date.now();
    let wait = 2000;
    while (
      !abort.signal.aborted &&
      workbench.panel &&
      Date.now() - began < 120000
    ) {
      workbench.post({
        type: "submissions",
        root: s.root,
        bindingId: s.binding.bindingId,
        submissions: [submission],
      });
      if (!["WT", "JG"].includes(submission.result)) {
        await persistSubmission(account, s, { state: "Final", submission });
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          abort.signal.removeEventListener("abort", stop);
          resolve();
        }, wait);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        abort.signal.addEventListener("abort", stop, { once: true });
      });
      if (abort.signal.aborted) return;
      const t = submission.target;
      submission =
        t.kind === "contest"
          ? await new ContestAdapter(client).get(t, submission.id)
          : await new ProblemsetAdapter(client).get(t, submission.id);
      wait = Math.min(10000, wait + 1000);
    }
  }
  async function refreshSubmissions() {
    const s = requireActive();
    const identity = await ensureUser();
    const t = s.binding.problem.target;
    const entries =
      t.kind === "contest"
        ? await new ContestAdapter(client).list(t)
        : await new ProblemsetAdapter(client).list(t, identity.id);
    const own = entries.filter(
      (e) => !e.creatorId || e.creatorId === identity.id,
    );
    workbench.post({
      type: "submissions",
      root: s.root,
      bindingId: s.binding.bindingId,
      submissions: own,
    });
    const pending = own.find((e) => ["WT", "JG"].includes(e.result));
    if (pending) void poll(s, pending, identity.id).catch(error);
  }
  async function sync(all = false) {
    trusted();
    await workbench.flush();
    const s = await refreshActive();
    const t = s.binding.problem.target;
    if (t.kind === "problemset") {
      s.binding = await store(s.root).sync(
        s.binding,
        await new ProblemsetAdapter(client).fetch(t.problemId),
      );
    } else {
      const problems = await new ContestAdapter(client).fetch(t.contestId);
      for (const b of await store(s.root).list()) {
        if (
          b.problem.target.kind !== "contest" ||
          b.problem.target.contestId !== t.contestId ||
          (!all && b.bindingId !== s.binding.bindingId)
        )
          continue;
        const p = problems.find(
          (p) => p.target.problemId === b.problem.target.problemId,
        );
        if (p) {
          const updated = await store(s.root).sync(b, p);
          if (b.bindingId === s.binding.bindingId) s.binding = updated;
        }
      }
    }
    workbench.show(s.binding, s.root);
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
        workbench.show(s.binding, s.root);
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
        const c = await chooseCase(caseId);
        if (!c) return;
        const doc = await vscode.workspace.openTextDocument({
          content: command === "editInput" ? c.input : c.expected,
          language: "plaintext",
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        void vscode.window.showInformationMessage(
          "此处为用例副本；保存为 .in/.out 后用“导入用例”载入。",
        );
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
        polling?.abort();
        await fs.rm(path.join(context.globalStorageUri.fsPath, "submissions"), {
          recursive: true,
          force: true,
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
      if (active) workbench.show(active.binding, active.root);
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
        ["importFromUrl", "importMenu", "selectProblem", "settings"].includes(
          m.command,
        )
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
  };
}
export function deactivate() {}
