import { icon, type IconName } from "./icons";
import { problemLabel } from "../src/problems/order";
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
let uncertainSubmissions: {
  createdAt: string;
  language?: string;
  target?: Submission["target"];
}[] = [];
let submissionStatus = "";
let conflict: Binding | undefined;
let sourceStale = false,
  configurationStale = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
const app = document.querySelector<HTMLDivElement>("#app")!;
const navButton = (
  name: IconName,
  command: string,
  label: string,
  title: string,
) =>
  `<button data-action="${command}" title="${title}" aria-label="${label}" class="rail-button ${command === "judge" ? "rail-primary" : ""}">${icon(name)}<span>${label}</span></button>`;
app.innerHTML = `
<nav class="rail" aria-label="做题操作栏">
  <div class="brand" title="Better Accoding For BUAAers">${icon("code")}</div>
  <div class="rail-group">
    ${navButton("play", "judge", "评测", "保存并运行启用的用例")}
    ${navButton("send", "submit", "交题", "提交关联源码；比赛结束后自动改用题库")}
    ${navButton("debug", "debugTestCase", "调试", "使用选定用例开始调试")}
  </div>
  <div class="rail-divider"></div>
  <div class="rail-group">
    ${navButton("plus", "importMenu", "导入", "按题号、比赛或链接导入")}
    ${navButton("list", "selectProblem", "题单", "切换题目")}
    ${navButton("refresh", "syncProblem", "同步", "更新题面，保留本地修改")}
    ${navButton("stop", "cancelRun", "停止", "停止运行与查询；不会撤回已发送的提交")}
  </div>
  <div class="rail-bottom">${navButton("account", "login", "登录", "登录 Accoding / 切换账号")}${navButton("settings", "settings", "设置", "设置与账号")}</div>
</nav>
<main>
  <header class="problem-header">
    <div class="breadcrumb"><span>Accoding</span><span class="breadcrumb-divider">/</span><span id="context">工作台</span><button class="header-link" data-action="openOnWebsite" title="在 Accoding 打开" aria-label="在原站打开">↗</button></div>
    <button id="problem-picker" class="problem-picker" data-action="selectContestProblem" title="按题序选择题目" aria-label="选择题目"><span id="problem-picker-label">选择题目</span>${icon("chevron")}</button>
    <h1 id="title">开始一道新题</h1>
    <div class="file-binding">${icon("file")}<span id="source">关联源码将在右侧打开</span><span class="binding-dot"></span><span>原生编辑器</span></div>
    <div class="tabs" role="tablist" aria-label="题目工作台">
      <button data-tab="statement" role="tab">${icon("book")}<span>题面</span></button>
      <button data-tab="tests" role="tab">${icon("tests")}<span>测试</span><span class="tab-count" id="case-count">0</span></button>
      <button data-tab="submissions" role="tab">${icon("history")}<span>提交记录</span></button>
    </div>
  </header>
  <aside id="conflict" aria-live="polite" hidden></aside>
  <section id="content"></section>
  <footer>
    <div class="footer-main"><span id="summary">准备就绪</span><button data-action="selectSubmissionLanguage" id="language" title="选择 OJ 提交语言">选择语言 ${icon("chevron")}</button></div>
    <div class="footer-detail"><span class="save-indicator"></span><span id="save" role="status">尚未选择题目</span><span class="local-note">本地测试 ≠ OJ 结果</span></div>
  </footer>
</main>`;
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
function iconButton(
  name: IconName,
  label: string,
  fn: () => void,
  only = false,
) {
  const b = button("", fn);
  b.innerHTML = icon(name);
  b.title = label;
  b.setAttribute("aria-label", label);
  b.className = only ? "icon-button" : "icon-text-button";
  if (!only) b.append(el("span", label));
  return b;
}
function menu(label: string, items: HTMLElement[]) {
  const details = el("details");
  details.className = "overflow-menu";
  const summary = el("summary");
  summary.innerHTML = icon("more");
  summary.title = label;
  summary.setAttribute("aria-label", label);
  const popover = el("div");
  popover.className = "menu-popover";
  popover.append(...items);
  details.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      details.open = false;
      summary.focus();
    }
  });
  details.addEventListener("toggle", () => {
    if (details.open)
      for (const other of app.querySelectorAll<HTMLDetailsElement>(
        ".overflow-menu[open]",
      )) {
        if (other !== details) other.open = false;
      }
  });
  popover.addEventListener("click", () => {
    details.open = false;
  });
  details.append(summary, popover);
  return details;
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
function renderConflict() {
  const banner = app.querySelector<HTMLElement>("#conflict")!;
  banner.hidden = !conflict;
  if (!conflict) {
    banner.replaceChildren();
    return;
  }
  const saved = conflict;
  const title = el(
    "p",
    "用例已在其他窗口或文件中修改。卡片草稿已保留，请选择要继续使用的版本。",
  );
  const controls = el("div");
  const load = button("使用已保存版本", () => {
    if (!binding || saving) return;
    binding.cases = structuredClone(saved.cases);
    binding.revision = saved.revision;
    conflict = undefined;
    dirty = false;
    saveError = "";
    state();
    render();
  });
  const overwrite = button("用草稿覆盖", () => {
    if (!binding || saving) return;
    binding.revision = saved.revision;
    conflict = undefined;
    edit();
    void flush()
      .then(() => render())
      .catch(() => {});
  });
  load.disabled = !!saving;
  overwrite.disabled = !!saving;
  controls.append(
    load,
    overwrite,
    button("复制草稿", () =>
      api.postMessage({
        type: "copyDraft",
        text: JSON.stringify(binding?.cases, null, 2),
      }),
    ),
  );
  banner.replaceChildren(title, controls);
}
function refreshResultState() {
  if (!binding || !result) return;
  const isStale = (c: TestCase, revision: number) =>
    sourceStale || configurationStale || dirty || c.revision !== revision;
  for (const card of content.querySelectorAll<HTMLElement>(".case")) {
    const c = binding.cases.find((c) => c.id === card.dataset.case);
    const r = result.cases.find((r) => r.id === card.dataset.case);
    if (!c || !r) continue;
    let verdict = card.querySelector<HTMLElement>(".case-verdict");
    if (!verdict) {
      verdict = el("div");
      verdict.className = "case-verdict";
      card.append(verdict);
    }
    const stale = isStale(c, r.revision);
    verdict.dataset.status = stale ? "stale" : r.status;
    verdict.textContent = `${r.status}${stale ? " · 已过期" : ""}   ${r.elapsedMs} ms · 本机`;
  }
  const enabled = binding.cases.filter((c) => c.enabled);
  const evaluated = enabled.flatMap((c) => {
    const r = result!.cases.find((r) => r.id === c.id);
    return r ? [{ c, r }] : [];
  });
  const stale = evaluated.some(({ c, r }) => isStale(c, r.revision));
  const checked = evaluated.filter(({ c }) => c.hasExpectedOutput);
  document.querySelector("#summary")!.textContent = stale
    ? "结果已过期 · 请重新运行"
    : `本地通过 ${checked.filter(({ r }) => r.status === "PASS").length}/${checked.length}${evaluated.length > checked.length ? ` · ${evaluated.length - checked.length} 例仅运行` : ""}`;
}
function status() {
  for (const card of content.querySelectorAll<HTMLElement>(".case")) {
    const c = binding?.cases.find((c) => c.id === card.dataset.case);
    const badge = card.querySelector(".case-head > span:last-child");
    if (c && badge)
      badge.textContent =
        c.source === "sample"
          ? `官方样例${c.baseline && (c.input !== c.baseline.input || c.expected !== c.baseline.expected) ? " · 已本地修改" : ""}`
          : c.source === "imported"
            ? "文件导入"
            : "自定义";
  }
  renderConflict();
  refreshResultState();
  document.querySelector("#save")!.textContent = saveError
    ? `保存失败：${saveError}`
    : saving
      ? "保存中…"
      : dirty
        ? "等待保存…"
        : "已保存";
  app.dataset.saveState = saveError
    ? "error"
    : saving || dirty
      ? "pending"
      : "saved";
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
  if (conflict) throw new Error("请先选择要使用的用例版本。");
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
    if (conflict && command !== "cancelRun")
      throw new Error("请先解决用例冲突。");
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
  for (const menu of app.querySelectorAll<HTMLDetailsElement>(
    ".overflow-menu[open]",
  )) {
    if (!menu.contains(e.target as Node)) menu.open = false;
  }
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (b?.dataset.action) void action(b.dataset.action);
  if (b?.dataset.tab) {
    tab = b.dataset.tab;
    render();
  }
});
app.querySelector(".tabs")!.addEventListener("keydown", (event) => {
  const e = event as KeyboardEvent;
  const tabs = [...app.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
    return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
function render() {
  for (const b of app.querySelectorAll<HTMLButtonElement>("nav button"))
    b.disabled =
      !binding &&
      !["importMenu", "selectProblem", "settings", "login"].includes(
        b.dataset.action!,
      );
  if (!binding) {
    content.replaceChildren(
      el("p", "从操作栏“导入”添加题目，或从“题单”打开已缓存的题目。"),
    );
    return;
  }
  const submitButton = app.querySelector<HTMLButtonElement>(
    '[data-action="submit"]',
  )!;
  submitButton.disabled = !!binding.unavailable;
  submitButton.title = binding.unavailable
    ? "此题已移除；同步确认恢复后才可交题"
    : "提交关联源码；比赛结束后自动改用题库";
  const label = problemLabel(binding.problem);
  document.querySelector("#problem-picker-label")!.textContent =
    `${label} · 切换题目`;
  document.querySelector("#title")!.textContent =
    binding.problem.target.kind === "contest"
      ? `${label}. ${binding.problem.title}`
      : binding.problem.title;
  document.querySelector("#context")!.textContent =
    `${binding.problem.target.kind === "contest" ? `比赛 ${binding.problem.target.contestId} · ${label}` : "题库"} / #${binding.problem.target.problemId}`;
  document.querySelector("#source")!.textContent = binding.sourceFile;
  document.querySelector("#case-count")!.textContent = String(
    binding.cases.length,
  );
  const language = document.querySelector("#language")!;
  language.replaceChildren(
    el("span", binding.selectedSubmissionLanguage ?? "选择交题语言"),
  );
  const caret = el("span");
  caret.innerHTML = icon("chevron");
  language.append(caret);
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.tab === tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    b.tabIndex = b.dataset.tab === tab ? 0 : -1;
  });
  content.replaceChildren();
  if (binding.unavailable) {
    const note = el(
      "p",
      "此题已从比赛移除。代码和用例已保留，可继续本地练习；同步确认恢复后才可交题。",
    );
    note.className = "notice";
    content.append(note);
  }
  if (tab === "statement") {
    const limits = el("div");
    limits.className = "limits";
    for (const [name, text] of [
      ["clock", binding.problem.timeLimit ?? "时间限制未提供"],
      ["memory", binding.problem.memoryLimit ?? "内存限制未提供"],
    ] as const) {
      const item = el("span");
      item.innerHTML = icon(name);
      item.append(el("span", text));
      limits.append(item);
    }
    content.append(limits);
    for (const w of binding.problem.warnings) {
      const note = el("p", w);
      note.className = "notice";
      content.append(note);
    }
    if (binding.problem.special)
      content.append(
        el(
          "p",
          "特殊评测/交互题：本地文本比较不代表完整评测，仍可编辑代码并提交 OJ。",
        ),
      );
    const article = el("article");
    article.innerHTML = html;
    const duplicateTitle = article.querySelector("h1");
    if (duplicateTitle?.textContent === binding.problem.title)
      duplicateTitle.remove();
    for (const pre of article.querySelectorAll("pre")) {
      const text = pre.textContent ?? "";
      const wrap = el("div");
      wrap.className = "sample-block";
      pre.replaceWith(wrap);
      wrap.append(
        pre,
        iconButton(
          "copy",
          "复制",
          () => api.postMessage({ type: "copyDraft", text }),
          true,
        ),
      );
    }
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
      button("恢复查询", () => void action("resumeSubmissions")),
    );
    if (submissionStatus) content.append(el("p", submissionStatus));
    for (const attempt of uncertainSubmissions)
      content.append(
        el(
          "p",
          `提交状态待确认${attempt.target?.kind === "problemset" ? " · 题库（不计比赛成绩）" : ""}${attempt.createdAt ? " · " + new Date(attempt.createdAt).toLocaleString() : ""}${attempt.language ? " · " + attempt.language : ""}。尚未取得提交 ID，请刷新本人记录核对；不会自动重发。`,
        ),
      );
    if (!submissions.length && !uncertainSubmissions.length)
      content.append(el("p", "暂无本人的提交记录。"));
    for (const s of submissions) {
      const row = el("details");
      row.append(
        el(
          "summary",
          `#${s.id} · ${s.target.kind === "contest" ? `比赛 #${s.target.contestId}` : "题库（不计比赛成绩）"} · OJ：${s.result}${s.score !== undefined ? ` · 得分 ${s.score}` : ""}`,
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
  tools.className = "test-toolbar";
  const add = iconButton("plus", "添加用例", createCase);
  add.classList.add("primary-button");
  const undo = iconButton("undo", "撤销删除", () => {
    const c = deleted.pop();
    if (c) {
      binding!.cases.push(c);
      edit();
      render();
    }
  });
  undo.disabled = deleted.length === 0;
  tools.append(
    add,
    iconButton("import", "导入", () => void action("importTestCases")),
    el("span"),
    menu("更多用例操作", [
      iconButton("refresh", "重跑失败用例", () => void action("rerunFailed")),
      undo,
      iconButton(
        "undo",
        "恢复已删官方样例",
        () => void action("restoreDeletedSamples"),
      ),
      iconButton("copy", "复制全部草稿", () =>
        api.postMessage({
          type: "copyDraft",
          text: JSON.stringify(binding?.cases, null, 2),
        }),
      ),
    ]),
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
      card.classList.toggle("case-disabled", !c.enabled);
      edit();
    });
    const enabledLabel = el("label", "启用 ");
    enabledLabel.append(enabled);
    const number = el("span", String(index + 1).padStart(2, "0"));
    number.className = "case-number";
    enabledLabel.className = "enabled-control";
    head.append(
      number,
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
    card.classList.toggle("case-disabled", !c.enabled);
    card.append(head);
    const fields = el("div");
    fields.className = "fields";
    for (const key of ["input", "expected"] as const) {
      const label = el("label");
      label.className = "io-field";
      const caption = el("span", key === "input" ? "输入" : "预期输出");
      caption.className = "field-caption";
      caption.append(
        iconButton(
          "file",
          "在原生编辑器中编辑",
          () =>
            void action(key === "input" ? "editInput" : "editExpected", c.id),
          true,
        ),
      );
      label.append(caption);
      const area = el("textarea");
      area.spellcheck = false;
      area.value = c[key];
      if (key === "input")
        area.placeholder = "留空表示无输入，运行时直接结束输入（EOF）";
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
    const checkLabel = el("label", "校验输出");
    checkLabel.className = "check-control";
    checkLabel.title = "开启且预期内容为空时，表示期望空输出；关闭则仅运行。";
    checkLabel.prepend(check);
    const select = el("select");
    select.setAttribute("aria-label", "输出比较模式");
    for (const [v, t] of [
      ["exact", "精确比较"],
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
    const options = el("div");
    options.className = "case-options";
    options.append(checkLabel, select);
    card.append(options);
    const actions = el("div");
    actions.className = "case-actions";
    const duplicate = () => {
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
    };
    const remove = () => {
      deleted.push(c);
      binding!.cases.splice(index, 1);
      edit();
      render();
    };
    const more = [
      iconButton("up", "上移", () => move(index, -1)),
      iconButton("down", "下移", () => move(index, 1)),
    ];
    if (c.baseline)
      more.push(
        iconButton("undo", "恢复官方版本", () => {
          c.input = c.baseline!.input;
          c.expected = c.baseline!.expected;
          edit();
          render();
        }),
      );
    actions.append(
      iconButton("play", "运行", () => void action("runTestCase", c.id)),
      iconButton("debug", "调试", () => void action("debugTestCase", c.id)),
      el("span"),
      iconButton("copy", "复制用例", duplicate, true),
      iconButton("trash", "删除用例", remove, true),
      menu("更多用例操作", more),
    );
    card.append(actions);
    const r = result?.cases.find((x) => x.id === c.id);
    if (r) {
      const stale =
        sourceStale || configurationStale || dirty || c.revision !== r.revision;
      const verdict = el("div");
      verdict.className = "case-verdict";
      verdict.dataset.status = stale ? "stale" : r.status;
      verdict.append(
        el(
          "strong",
          `${r.status}${stale ? " · 已过期" : ""}   ${r.elapsedMs} ms · 本机`,
        ),
      );
      card.append(verdict);
      const detail = el("details");
      detail.className = "result-detail";
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
    const changed =
      binding?.bindingId !== m.binding.bindingId || root !== m.root;
    binding = m.binding;
    root = m.root;
    html = m.html;
    result = undefined;
    sourceStale = false;
    configurationStale = false;
    if (changed) {
      submissions = [];
      uncertainSubmissions = [];
      submissionStatus = "";
    }
    deleted = [];
    conflict = undefined;
    dirty = false;
    saveError = "";
    if (
      saved?.dirty &&
      saved.bindingId === binding!.bindingId &&
      saved.root === root
    ) {
      const diskBinding = structuredClone(binding!);
      binding!.cases = saved.cases;
      dirty = true;
      if (saved.revision !== binding!.revision) {
        conflict = diskBinding;
        binding!.revision = saved.revision;
        saveError = "恢复草稿与磁盘版本冲突，请复制草稿后重新载入。";
      }
    }
    render();
    api.postMessage({ type: "bindingReady", renderVersion: m.renderVersion });
  } else if (m.type === "saved" && m.requestId === saveRequestId)
    resolveSave?.(m);
  else if (m.type === "saveError" && m.requestId === saveRequestId) {
    if (m.conflict) conflict = m.conflict;
    rejectSave?.(new Error(m.message));
  } else if (
    m.type === "externalCases" &&
    m.bindingId === binding?.bindingId &&
    m.root === root
  ) {
    if (dirty || saving) {
      conflict = m.binding;
      saveError = "发现外部修改，请选择要使用的版本。";
      status();
    } else {
      binding = m.binding;
      render();
    }
  } else if (m.type === "flush")
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
    sourceStale = !!m.sourceStale;
    configurationStale = !!m.configurationStale;
    tab = "tests";
    const pass = result!.cases.filter((x) => x.status === "PASS").length;
    document.querySelector("#summary")!.textContent =
      `样例通过 ${pass}/${result!.cases.length}（本机测量）`;
    if (!dirty && !saving) render();
    else refreshResultState();
  } else if (
    m.type === "resultState" &&
    m.bindingId === binding?.bindingId &&
    m.root === root
  ) {
    if (typeof m.sourceStale === "boolean") sourceStale = m.sourceStale;
    if (typeof m.configurationStale === "boolean")
      configurationStale = m.configurationStale;
    refreshResultState();
  } else if (
    m.type === "submissions" &&
    m.bindingId === binding?.bindingId &&
    m.root === root
  ) {
    submissions = m.submissions;
    uncertainSubmissions = m.uncertain ?? [];
    submissionStatus = m.status ?? "";
    if (m.focus !== false) tab = "submissions";
    if (tab === "submissions") render();
  } else if (m.type === "notice") {
    document.querySelector("#summary")!.textContent = m.text;
  } else if (m.type === "addCase") createCase();
});
render();
api.postMessage({ type: "ready" });
