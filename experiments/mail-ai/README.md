# 邮件、截图与 Canvas 作业试用

可以从试读页打开一封 EML，让本机模型总结正文、读取随信图片，并将邮件或具体行动安排到 FocusDesk 日历。命令行还可按需读取最近 1–10 封 Outlook 邮件，或直接查看指定 Canvas 课程的作业和提交状态。面板和模拟屏从同一个 Hub 读取已保存的任务。

## 连接个人、学校或工作 Outlook

启动 Hub、模型和下节的本机邮件服务，打开 [Outlook 设置页](http://127.0.0.1:5184/)。已有适配所选账户类型的应用时，可直接复用其公开客户端 ID。

1. 在 Microsoft Entra「应用注册」中选择或注册 FocusDesk。个人 Outlook 或 Hotmail 邮箱选择「仅限个人 Microsoft 帐户」，也可以用同时支持组织与个人账号的应用。学校单租户应用选择「仅此组织目录中的帐户」。注册应用的目录决定由谁管理该应用。[微软应用注册说明](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
2. 在应用的「身份验证」中添加「移动和桌面应用程序」平台，登记本机页给出的完整重定向 URI，默认是 `http://localhost:5184/auth/callback`。采用公开客户端的授权码流程与 PKCE。[微软桌面应用配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration)
3. FocusDesk 登录时请求 Microsoft Graph 的 `Mail.Read` 委托权限。个人模式只填「应用程序（客户端）ID」。学校或工作模式使用对应应用的客户端 ID，单租户应用还要填「目录（租户）ID」。组织限制应用注册或同意时，可由管理员处理。[微软 Mail.Read 权限](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread)
4. 点击对应的登录按钮，在微软页面选择要接收邮件的账号并授权。微软将浏览器带回本机页。首次连接建立收件箱起点，之后邮箱服务每分钟读取新增邮件。关闭浏览器标签页后仍会继续，关闭电脑或服务会暂停同步，重启同一服务后从保存的位置继续。[Microsoft Graph 增量读取](https://learn.microsoft.com/en-us/graph/delta-query-messages)
5. 在「最近邮件」查看摘要和每个行动的计划日。明确的截止事项自动安排在截止日，可以通过「保存改期」提前处理。Hub 暂时离线时会重试，模型离线时先排队。读图日期和无法证实的时分会留待核对。「断开连接」停止该账号同步并清除本地授权，已加入 Hub 的待办和该账号的本地同步记录保留。

当前支持 Microsoft 全球云个人 Outlook、学校和工作账号的收件箱。每个账号单独保存进度、摘要和任务处理状态，页面最多显示最近 60 封。原始邮件及附件在读取和推理过程中使用。应用通过 MSAL 管理登录续期；加密令牌缓存绑定本机操作系统凭据库。Linux 需要已解锁且可用的 Secret Service。数据目录可用 `FOCUSDESK_OUTLOOK_DATA_DIR` 指定，默认使用 macOS 的 `~/Library/Application Support/FocusDesk/outlook`、Windows 的 `%LOCALAPPDATA%\FocusDesk\outlook` 或 Linux 的 `$XDG_DATA_HOME/FocusDesk/outlook`（缺省为 `~/.local/share/FocusDesk/outlook`）。

## 启动本机服务与样例试读

使用 Node.js 24 或更新版本。在仓库根目录安装邮件解析依赖，再启动 Hub。Linux、macOS 和 Windows 使用相同的 Node 命令。

```sh
npm --prefix frontend ci
npm --prefix experiments/mail-ai ci
npm run dev
```

在另一个终端启动本地 `llama-server`。试用默认采用 Qwen3.5-2B Q4_K_M。下载同一模型目录的主权重和视觉权重 `mmproj-F16.gguf`，把下面两条路径换成实际位置。Windows 使用 `llama-server.exe`。推理期间使用本机文件。[默认模型的两个 GGUF 文件](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/tree/main) · [运行程序及三平台构建](https://github.com/ggml-org/llama.cpp/releases)

```sh
llama-server --offline --host 127.0.0.1 --port 18187 --alias focusdesk-mail -c 8192 -np 1 --reasoning-budget 0 --no-webui --log-disable -m "Qwen3.5-2B-Q4_K_M.gguf" --mmproj "mmproj-F16.gguf"
```

开发版在仓库根目录下另开终端运行试读页。保持 Hub 和模型服务运行。若本机已启动 Hub 或模型，可直接复用。

```sh
node experiments/mail-ai/trial.mjs
```

打开本机试读页，点「试用示例邮件」，或选择一封自己的 EML 并点「读取邮件」。样例的截止日期是试读当天之后两天。先看摘要、截止事项和引句，展开邮件正文或图片可以核对来源。选择计划日并点「加入日历」，点击「查看这一天」可在 Hub 月历核对。Linux 和 macOS 可在已安装程序的终端运行上面的命令，Windows PowerShell 从解压目录运行程序时使用 `.\llama-server.exe`。[打开邮件试读](http://127.0.0.1:5184/) · [模型比较与完整输出](evaluation/RESULTS.md)

## 用命令行读取和写入

在仓库根目录运行以下预览命令。把最后的路径换成从邮箱导出的 `.eml`，就能试读自己的邮件。模型可以同时读取正文和邮件包含的 PNG、JPEG 截图。

```sh
node experiments/mail-ai/cli.mjs eml experiments/mail-ai/evaluation/portfolio.eml
```

预览会显示摘要、英文待办标题、北京时间和用于核对的原句或模型提取文字。加上 `--apply` 后，Hub 按截止日期安排证据充分且仍在将来的邮件事项。仓库示例截止于 **2026-11-16 17:00 北京时间**，该时刻之后仍可预览样例，写入测试请改用未来的截止时间。

```sh
node experiments/mail-ai/cli.mjs eml experiments/mail-ai/evaluation/portfolio.eml --apply
```

如果正在试验，可先运行 `npm run dev -- --port 8790 --ui-port 5174 --data .cache/mail-trial/tasks.json`，并把 `FOCUSDESK_HUB_URL` 设为 `http://127.0.0.1:8790`，即可在隔离的任务列表查看效果。`FOCUSDESK_MODEL_URL` 可指定另一个本机推理端口，`FOCUSDESK_MODEL_NAME` 可指定模型服务中实际配置的别名。

## 读取收件箱和课程

| 来源 | 配置和运行 | 覆盖范围 |
| --- | --- | --- |
| Outlook / Microsoft 365 | 在本机设置 `FOCUSDESK_GRAPH_TOKEN` 为该用户针对 Microsoft Graph 的 `Mail.Read` 委托访问令牌，然后运行 `node experiments/mail-ai/cli.mjs outlook --limit 5` | 全球云收件箱，按收件时间倒序读取，有上限的分页和 MIME 正文、附件 |
| Canvas | 设置学校的 `FOCUSDESK_CANVAS_ORIGIN` 和自己的 `FOCUSDESK_CANVAS_TOKEN`，运行 `node experiments/mail-ai/cli.mjs canvas --course 123`，把 123 换成所选课程 ID | 请求该课程的作业、对当前用户生效的截止时间和提交状态。命令显示免交、已交和无截止时间的项目 |

两种读取操作都使用 GET。Canvas 的 `--apply` 只向本机 Hub 添加状态明确、尚未提交、仍在将来的作业。没有设备可用英文短标题的作业会提示人工核对。重复运行同一来源时，已有任务保留手动改名和完成状态。邮件里如果有唯一可信的课程作业链接，设置同一个学校地址可以使两种来源生成相同的作业标识。其他邮件按邮件标识及截止原句去重。当前不会仅凭标题合并跨来源事项。

表中的命令按需执行一次。常规 Outlook 连接使用页面登录与后台增量同步。Gmail 可以先导出 EML，直接连接 Gmail 需要增加 Gmail API 适配器。[Outlook 只读权限](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread) · [Outlook 邮件 MIME 接口](https://learn.microsoft.com/en-us/graph/outlook-get-mime-message) · [Canvas 作业接口](https://developerdocs.instructure.com/services/canvas/resources/assignments) · [Gmail 接口](https://developers.google.com/workspace/gmail/api/guides/list-messages)

## 截止时间和留存

- 正文中能核实的行动和截止日可自动入日历。例如「请于本月27日前阅读学生周材料」依带时区的收件日期解析当月，保留日期级截止。原文还给出确切时分时，程序核对模型读数，并将截止时刻换算为 Hub 时区对应的日历日。相对日期和缺省时区沿用北京时间。
- 只有活动日期、多个相互冲突的日期、改期或撤销、图片中的时间等情形供用户核对。未识别到行动的邮件有整封邮件的计划表单，可填写计划日、选填截止日和设备短标题。
- 用户可在同一封邮件下分别安排多项行动。计划日和截止日独立保存。选定的日期到来后，Hub 把任务交给每日清单和电子纸显示。已发布的同源待办改到未来后会从今日撤下。当前清单已满时，日历保留该项并等待空位。
- Outlook 摘要和处理记录按账号保存在本机。EML 原信及图片在内存中解析，试读凭据有效十分钟。邮件计划用稳定来源 ID 写入 Hub，可以在邮件页或工作台日历查看和改期。

## 输入与测试范围

EML 和 Graph MIME 单封上限 8 MiB。模型单封最多接收 7000 个正文字符和三张 PNG/JPEG。收件入口限制每张 2 MiB、三张合计 4 MiB，超出会报告。网络外链图片、PDF、附带的转发 EML 和其他附件不在本次提取范围，仅存在外链或其他附件的截止事项可能遗漏。

收件、推理和写待办分别调用提供方的只读接口、本机 llama.cpp 和现有 Hub。固定流程可以直接运行。若将来需要向其他 AI 助手开放这些操作，可再提供 MCP 工具接口。[MCP 架构](https://modelcontextprotocol.io/docs/learn/architecture) · [llama.cpp 图文和结构化输出](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

```sh
npm --prefix experiments/mail-ai test
node experiments/mail-ai/evaluation/run.mjs
node experiments/mail-ai/evaluation/run.mjs .cache/mail-second-results.json second
```

第一条验证不需要账号或模型。后两条使用正在运行的真实本地模型，输入是仓库自带的合成邮件和截图。选定输出文件的上级目录需已存在。
