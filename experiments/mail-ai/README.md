# 邮件、截图与 Canvas 作业试用

可以从试读页打开一封 EML，让本机模型总结正文、读取随信图片，并把时间明确的事项加入 FocusDesk 待办。命令行还可按需读取最近 1–10 封 Outlook 邮件，或直接查看指定 Canvas 课程的作业和提交状态。面板和模拟屏从同一个 Hub 读取已保存的任务。

## 先用样例试读

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

打开本机试读页，点「试用示例邮件」，或选择一封自己的 EML 并点「读取邮件」。样例的截止日期是试读当天之后两天。先看摘要、截止事项和引句，展开邮件正文或图片可以核对来源。「加入待办」将核对通过的未来事项写入本机 Hub。Linux 和 macOS 可在已安装程序的终端运行上面的命令，Windows PowerShell 从解压目录运行程序时使用 `.\llama-server.exe`。[打开邮件试读](http://127.0.0.1:5184/) · [模型比较与完整输出](evaluation/RESULTS.md)

## 用命令行读取和写入

在仓库根目录运行以下预览命令。把最后的路径换成从邮箱导出的 `.eml`，就能试读自己的邮件。模型可以同时读取正文和邮件包含的 PNG、JPEG 截图。

```sh
node experiments/mail-ai/cli.mjs eml experiments/mail-ai/evaluation/portfolio.eml
```

预览会显示摘要、英文待办标题、北京时间和用于核对的原句或模型提取文字。加上 `--apply` 后，Hub 自动追加证据充分且仍在将来的事项。仓库示例截止于 **2026-11-16 17:00 北京时间**，该时刻之后仍可预览样例，写入测试请改用未来的截止时间。

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

命令按需执行一次。真实账号接入需要学校或提供方允许该应用获得相应权限。此版使用用户在本机配置的令牌，产品内的 OAuth 登录、自动续签和后台增量同步属于后续集成。Gmail 可以先导出 EML，直接连接 Gmail 需要增加 Gmail API 适配器。[Outlook 只读权限](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread) · [Outlook 邮件 MIME 接口](https://learn.microsoft.com/en-us/graph/outlook-get-mime-message) · [Canvas 作业接口](https://developerdocs.instructure.com/services/canvas/resources/assignments) · [Gmail 接口](https://developers.google.com/workspace/gmail/api/guides/list-messages)

## 截止时间和留存

- 邮件正文里符合规则的完整原句需同时包含任务动作、截止提示、明确日期和时分。程序独立解析原句，与模型提取的北京时间核对。相对日期以有时区的收件时间计算。EML 优先使用最近的 Received 字段，再参考带时区的 Date。邮件缺省时区按北京处理，时区含混会转人工核对。
- 只有日期、多个冲突日期、改期或撤销、图片中的时间、英文标题不符合设备限制等情况会在输出里提示核对。当前试用入口展示原文和原图来源，用户可在现有任务面板手动添加核实后的任务。附件里有图时，正文与图片的要求也需核对。模型完全漏掉的事项仍可能漏报。
- 试读页在内存中解析原信和图片并返回给本机浏览器，待写入的预览凭据保留最多 10 分钟。命令行将摘要和引句输出到用户终端。本版没有建立邮件历史库。已导入项目的英文标题、`due_at` 和稳定 ID 与其他待办一起写入 Hub 本地任务文件。后天到期的项目会跨日、跨重启保留。
- 当前活动列表最多 10 条，显示屏最多展示前 5 条未完成任务。满表时返回“待办列表已满”，再次导入需先腾出空间。同一来源改期会提示核对。手动删除待办后再次导入可能重新创建。无人值守同步应先增加轻量处理记录、删除记录和待导入队列。
- 本阶段沿用一个列表。周、月视图可按 `due_at` 筛选，按项目拆分还需要添加项目归属。历史、计划视图和后台调度不影响这一阶段的收件与验证。

## 输入与测试范围

EML 和 Graph MIME 单封上限 8 MiB。模型单封最多接收 7000 个正文字符和三张 PNG/JPEG。收件入口限制每张 2 MiB、三张合计 4 MiB，超出会报告。网络外链图片、PDF、附带的转发 EML 和其他附件不在本次提取范围，仅存在外链或其他附件的截止事项可能遗漏。

收件、推理和写待办分别调用提供方的只读接口、本机 llama.cpp 和现有 Hub。固定流程可以直接运行。若将来需要向其他 AI 助手开放这些操作，可再提供 MCP 工具接口。[MCP 架构](https://modelcontextprotocol.io/docs/learn/architecture) · [llama.cpp 图文和结构化输出](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

```sh
npm --prefix experiments/mail-ai test
node experiments/mail-ai/evaluation/run.mjs
node experiments/mail-ai/evaluation/run.mjs .cache/mail-second-results.json second
```

第一条验证不需要账号或模型。后两条使用正在运行的真实本地模型，输入是仓库自带的合成邮件和截图。选定输出文件的上级目录需已存在。
