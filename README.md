# Better Accoding For BUAAers

面向北航 Accoding 学生端的非官方 VS Code 助手。左侧固定操作栏与题面，右侧使用 VS Code 原生 C/C++ 编辑器；本地测试卡片可直接编辑。

**当前为 0.1.0 开发候选，尚未在 Marketplace 上架。** 普通学生账号的扩展完整登录流程、跨平台 Debug 和完整内测尚未通过，不能作为正式计分比赛中的稳定工具。详细进度见 [实施台账](docs/implementation-status.md)。

## 本地开发

使用 Node.js 22（至少 22.12）、npm 与本地 C/C++ 工具链。

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
npm run test:extension
```

## 快速开始

1. 打开一个本地文件夹，运行“Accoding: 检查编译环境”。
2. 运行“Accoding: 登录 Accoding”，会话存储在 VS Code SecretStorage，不保存密码。
3. 运行“按题号导入”输入全局题号，或“按比赛导入”输入比赛 ID 并勾选题目；也可粘贴完整学生端 URL。
4. 左侧读题，右侧编辑关联的 main.c / main.cpp。打开无关文件不会静默更换提交源码。
5. 在“测试用例”中修改输入/预期，添加、复制、删除撤销、排序或禁用；保存状态收到扩展确认后才显示“已保存”。点击评测先保存最新草稿。
6. 首次交题选择 OJ 允许语言，此后用相同来源和关联代码交题。自定义用例不会上传到 OJ。

“样例通过”仅代表本地公开/自建用例；远程结果单独显示 `OJ：AC` 等状态。特殊评测或交互题的本地文本比较不代表完整评测。

## 离线与数据

缓存题面、源码与用例可离线使用。当前事务存储位于工作区 `.better-accoding/bindings`，源码位于 `problems` / `contests`；请连同源码一起备份。同步保护源码、本地修改样例、自定义用例和已删除样例。保存冲突时保留草稿，可复制后恢复。

[环境配置](docs/environment.md) · [测试与验收](docs/testing.md) · [隐私](PRIVACY.md) · [安全反馈](SECURITY.md) · [发布流程](docs/release.md)

## 支持状态

| 环境 | 本地 Judge | Debug | 实机验收 |
|---|---|---|---|
| macOS arm64 | C / C++ 自动化通过 | 配置已实现 | 部分完成 |
| Windows x64 | 实现，待验证 | 配置待验证 | 未完成 |
| Linux x64 | 实现，待验证 | 配置待验证 | 未完成 |
| Remote / Web / 虚拟工作区 | 不支持 | 不支持 | 不作承诺 |

本项目独立实现，不包含 CPH 源码，不代表北航或 Accoding 官方。
