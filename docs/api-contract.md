# Accoding 学生端接口契约

## 管理端导入补充

比赛导入和同步优先只读访问固定 origin `https://accoding.buaa.edu.cn:4000`。先用 `GET /api/users/me` 确认非匿名会话，再用 `GET /api/contests/{id}` 检查对应比赛的读取权限并取得题面；格式与下文比赛接口一致。不会要求用户拥有编辑比赛权限，也不会依赖全局角色标记或此前其他比赛的权限。管理端失败时回退学生端，取消操作直接终止。

两个 origin 使用独立 CookieJar（管理端从当前会话复制），各自禁止跨 origin 重定向。管理端禁止 POST，提交仍走学生端。2026-09-22 通过真实浏览器会话 transport 运行实际导入适配器，比赛 1306 返回 14 道题、15 组题面样例。

核验：2026-09-22。固定 origin 为 `https://accoding.buaa.edu.cn`。当前浏览器会话角色未证实为普通学生。这里只记录结构；不保存账号、Cookie、CSRF 值、代码或未公开题面。

| 功能 | 方法与路径 | 已观察契约 | 状态 |
|---|---|---|---|
| 登录表单 | GET /user/login | POST 到同一路径；username（email）、password、_csrf；无 action | 只读表单已验证，密码 POST 待验收 |
| 当前用户 | GET /api/users/me | JSON id:number、nickname:string、username:string | 登录态读取验证；非登录待验证 |
| 比赛 | GET /api/contests/{id} | problems[] 中 id、title、description、test_setting（JSON 字符串）、contest_problem_list.order | 977、1306 可读取 |
| 比赛提交 | POST /api/contests/{id}/submissions | application/json，code、lang、排序后的零基 order | 1306 / 10467 真实提交通过 |
| 比赛提交响应 | 同上 | id、result、lang、code_length、created_at、updated_at、creator_id、problem_id、contest_id | ID 8287716，WT |
| 比赛单条结果 | GET /api/contests/{id}/submission/{sid} | 额外 score、time_cost、memory_cost、detail、judge_id | 上述提交 AC，score=1 |
| 比赛本人记录 | GET /api/contests/{id}/submissions | 前端直接使用数组 | 源码确认，客户端再次按 creator_id / problem_id 过滤 |
| 题库详情 | GET /problem/{id}/index | h1.problem-title 位于 .markdown-body；select[name=lang]；form action=./submit | #1 实测；不缓存完整页面 |
| 题库提交 | POST /problem/{id}/submit | 表单字段 _csrf、lang、code | 真实 #1 提交 8287729，302 到 /problem/1/submission 后 200 HTML |
| 题库记录 | GET /problem/{id}/submission | tr 中 submission_idN；用户链接 /user/{id}/index；结果 label | DOM 与轮询源码确认 |
| 题库查询 | GET /submission/getSubmissionApi | query submission_id 为 JSON 字符串数组；响应数组含 id/result/detail/time_cost/memory_cost/score/creator_id | 真实 #1 提交 8287729 查询为 AC，score=1 |

比赛排序必须先按 contest_problem_list.order 排序，再取数组索引；原始 order 不保证连续。提交前重新抓取映射。不存在题目、页面回退到题库列表、题目 h1 缺失都视为失败。

题库列表只展示当前页面可确认归属本人的记录，不自动扫全站历史。无法得到明确新 submission ID 时进入 UnknownOutcome，不用最新一条记录猜成功、不自动重发。

待确认：验证码/SSO、CSRF 生命周期、非登录/过期/课程私有/未开始/结束响应、服务器比较设置语义、题库成功重定向、不同账号权限。mock fixture 是合成数据，不能代替这些实测。

题库详情 `/submission/{id}` 的 `pre > code` 包含服务端注释头（Submission_id、Problem_id）和原始源码。只有从提交前列表中不存在的新 ID，且 creator_id/lang/problem_id 与当前请求一致、剥离已验证注释头后源码逐字一致，才接受列表中的候选。多个完全相同候选仍视为 UnknownOutcome。
