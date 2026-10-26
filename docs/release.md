# 候选包与公开发布

发布前完成自动化检查和独立配置安装验证，再将同一份 VSIX 上传商店。记录未覆盖的验收项目。

1. Node 22 下 `npm ci`，运行 lint、typecheck、unit、integration、extension。
2. `npm run build`、`npm run check:package`。
3. `npm run package`、`npm run release:checksum`。记录 commit、VS Code/Node/工具链和验收报告。
4. 独立用户/扩展目录安装 VSIX，验证主流程；不得用开发环境成功代替。
5. publisher 注册后，将已验收包上传 Marketplace；上传时不另行重建另一份文件。
6. 商店直达页可安装目标版本并通过干净安装测试后，才标记公开发布完成。

发布者为 `muzermat`。回退采用更高补丁版本，不覆盖同版本包；GitHub Release 与 Marketplace 的发布状态分别确认。

## 首次注册和网页发布（最快路径）

1. 打开 https://marketplace.visualstudio.com/manage ，使用 Microsoft 账号登录或注册。
2. 选择 **Create publisher**；ID 填 `muzermat`，Name 可同名。ID 必须唯一，创建后不可修改；若被占用，使用实际 ID 同步修改扩展清单并重新打包。
3. 完成页面要求的联系信息或邮箱验证，再点击 Create。
4. 完成必要检查及干净配置 VSIX 安装后，选择 **New extension → Visual Studio Code**，上传同一份已验收包。网页上传无需先创建命令行 PAT。
5. 等待 Marketplace 处理完成，再验证商店页面及全新安装。处理耗时以平台实际状态为准。

官方依据：https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher 。账号密码和令牌均不应写入聊天或仓库。

## 0.1.10 发布记录（2026-10-14）

- 已公开 GitHub 源码、标签与 VSIX： https://github.com/y38501148-max/better-accoding-for-buaaers/releases/tag/v0.1.10 。安装包与本机干净安装验证使用同一文件，本机日常 VS Code 已升级至 0.1.10。
- 六项跨平台 CI 全部通过，提交 `843dc87b1a3936a47837f650fb5a3785750b6f07`。
- 22:00 左右成功上传 Marketplace，随后通过服务端校验；公开商店页显示 0.1.10，并已从商店在独立用户/扩展目录安装 0.1.10，原生宿主回归通过。发布文件 SHA-256：`91a5158760484b5cc2358c5fd6f7d1c0a2b498c9bf61300abcd20aeac873a402`。

## 0.1.11 发布记录（2026-10-14）

- 已公开 GitHub 源码、标签与 VSIX：https://github.com/y38501148-max/better-accoding-for-buaaers/releases/tag/v0.1.11 。本机已安装 0.1.11，增加常驻 C / C++ 源码入口。
- 六项跨平台 CI 与本机干净 VSIX 安装通过；源码提交 `410aab4cbab4a09e5da895d58235ffbc3e98dec3`。
- 22:05 左右成功上传 Marketplace，随后通过服务端校验；公开页面显示 0.1.11，独立用户/扩展目录从商店下载 0.1.11 并运行原生宿主回归通过。发布文件 SHA-256：`eb8c575c0829fe9d8a9afa0d25c8ad4048d91d7b0b992f71eac93b708b10d827`。

## 0.1.12 发布记录（2026-10-19）

- GitHub 源码、标签和 Release 已公开：https://github.com/y38501148-max/better-accoding-for-buaaers/releases/tag/v0.1.12 。源码提交 `3dc10b8b7830f182d6f6113407680c492dd79279`，附带已验收 VSIX 和独立校验文件。
- Windows、macOS、Linux × VS Code 1.96.4 / Stable 六项 CI 全部通过：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/39188823159 。
- Marketplace 已通过校验并公开上架 0.1.12：https://marketplace.visualstudio.com/items?itemName=muzermat.better-accoding-for-buaaers 。独立用户/扩展目录从商店按版本全新安装成功，发布版原生宿主回归通过；商店安装的 extension.js、webview.js 和 webview.css 与已验收 VSIX 逐字节一致。
- 上传文件与本机验收包一致，SHA-256：`9b210a69b7125e9e4d8be9c75504f27ea1e2f92d5da84e0af670f6d8b23158ae`。

## 0.1.13 发布记录（2026-10-26）

- 最新 Codeforces C++ 模板已同步，本机安装、独立 VSIX 安装验证通过。
- GitHub 源码提交 `133fc10bf52138e0c312c5fdd75aa1f16a2718ff`，Release：https://github.com/y38501148-max/better-accoding-for-buaaers/releases/tag/v0.1.13 。
- 六组跨平台 CI 全部通过：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/40253371578 。Marketplace 已完成校验并公开上架。
- VSIX SHA-256：`a1fcaab1aec15aa3cd6875e0768c01ac88901494c554f4ad0415e7fcfa49b477`；GitHub 下载包与已验收包逐字节一致。

## 0.1.14 发布记录（2026-10-26）

- 修复混合反斜杠转义导致的分段函数渲染错误，包含 0.1.13 的模板更新。本机已安装 0.1.14。
- GitHub 源码提交 `5d0bf474c113d505dd1908a2a77e3719afdad58f`，Release：https://github.com/y38501148-max/better-accoding-for-buaaers/releases/tag/v0.1.14 。公开下载的 VSIX 与本地验收包逐字节一致。
- 六组跨平台 CI 全部通过：https://github.com/y38501148-max/better-accoding-for-buaaers/actions/runs/40254024981 。
- Marketplace 09:31 完成校验并公开上架 0.1.14；独立配置从商店按版本全新安装，原生宿主回归通过。商店安装的 extension.js、webview.js 和 webview.css 与已验收 VSIX 逐字节一致。
- VSIX SHA-256：`2d44fd4f000882a0a6a25841f3b1eb7aa6bb4853092ebb80aabe7df475585b6f`。
