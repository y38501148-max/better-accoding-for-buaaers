# 测试与验收

所有 unit/integration fixture 均为合成数据。普通 CI 不持有 OJ 凭据，不向生产 OJ 交题。

- `test:unit`：题号/URL/来源、HTML 净化、样例空白、比较模式。
- `test:integration`：真实文件系统原子存储与冲突、mock Cookie/重定向/提交、真实 C/C++ 编译、EOF、超时、输出上限和后代进程清理。
- `test:extension`：独立用户目录，激活/命令、导入、原生编辑器与 Webview、分栏恢复、保留无关编辑器。
- 必須另行人工验证：最新草稿立即运行、删除撤销后重启、跨题异步隔离、登录失效、双来源真实提交、Windows/Linux Debug stdin/断点、用户本机验收和全新商店安装。

最低目标 VS Code 1.96.4，Stable 测试由 `VSCODE_VERSION=stable npm run test:extension` 触发。跨平台 CI 是证据的一部分，不能替代 Windows 实际工具链与 macOS arm64 实机记录。

2026-09-22 本机 macOS arm64：最低 1.96.4 和 Stable 1.138.0 宿主测试通过；独立用户/扩展目录安装 VSIX 并激活包内 dist 通过（`npm run test:package`）。

`npm run test:debug` 在 macOS 的独立扩展目录安装固定版本 CodeLLDB 1.12.3，真实断点验证选定输入、变量值、继续运行输出和会话结束，2026-09-22 已通过。不会使用或修改日常 VS Code 配置。

商店安装验收：发布校验完成后运行 `ACCODING_INSTALL_SOURCE=muzermat.better-accoding-for-buaaers npm run test:package`，使用独立用户/扩展目录从 Marketplace 获取扩展并验证激活、布局与原生用例运行。默认不设置该环境变量时验证本地 VSIX。

2026-10-14 本机 macOS arm64，0.1.9：lint、typecheck、格式检查、41 项 unit 与 115 项 integration 通过；实际编译 C 模板与 Codeforces C++ 多组输入模板，验证旧题补齐且保留已有双语言源码及自定义关联。VS Code 1.96.4 原生宿主及干净 VSIX 安装均验证检测语言选择、取消、未保存源码保存、C/C++ 切换和双栏切题。CodeLLDB 1.12.3 验证语言选择后的 stdin、断点、变量值与继续输出通过。

2026-10-14，0.1.10：58 项 unit 与 116 项 integration、lint、typecheck、包白名单检查通过。登录测试使用合成账号覆盖真实 CSRF/密码 POST 协议、Cookie 过期/损坏/缺失恢复、有效 Cookie 复用、并发合并、仅本次登录、密码错误停止重复尝试、网络失败保留凭据，以及退出/销毁和迟到登录、秘密写入之间的竞态。最低版宿主与干净 VSIX 安装验证通过。原编译测试的 500ms 进程运行预算在本机偶发超时，测试改为复用 processBudget；专门的超时测试和产品默认时限保持不变。未用用户真实密码进行线上登录测试。

0.1.10 云端 CI：提交 `843dc87b1a3936a47837f650fb5a3785750b6f07` 的 Windows、macOS、Linux × VS Code 1.96.4 / Stable 六项均成功：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/38574084090 。本机已安装 0.1.10；CodeLLDB 回归通过。

2026-10-14，0.1.11：58 项单元、116 项集成测试、lint、typecheck、格式及包检查通过。原生宿主新增验证无需运行用例即可通过 C/C++ 命令打开 Codeforces C++ 模板并切回 C，干净 VSIX 安装回归通过。工作台使用原生按钮、aria-pressed、键盘焦点轮廓显示本地语言入口。

0.1.11 云端 CI：提交 `410aab4cbab4a09e5da895d58235ffbc3e98dec3` 的 Windows、macOS、Linux × VS Code 1.96.4 / Stable 六项均成功：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/38577218719 。在独立宿主中真实点击 C++ 按钮，确认右侧 main.cpp、工作台源码路径及 aria-pressed 状态同步更新。

2026-10-14 22:09，Marketplace 0.1.10 已通过校验；独立用户/扩展目录从商店按版本安装成功，运行发布版原生宿主测试通过，包含激活、双栏、C/C++ 选择及取消、源码保存和切题保护。

2026-10-14 22:13，Marketplace 0.1.11 公开上架。`ACCODING_INSTALL_SOURCE=muzermat.better-accoding-for-buaaers@0.1.11 npm run test:package` 通过；独立用户/扩展目录从商店下载 0.1.11，原生宿主验证常驻语言命令、Codeforces C++ 模板、切换回 C、评测选择、取消及草稿保存。商店安装的 extension.js / webview.js / webview.css 与已验证 VSIX 逐字节一致。本机日常 VS Code 确认安装 0.1.11。

2026-10-19，0.1.12：只读核对线上 `/api/users/me`，确认匿名请求返回 HTTP 200、application/json 和空响应体；带有效登录态时返回用户 JSON。修复前，新增空响应回归用例复现了“权限或接口变化”的 protocol 错误；修复后识别为 auth 并进入已有会话恢复流程。58 项单元、129 项集成测试、lint、typecheck、格式、构建及包白名单检查全部通过，VS Code 1.96.4 独立宿主回归通过。合成凭据测试覆盖启动与联网前恢复、登录后继续导入、新 Cookie 持久化及重启复用、未保存凭据时回到手动登录，以及权限拒绝、异常页面不发送密码。未使用真实密码测试线上重新登录。

0.1.12 的独立用户/扩展目录 VSIX 安装与包内原生宿主回归通过，本机日常 VS Code 已从 0.1.11 升级至 0.1.12。安装包 SHA-256：`9b210a69b7125e9e4d8be9c75504f27ea1e2f92d5da84e0af670f6d8b23158ae`。

0.1.12 云端 CI：源码提交 `3dc10b8b7830f182d6f6113407680c492dd79279` 的 Windows、macOS、Linux × VS Code 1.96.4 / Stable 六项全部成功：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/39188823159 。
