import renderMathInElement from "katex/contrib/auto-render";
import type { Binding, TestCase } from "../src/model";
import type { JudgeResult } from "../src/judge/judge";
import type { Submission } from "../src/accoding/adapters";
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): DraftState | undefined;
  setState(state: DraftState): void;
};
interface DraftState {
  bindingId: string;
  root: string;
  revision: number;
  cases: TestCase[];
  dirty: boolean;
}
const api = acquireVsCodeApi();
let binding: Binding | undefined,
  root = "",
  html = "",
  tab = "statement",
  dirty = false,
  serial = 0,
  saving: Promise<void> | undefined,
  saveError = "",
  result: JudgeResult | undefined,
  submissions: Submission[] = [];
let resolveSave:
    ((message: { revision: number; cases: TestCase[] }) => void) | undefined,
  rejectSave: ((e: Error) => void) | undefined;
let saveRequestId: string | undefined;
let deleted: TestCase[] = [];
let debounce: ReturnType<typeof setTimeout> | undefined;
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<nav aria-label="做题操作栏"><div class="brand">AC<span>BUAAers</span></div><button data-action="judge" title="保存并评测全部启用用例">▶<span>评测</span></button><button data-action="submit" title="向当前题目来源提交关联源码">↑<span>交题</span></button><button data-action="debugTestCase" title="调试选中用例">◉<span>调试</span></button><button data-action="importMenu">＋<span>爬题</span></button><button data-action="selectProblem">☷<span>题单</span></button><button data-action="syncProblem">↻<span>同步</span></button><button data-action="cancelRun" title="停止本地运行和远程查询；无法撤回已发送提交">■<span>停止</span></button><button data-action="settings">⚙<span>设置</span></button></nav><main><header><div class="eyebrow">BETTER ACCODING · 非官方</div><h1 id="title">准备开始练习</h1><div id="context">按题号或比赛导入，代码将在右侧原生编辑器中打开。</div><div class="tabs"><button data-tab="statement">题面</button><button data-tab="tests">测试用例</button><button data-tab="submissions">提交记录</button></div></header><section id="content"></section><footer><span id="save" role="status">尚未选择题目</span><button data-action="selectSubmissionLanguage" id="language">选择提交语言</button><div id="summary">本地样例与 OJ 结果分别显示</div></footer></main>`;
const content = document.querySelector<HTMLElement>("#content")!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label: string, fn: () => void) {
  const b = el("button", label);
  b.addEventListener("click", fn);
  return b;
}
function state() {
  if (binding)
    api.setState({
      bindingId: binding.bindingId,
      root,
      revision: binding.revision,
      cases: binding.cases,
      dirty,
    });
}
function status() {
  document.querySelector("#save")!.textContent = saveError
    ? `保存失败：${saveError}`
    : saving
      ? "保存中…"
      : dirty
        ? "等待保存…"
        : "已保存";
  state();
}
function edit() {
  dirty = true;
  serial++;
  saveError = "";
  status();
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void flush().catch(() => {});
  }, 350);
}
async function flush(): Promise<void> {
  clearTimeout(debounce);
  if (saving) {
    await saving;
    if (dirty) return flush();
    return;
  }
  if (!binding || !dirty) return;
  const generation = serial;
  const snapshot = structuredClone(binding.cases);
  saveRequestId = crypto.randomUUID();
  const timeout = setTimeout(
    () => rejectSave?.(new Error("保存确认超时，草稿仍保留。")),
    10000,
  );
  saving = new Promise<void>((resolve, reject) => {
    resolveSave = (m) => {
      if (!binding) return;
      binding.revision = m.revision;
      if (generation === serial) {
        for (const c of binding.cases) {
          const saved = m.cases.find((x) => x.id === c.id);
          if (saved) Object.assign(c, saved);
        }
        dirty = false;
      } else {
        for (const c of binding.cases) {
          const saved = m.cases.find((x) => x.id === c.id);
          if (saved) {
            c.revision = saved.revision;
            c.baseline = saved.baseline;
            c.source = saved.source;
            c.upstreamSampleKey = saved.upstreamSampleKey;
          }
        }
      }
      resolve();
    };
    rejectSave = reject;
  });
  status();
  api.postMessage({
    type: "save",
    root,
    bindingId: binding.bindingId,
    baseRevision: binding.revision,
    requestId: saveRequestId,
    cases: snapshot,
  });
  try {
    await saving;
    saveError = "";
  } catch (e) {
    saveError = (e as Error).message;
    throw e;
  } finally {
    clearTimeout(timeout);
    saveRequestId = undefined;
    saving = undefined;
    resolveSave = undefined;
    rejectSave = undefined;
    status();
  }
  if (dirty) await flush();
}
async function action(command: string, caseId?: string) {
  try {
    if (command !== "cancelRun") await flush();
    if (command === "judge" || command === "runTestCase") tab = "tests";
    api.postMessage({
      type: "command",
      command,
      caseId,
      bindingId: binding?.bindingId,
      root,
    });
    render();
  } catch {
    /* Keep draft and error visible. */
  }
}
app.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (b?.dataset.action) void action(b.dataset.action);
  if (b?.dataset.tab) {
    tab = b.dataset.tab;
    render();
  }
});
function render() {
  for (const b of app.querySelectorAll<HTMLButtonElement>("nav button"))
    b.disabled =
      !binding &&
      !["importMenu", "selectProblem", "settings"].includes(b.dataset.action!);
  if (!binding) {
    content.replaceChildren(
      el("p", "先从操作栏“爬题”导入题目，或从“题单”打开离线缓存。"),
    );
    return;
  }
  document.querySelector("#title")!.textContent =
    `${binding.problem.label} ${binding.problem.title}`;
  document.querySelector("#context")!.textContent =
    `${binding.problem.target.kind === "contest" ? `比赛 #${binding.problem.target.contestId}` : "题库"} · #${binding.problem.target.problemId} · ${binding.sourceFile}`;
  document.querySelector("#language")!.textContent =
    `交题语言：${binding.selectedSubmissionLanguage ?? "未选择"}`;
  app
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  content.replaceChildren();
  if (tab === "statement") {
    content.append(
      el(
        "div",
        `时间限制：${binding.problem.timeLimit ?? "未提供"} · 内存限制：${binding.problem.memoryLimit ?? "未提供"}`,
      ),
    );
    for (const w of binding.problem.warnings) content.append(el("p", w));
    if (binding.problem.special)
      content.append(
        el(
          "p",
          "特殊评测/交互题：本地文本比较不代表完整评测，仍可编辑代码并提交 OJ。",
        ),
      );
    const article = el("article");
    article.innerHTML = html;
    content.append(article);
    renderMathInElement(article, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      trust: false,
    });
  } else if (tab === "tests") renderTests();
  else {
    content.append(
      button("刷新本人记录", () => void action("refreshSubmissions")),
    );
    if (!submissions.length) content.append(el("p", "暂无本人的提交记录。"));
    for (const s of submissions) {
      const row = el("details");
      row.append(
        el(
          "summary",
          `#${s.id} · OJ：${s.result}${s.score !== undefined ? ` · 得分 ${s.score}` : ""}`,
        ),
        el("pre", s.detail ?? ""),
      );
      content.append(row);
    }
  }
  status();
}
function createCase() {
  const c: TestCase = {
    id: crypto.randomUUID(),
    name: `用例 ${(binding?.cases.length ?? 0) + 1}`,
    source: "custom",
    input: "",
    expected: "",
    hasExpectedOutput: true,
    enabled: true,
    revision: 0,
    comparison: "exact",
    locallyModified: false,
  };
  binding!.cases.push(c);
  edit();
  tab = "tests";
  render();
  content
    .querySelectorAll("textarea")
    .item((binding!.cases.length - 1) * 2)
    ?.focus();
}
function renderTests() {
  const tools = el("div");
  tools.className = "tools";
  tools.append(
    button("＋ 添加用例", createCase),
    button("导入 .in/.out", () => void action("importTestCases")),
    button("恢复已删官方样例", () => void action("restoreDeletedSamples")),
    button("运行全部", () => void action("judge")),
    button("重跑失败", () => void action("rerunFailed")),
    button("撤销删除", () => {
      const c = deleted.pop();
      if (c) {
        binding!.cases.push(c);
        edit();
        render();
      }
    }),
    button("复制全部草稿", () => {
      api.postMessage({
        type: "copyDraft",
        text: JSON.stringify(binding?.cases, null, 2),
      });
    }),
  );
  content.append(tools);
  if (!binding!.cases.length)
    content.append(el("p", "没有可用样例。可添加自定义用例或导入 .in/.out。"));
  for (const [index, c] of binding!.cases.entries()) {
    const card = el("section");
    card.className = "case";
    card.dataset.case = c.id;
    const head = el("div");
    head.className = "case-head";
    const name = el("input");
    name.value = c.name;
    name.setAttribute("aria-label", "用例名称");
    name.addEventListener("input", () => {
      c.name = name.value;
      edit();
    });
    const enabled = el("input");
    enabled.type = "checkbox";
    enabled.checked = c.enabled;
    enabled.addEventListener("change", () => {
      c.enabled = enabled.checked;
      edit();
    });
    const enabledLabel = el("label", "启用 ");
    enabledLabel.append(enabled);
    head.append(
      name,
      enabledLabel,
      el(
        "span",
        c.source === "sample"
          ? `官方样例${c.baseline && (c.input !== c.baseline.input || c.expected !== c.baseline.expected) ? " · 已本地修改" : ""}`
          : c.source === "imported"
            ? "文件导入"
            : "自定义",
      ),
    );
    card.append(head);
    const fields = el("div");
    fields.className = "fields";
    for (const key of ["input", "expected"] as const) {
      const label = el("label", key === "input" ? "输入" : "预期输出");
      const area = el("textarea");
      area.spellcheck = false;
      area.value = c[key];
      area.setAttribute(
        "aria-label",
        `${c.name} ${key === "input" ? "输入" : "预期输出"}`,
      );
      if (c[key].length > 128 * 1024) {
        area.value = c[key].slice(0, 4096);
        area.readOnly = true;
        label.append(
          el("p", "大用例仅预览，使用原生编辑器修改。"),
          button(
            "在编辑器打开",
            () =>
              void action(key === "input" ? "editInput" : "editExpected", c.id),
          ),
        );
      } else
        area.addEventListener("input", () => {
          c[key] = area.value;
          edit();
        });
      label.append(area);
      fields.append(label);
    }
    card.append(fields);
    const check = el("input");
    check.type = "checkbox";
    check.checked = c.hasExpectedOutput;
    check.addEventListener("change", () => {
      c.hasExpectedOutput = check.checked;
      edit();
    });
    const checkLabel = el("label", "参与校验（空内容表示期望空输出）");
    checkLabel.prepend(check);
    const select = el("select");
    select.setAttribute("aria-label", "输出比较模式");
    for (const [v, t] of [
      ["exact", "精确比较（统一换行）"],
      ["trim-line-end", "忽略行尾空格"],
      ["tokens", "Token 比较"],
    ]) {
      const o = el("option", t);
      o.value = v;
      o.selected = c.comparison === v;
      select.append(o);
    }
    select.onchange = () => {
      c.comparison = select.value as TestCase["comparison"];
      edit();
    };
    card.append(checkLabel, select);
    const actions = el("div");
    actions.className = "tools";
    actions.append(
      button("运行", () => void action("runTestCase", c.id)),
      button("调试", () => void action("debugTestCase", c.id)),
      button("复制", () => {
        binding!.cases.splice(index + 1, 0, {
          ...structuredClone(c),
          id: crypto.randomUUID(),
          source: "custom",
          baseline: undefined,
          upstreamSampleKey: undefined,
          name: `${c.name} 副本`,
        });
        edit();
        render();
      }),
      button("删除", () => {
        deleted.push(c);
        binding!.cases.splice(index, 1);
        edit();
        render();
      }),
      button("上移", () => move(index, -1)),
      button("下移", () => move(index, 1)),
    );
    if (c.baseline)
      actions.append(
        button("恢复官方版本", () => {
          c.input = c.baseline!.input;
          c.expected = c.baseline!.expected;
          edit();
          render();
        }),
      );
    card.append(actions);
    const r = result?.cases.find((x) => x.id === c.id);
    if (r) {
      const stale = dirty || c.revision !== r.revision;
      card.append(
        el(
          "strong",
          `${r.status}${stale ? " · 结果已过期" : ""} · ${r.elapsedMs} ms（本机测量）`,
        ),
      );
      const detail = el("details");
      detail.append(
        el("summary", "实际输出 / 差异 / stderr"),
        el("pre", r.stdout.slice(0, 32768)),
        el("pre", r.stderr.slice(0, 32768)),
      );
      if (r.diff && !r.diff.equal)
        detail.append(
          el(
            "pre",
            `第 ${r.diff.line} 行开始不同\n实际：${r.diff.actual}\n预期：${r.diff.expected}`,
          ),
        );
      detail.append(
        button("用当前输出填入预期", () => void action("useOutput", c.id)),
      );
      card.append(detail);
    }
    content.append(card);
  }
  if (result && result.compilation.exitCode !== 0) {
    content.prepend(
      el(
        "pre",
        `编译未完成：${result?.compilation.reason ?? "CE"}\n${result?.compilation.stderr ?? ""}`,
      ),
    );
  }
}
function move(index: number, delta: number) {
  const next = index + delta;
  if (next < 0 || next >= binding!.cases.length) return;
  const [c] = binding!.cases.splice(index, 1);
  binding!.cases.splice(next, 0, c);
  edit();
  render();
}
window.addEventListener("message", (event) => {
  const m = event.data;
  if (m.type === "binding") {
    const saved = api.getState();
    binding = m.binding;
    root = m.root;
    html = m.html;
    result = undefined;
    submissions = [];
    deleted = [];
    dirty = false;
    saveError = "";
    if (
      saved?.dirty &&
      saved.bindingId === binding!.bindingId &&
      saved.root === root
    ) {
      binding!.cases = saved.cases;
      dirty = true;
      if (saved.revision !== binding!.revision) {
        binding!.revision = saved.revision;
        saveError = "恢复草稿与磁盘版本冲突，请复制草稿后重新载入。";
      }
    }
    render();
  } else if (m.type === "saved" && m.requestId === saveRequestId)
    resolveSave?.(m);
  else if (m.type === "saveError" && m.requestId === saveRequestId)
    rejectSave?.(new Error(m.message));
  else if (m.type === "flush")
    void flush().then(
      () => api.postMessage({ type: "flushed", requestId: m.requestId }),
      (e) =>
        api.postMessage({
          type: "flushed",
          requestId: m.requestId,
          error: e.message,
        }),
    );
  else if (
    m.type === "result" &&
    m.bindingId === binding?.bindingId &&
    m.root === root
  ) {
    result = m.result;
    tab = "tests";
    const pass = result!.cases.filter((x) => x.status === "PASS").length;
    document.querySelector("#summary")!.textContent =
      `样例通过 ${pass}/${result!.cases.length}（本机测量）`;
    if (!dirty && !saving) render();
  } else if (
    m.type === "submissions" &&
    m.bindingId === binding?.bindingId &&
    m.root === root
  ) {
    submissions = m.submissions;
    tab = "submissions";
    render();
  } else if (m.type === "notice") {
    document.querySelector("#summary")!.textContent = m.text;
  } else if (m.type === "addCase") createCase();
});
render();
api.postMessage({ type: "ready" });
