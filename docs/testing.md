# 测试与验收

所有 unit/integration fixture 均为合成数据。普通 CI 不持有 OJ 凭据，不向生产 OJ 交题。

- `test:unit`：题号/URL/来源、HTML 净化、样例空白、比较模式。
- `test:integration`：真实文件系统原子存储与冲突、mock Cookie/重定向/提交、真实 C/C++ 编译、EOF、超时、输出上限和后代进程清理。
- `test:extension`：独立用户目录，激活/命令、导入、原生编辑器与 Webview、分栏恢复、保留无关编辑器。
- 必須另行人工验证：最新草稿立即运行、删除撤销后重启、跨题异步隔离、登录失效、双来源真实提交、Windows/Linux Debug stdin/断点、用户本机验收和全新商店安装。

最低目标 VS Code 1.96.4，Stable 测试由 `VSCODE_VERSION=stable npm run test:extension` 触发。跨平台 CI 是证据的一部分，不能替代 Windows 实际工具链与 macOS arm64 实机记录。

2026-09-22 本机 macOS arm64：最低 1.96.4 和 Stable 1.138.0 宿主测试通过；独立用户/扩展目录安装 VSIX 并激活包内 dist 通过（`npm run test:package`）。

`npm run test:debug` 在 macOS 的独立扩展目录安装固定版本 CodeLLDB 1.12.3，真实断点验证选定输入、变量值、继续运行输出和会话结束，2026-09-22 已通过。不会使用或修改日常 VS Code 配置。
