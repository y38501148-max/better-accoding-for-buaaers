# 候选包与公开发布

0.1.0 是开发候选，稳定首发必须完成实施台账中的发布阻断项。

1. Node 22 下 `npm ci`，运行 lint、typecheck、unit、integration、extension。
2. `npm run build`、`npm run check:package`。
3. `npm run package`、`npm run release:checksum`。记录 commit、VS Code/Node/工具链和验收报告。
4. 独立用户/扩展目录安装 VSIX，验证主流程；不得用开发环境成功代替。
5. publisher 注册后，将已验收包上传 Marketplace；上传时不另行重建另一份文件。
6. 商店直达页可安装目标版本并通过干净安装测试后，才标记公开发布完成。

发布身份拟采用用户授权的 muzermat，注册状态以真实管理页面为准。公开仓库名为 better-accoding-for-buaaers，使用已授权的本机 gh 身份。不可用占位 URL 冒充已上线。

内测需要真实使用者与自然日观察，发布观察也不能用一次自动化测试代替。回退采用更高补丁版本，不覆盖同版本包。不要把上传 GitHub VSIX 当成 Marketplace 已上架。
