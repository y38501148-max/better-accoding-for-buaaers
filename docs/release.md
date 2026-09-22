# 候选包与公开发布

0.1.0 按用户授权作为首个公开版本发布。必要自动化检查和干净安装验证后直接本机安装及上传商店；未覆盖的人工验收项目继续如实记录，不声明已经验证。

1. Node 22 下 `npm ci`，运行 lint、typecheck、unit、integration、extension。
2. `npm run build`、`npm run check:package`。
3. `npm run package`、`npm run release:checksum`。记录 commit、VS Code/Node/工具链和验收报告。
4. 独立用户/扩展目录安装 VSIX，验证主流程；不得用开发环境成功代替。
5. publisher 注册后，将已验收包上传 Marketplace；上传时不另行重建另一份文件。
6. 商店直达页可安装目标版本并通过干净安装测试后，才标记公开发布完成。

发布身份拟采用用户授权的 muzermat，已在真实管理页面确认创建成功，当前账号为 Owner。公开仓库名为 better-accoding-for-buaaers，使用已授权的本机 gh 身份。不可用占位 URL 冒充已上线。

按用户 2026-09-22 的明确修订，取消多人及固定自然日内测门槛，随后用户进一步授权无需等待其验收，制作后直接本机安装及发布；仍完成必要工程检查和全新商店安装验证。回退采用更高补丁版本，不覆盖同版本包。不要把上传 GitHub VSIX 当成 Marketplace 已上架。

## 首次注册和网页发布（最快路径）

1. 打开 https://marketplace.visualstudio.com/manage ，使用 Microsoft 账号登录或注册。
2. 选择 **Create publisher**；ID 填 `muzermat`，Name 可同名。ID 必须唯一，创建后不可修改；若被占用，使用实际 ID 同步修改扩展清单并重新打包。
3. 完成页面要求的联系信息或邮箱验证，再点击 Create。
4. 完成必要检查及干净配置 VSIX 安装后，选择 **New extension → Visual Studio Code**，上传同一份已验收包。网页上传无需先创建命令行 PAT。
5. 等待 Marketplace 处理完成，再验证商店页面及全新安装。处理耗时以平台实际状态为准。

官方依据：https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher 。账号密码和令牌均不应写入聊天或仓库。
