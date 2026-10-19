# Better Accoding For BUAAers

北航 Accoding 的非官方 VS Code 扩展。在编辑器里看题、写 C/C++、跑样例和交题，支持按题号或比赛导入，也可以离线看题和测试。

## 安装

在 VS Code 扩展商店搜索 `Better Accoding For BUAAers`，或打开 [Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=muzermat.better-accoding-for-buaaers)安装。也可以从 [GitHub Releases](https://github.com/y38501148-max/better-accoding-for-buaaers/releases) 下载 VSIX，在扩展菜单中选择“从 VSIX 安装”。

需要 VS Code 1.96.4 及以上版本和本地 C/C++ 编译器。编译器与调试器的配置见[环境配置](docs/environment.md)。

## 使用

1. 打开本地文件夹，点击左侧活动栏的 Accoding 图标，运行“Accoding: 检查编译环境”。
2. 点击题单顶部的账号图标登录。可选择记住账号密码并自动登录，或仅本次登录；退出登录会清除保存的凭据。
3. 按题号、比赛 ID 或链接导入题目。导入比赛时可勾选需要的题目。
4. 左侧看题，右侧写代码。点击题面下方的 `C · main.c` 或 `C++ · main.cpp` 切换语言，比赛内可用“切换题目”跳转。C++ 模板默认按多组输入编写，单组输入题需调整 `main()`。
5. 在“测试”中编辑输入和预期输出，也可添加自己的用例。运行样例评测或调试时，选择本次使用的语言。
6. 点击交题，首次提交需选择 OJ 语言。提交使用工作台显示的关联源文件，本地用例不会上传。

本地评测默认忽略行末空格、制表符和输出末尾多余换行，也可改为精确比较或 Token 比较。样例通过不代表 OJ 通过，远程评测结果会单独显示；特殊评测和交互题也不能靠本地文本比较判断。

交题前请确认提交来源，题库提交不计比赛成绩。

导入后的题面、源码和用例保存在工作区，可离线使用。“更新题目”和“同步当前比赛”会更新题面及样例，保留源码和本地用例修改。备份时请保留题目目录和 `.better-accoding`，文件位置与冲突处理见[本地数据说明](docs/storage.md)。

macOS、Windows 和 Linux 支持本地编译与评测，Windows/Linux 的交互调试尚未完成实机验证。不支持 Remote、Web 和虚拟工作区。

## 本地开发

使用 Node.js 22（至少 22.12）、npm 和本地 C/C++ 工具链。

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run test:extension
```

更多检查见[测试说明](docs/testing.md)。

[更新日志](CHANGELOG.md) · [问题反馈](https://github.com/y38501148-max/better-accoding-for-buaaers/issues) · [隐私说明](PRIVACY.md) · [安全反馈](SECURITY.md) · [MIT License](LICENSE)
