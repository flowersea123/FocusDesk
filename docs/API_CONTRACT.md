# 统一 API 与数据模型草案

## 前台页面记录（2026-11-16）

今日任务页一键开始会自动识别当前任务。手动核对某项任务时，`POST /api/v1/recorder` 可以携带 `{"action":"start","taskId":"…"}`。已在录制时用 `{"action":"target","taskId":"…"}` 指定后续采样要核对的任务，传 null 恢复自动匹配。`targetTaskId` 为用户在本次会话指定的核对对象。自动识别结果放在 `observedTaskId` 和 `observedAt`，未匹配时前者为 null，尚未分析画面时两者均为 null。采集时保存任务上下文，切换目标后拍到的画面才采用新目标。

检查点的可选 `readingPosition:{page,total}` 与 `readingDocument` 配套保存。两数为实际页面计数器中的正整数，page 不超过 total，total 最多 100000。项目状态单独返回阅读位置、章节书签与完成项。阅读位置的百分比表示所在页在文档中的位置。

`GET /api/v1/recorder` 只查询能力和状态，不打开屏幕录制权限。对同一路径发送同源 JSON `{"action":"start"}` 或 `{"action":"stop"}` 启停本次本地会话。启动与停止均可重复请求，页面关闭或刷新不改变会话；Hub 退出或系统录制控制停止时结束。Hub 重启回到待机。状态字段为 `state`（idle、starting、recording、stopping、error、unavailable）、`supported`、`message`、`platform`、`sessionStartedAt`、`savedCount` 和 `lastSavedAt`。时间为 UTC ISO 字符串，尚无相应事件时为 null。本机回环与同源写入限制同下。

前台记录沿用检查点和每日回顾。记录源为 automatic，含前台应用的 `appName` 和可选 `pageTitle`。画面可唯一对应任务时填写 `taskId`。未匹配时为 null，不写任务进度或完成项。模型不可用时，`detailSource:"window-title"` 表示内容仅来自系统提供的应用/页面标题。截图只在内存中处理。

## 本机屏幕检查点（2026-11-16）

`POST /api/v1/screen-observation` 接收用户选择的截图与可选任务 ID，返回 AI 摘要、下一步、明确进度的原句和完成项候选。推理在本机运行。图片按请求处理，保存操作仅提交文本。`GET /api/v1/checkpoints` 按采集时间倒序返回最近 12 条已保存的文字记录，可通过 `?limit=N` 请求 1 至 1000 条。有更早记录时响应携带 `hasMore:true`。每条含手动或自动来源，旧记录默认为手动。`POST` 以客户端 UUID 幂等保存，`DELETE` 以 ID 删除。记录与任务数据文件配套存储，容量为 1000 条。接口限定本机，写入要求同源 JSON。

## 网页 AI 建议编辑（2026-11-12）

DailyOverview 1.0 和任务源可选包含 `ai_suggestion` 字符串，支持中文、英文和换行，最多120个UTF-16代码单元，与网页textarea的maxlength一致。空字符串表示清空建议。旧文件缺少此字段时继续有效，旧内容版本哈希兼容。

`PUT /api/v1/daily-overview/ai-suggestion` 接收 `{revision, ai_suggestion}`，成功返回完整DailyOverview。沿用本机同源写权限、409版本冲突、4096字节限制和现有原子文件保存队列。任务、Focus和work_state写入保留建议，导入保留来源中的建议。非法输入返回400 `INVALID_AI_SUGGESTION`。网页预览读取此建议正文，内容由用户手动填写。

状态：本轮用户已授权不等待 B，直接实现本地演示链路；采用现有 `schema_version: "1.0"` DTO，由 Tech Lead 统一维护，前端/固件/本地服务共同使用。此文档是唯一来源，不分设 Mock 与 HTTP 业务模型。下面的本地演示约定取代旧文中对 B 冻结的等待条件；正式产品的长期实现仍可后续演进。

## 当前本地演示服务

### P3 统一设备入口

`firmware/focusdesk_device/focusdesk_device.ino` 将P2配置/NVS与原电子纸任务、专注显示接通。读取已保存Hub origin并请求原 `GET /api/v1/daily-overview`，继续使用现有1.0 DTO及原解析、排版、显示驱动。

- 配置候选验证/保存和队列中的新提交会暂停或取消任务读取；旧配置恢复或新配置保存后自动继续。
- AP配置窗口关闭后STA、任务轮询和专注显示继续运行，设备无需再次进入配置页。
- 正常读取间隔30秒，显示相邻刷新至少60秒，失败退避及最后有效画面保留规则沿用原实现。首次连接或切换Hub会立即安排读取，但仍遵守刷新保护。
- 显示版本由Hub origin与revision共同识别，跨Hub同revision不会误判为已显示。
- 电子纸全刷继续同步执行，期间新配置请求可能排队。HTTP任务的剩余窗口授权仍实时检查，显示完成后继续处理配置/重连。

现有Dashboard、任务/专注业务和Backend API没有新增字段或写入权限变更。P2独立实验入口保留，用于独立配网验证。

### P2 独立设备配置实验

实验目录为 `firmware/experiments/focusdesk_provisioning_poc`。受密码保护的设备AP仅在启动后的10分钟内提供以下接口，Host/Origin和会话令牌沿用P1。这些接口仅属于设备配置页面。

- `GET /api/session` 返回当前令牌及窗口剩余秒数。
- `POST /api/connect` 接受URL编码的 `ssid`、`password`、`hub_url`、`attempt_id`，原始请求最大1024字节。Hub可填 `http://局域网IPv4:端口` 或现有完整 `/api/v1/daily-overview` 地址，存储为HTTP origin。拒绝凭据、查询参数及其他路径。
- 候选配置仅在RAM中尝试。Wi-Fi获得新IP、目标SSID匹配且Hub的 `GET /api/v1/server-info` 返回有效FocusDesk身份后，才提交完整NVS记录。Wi-Fi、Hub或存储失败时保留旧配置并恢复旧Wi-Fi。Hub需在线才能保存修改。
- `GET /api/status` 保留P1字段，并增加 `config: {saved, storage_ready, hub_url}`、`result` 和 `error`。不返回SSID或密码。`result` 为 `none`、`testing`、`saved`、`failed`；它表示最近手动操作的结果，独立于实际Wi-Fi状态。旧网络重连成功不能改变失败候选的结果。
- `state` 增加 `verifying` 和 `saving`，与 `queued`、`connecting` 一起阻止并发新提交。`error` 包括 `WIFI_FAILED`、`HUB_UNREACHABLE`、`HUB_INVALID`、`NVS_SAVE_FAILED`、`STORAGE_UNAVAILABLE`、`SUBNET_CONFLICT`、`SESSION_EXPIRED`。
- 仅 `result: "testing"` 的连接/验证/保存状态阻止新提交。恢复已保存Wi-Fi的后台重连允许用户立即提交替代配置。
- 重启从已确认NVS配置恢复Wi-Fi，断网后周期重试。配置窗口到期关闭AP和页面服务，STA连接与重连继续运行；进行中的未保存候选取消并恢复旧配置。RST重新打开窗口。

Hub继续使用现有只读接口、任务/专注DTO和LAN权限。NVS配置记录含版本和校验，写入失败或候选验证失败均不主动删除旧记录。

闪存API存在已落盘后报错的边界。此时重读选择标记，恢复旧配置或已经验证并发布的新配置，页面保留保存错误；候选未经Wi-Fi和Hub验证时不会进入NVS提交。普通NVS记录为明文，源码没有启用Flash/NVS加密。Core3.3.12在setup之前可能针对满页/不兼容的默认NVS分区自动格式化，这是Core初始化的既有行为，当前实验的双槽保护不覆盖该分区级初始化边界。

M1 安装版复用全部现有 HTTP 路径、1.0 JSON/Content-Length、4KiB限制和本机写/LAN只读策略，没有新增迁移HTTP接口。旧数据导入仅通过本用户原生文件选择和父子进程 IPC，预览不写入，明确确认后同队列备份/原子替换。安装版通过既有 `--data` 和新增的内部 CLI `--config` 选择外置用户文件；详见 `DESKTOP_LIFECYCLE.md`。

LAN-1 只新增服务连接信息，不变更任务/专注 DTO 和本机写权限：

- `GET/HEAD /api/v1/server-info`：返回 `{ service: "FocusDesk", port, listen_host, local_url, connection_url, addresses }`。local_url 为服务电脑的本机 Dashboard URL，connection_url 为该电脑本机连接说明页 `/connect`；只绑定单一 LAN IP 时两者为 null。addresses 是当前可用 IPv4 数组，每项 `{ interface, address, dashboard_url, device_api_url }`，端口取实际监听端口；回环/APIPA/未指定/多播地址排除，常见虚拟网卡排后，多个网卡全部列出，由用户按设备所在网络选择。只绑定回环时 addresses 为空，只绑定特定 LAN IP 时仅列该地址。每次请求重新识别，不持久化 IP，不返回凭据或任务。
- `GET/HEAD /connect`：独立连接说明页，不修改现有 Dashboard，显示电脑操作入口和可复制的 ESP32 API 地址；刷新即可识别 IP 变化。连接信息读取无设备回执，不声称候选 IP 能穿过防火墙或 AP 隔离。
- 默认 Windows 启动监听 `0.0.0.0:8787`，本机 Dashboard 用 `http://127.0.0.1:8787/`；LAN 设备可读 Dashboard 和原任务 API，PUT 仍严格要求本机同源。端口从可编辑的根 `focusdesk.config.json` 或现有 CLI 参数读取，CLI 优先；IP 不写死在 Dashboard 构建中。

最新扩展：用户已同意网页任务编辑和固定 25 分钟 Focus Mode，增加对应写入接口及可选 focus 字段，读取模型保持兼容 1.0。任务编辑兼容旧设备，专注页需新版固件。当前继续英文任务，不实现中文版本。

## 网页任务保存接口

`PUT /api/v1/daily-overview/tasks`，请求 `application/json; charset=utf-8`，最多 4096 原始 UTF-8 字节：

```json
{
  "revision": "revision-from-current-response",
  "tasks": [
    { "id": "task-001", "title": "Review today's plan", "status": "done", "due_at": null }
  ]
}
```

- 请求只接受 `revision` 与 `tasks`；沿用 Task 字段/ID/状态/必填 due_at，支持 0–10 条任务，标题为 1–40 个可打印 ASCII 字符且非全空白。新任务由网页生成稳定 ID，编辑或完成保留原 ID 与其他字段；移除是明确的用户编辑操作，不自动删已完成任务。
- `revision` 必须等于服务当前有效快照。成功返回 `200` 和新的完整 DailyOverview；保存等价任务不重写文件，不推进版本。date/timezone 保留服务文件的当前值，网页不写这些字段。
- 请求来源仅本机 loopback；浏览器 `Origin` 必须与请求的 `http://Host` 同源，不提供跨域写入。用户在 `http://127.0.0.1:8787/` 编辑；其他局域网客户端/ESP32 保持读取能力，不增加设备写入。GET/HEAD 原有行为保持。
- 缺失/不匹配 Origin、非本机请求或非 loopback/localhost Host `403`；非 JSON `415`；超限 body `413`；非法数据 `400`；版本不符 `409 / REVISION_CONFLICT`；上传超过 5 秒 `408`，读取源或保存失败 `503`。错误结构沿用 `{error:{code,message}}`。接口拒绝请求时不改文件。
- 写入在服务内部串行化，比较版本后将完整合法任务源写入同目录唯一临时文件，再原子 rename 替换；失败不先删原文件，并清理自己的临时文件。并发两个相同 base revision 的写入最多一个成功。任务文件保存后设备仍按原轮询/刷新间隔读取，无需重新烧录。
- 网页保存中避免重复提交和旧轮询覆盖；仅应用服务返回的成功快照。失败保留编辑草稿和旧的有效数据，冲突提示重新读取后检查，不自动覆盖别处更新。Mock 模式保持只读，不修改共享 fixture。

- `GET /api/v1/daily-overview` 返回下述 DailyOverview；`HEAD` 返回相同响应头、无响应体。默认端口 8787，LAN 启动默认监听 0.0.0.0，根配置可改；项目根 `npm start` 仍显式使用 127.0.0.1 供仅本机使用。CLI 覆盖配置。
- 单一可编辑任务源是 `backend/data/tasks.json`，包含 `date`、`timezone`、`tasks` 和可选 `focus`；网页通过保存 API 原子更新此文件，也可手动编辑；服务每次读取验证后发布。没有数据库或另一套 Hub。
- 服务为任务源的规范化内容生成稳定内容哈希 `revision`，读请求不推进版本；任务/顺序/日期/时区变化才更新版本。`updated_at` 以任务文件修改时间为依据；同进程内只改空白不改变既有有效快照。日期是文件中显式的演示日期，不声称按实时日期自动筛选。
- 服务直接提供 `frontend/dist` 的 Dashboard 和资源，两者同源。Vite 开发模式可保持本地 Mock；独立构建的 Dashboard 默认读取同源 API，仍可用明确环境变量覆盖。
- 本轮联网设备只使用其内置字库支持的可打印 ASCII 标题（1–40 字符，含普通空格）。任务源不支持的标题返回 `503` / `UNSUPPORTED_DEVICE_TEXT`，避免网页已更新但设备静默丢字；这是一条当前演示的显示能力限制，不改变通用 DTO 的 UTF-8 模型。共享 `device-demo.json` 提供对应英文合成样例，原中文 fixtures 保留供浏览器测试。
- 当前演示 profile 的时区只接受 `Asia/Shanghai` 或 `UTC`；其他值返回 `503` / `UNSUPPORTED_DEVICE_TIMEZONE`，便于设备严格校验而不额外引入时区数据库。通用 DTO 的 IANA 模型保持不变。
- 非法/超限/不可读文件返回 `503`、结构化错误；成功 API 设置 `Cache-Control: no-store`、`Content-Length`、UTF-8 JSON，不使用压缩或分块响应。当前 ESP32 传输实现可依赖这个明确的 Content-Length。
- 网页使用 HTTP 轮询显示同一快照；设备成功显示后才推进已显示 revision，网络/解析失败不发起刷新。建议轮询 30 秒，电子纸刷新尝试之间至少 60 秒（保守演示值，不声称是厂商最小间隔），失败退避最高 5 分钟；显示失败后状态未知，恢复不能仅因 revision 与历史成功版本相同而跳过。
- 本轮没有设备回执；网页不会仅凭 API 成功显示“设备在线/已同步”。实际板卡更新仍以用户观察和串口标识验收。

## 最小读取接口

`GET /api/v1/daily-overview` 返回 `200 application/json; charset=utf-8`。无查询参数，本地演示返回任务文件显式指定日期的快照。当前不自动按真实今天筛选任务，不定义提醒或设备回执接口。

```json
{
  "schema_version": "1.0",
  "revision": "demo-001",
  "date": "2026-11-02",
  "timezone": "Asia/Shanghai",
  "updated_at": "2026-11-02T02:00:00Z",
  "tasks": [
    {
      "id": "task-001",
      "title": "Review today's plan",
      "status": "todo",
      "due_at": null
    },
    {
      "id": "task-002",
      "title": "Run display demo",
      "status": "done",
      "due_at": "2026-11-02T07:00:00Z"
    }
  ]
}
```

以上为合成演示数据。当前联网演示先使用英文；中文 fixtures 仍供浏览器验证，中文产品显示需另行落实字库支持，不静默替换或删除文字。

本轮 Dashboard 与 API 同源提供，无需浏览器跨域。ESP32 地址必须使用电脑局域网 IPv4，不能填电脑的 localhost。若显式在 Vite 开发环境跨端口接入，则使用已配置代理或服务允许的开发 origin；实际 origin 能读取才算通过。

## DailyOverview 模型

| 字段 | 类型/草案约束 | 语义 |
| --- | --- | --- |
| `schema_version` | 必填 string，首版 `1.0` | 未支持的版本拒绝应用；未来兼容规则需先更新本文，不推测兼容 |
| `revision` | 必填 string，1–64 个可打印 ASCII 字符（不含空格/控制符） | 不透明内容版本，不作数值/字典序比较；日期、时区或返回任务字段/顺序变化时更新 |
| `date` | 必填 `YYYY-MM-DD` | 当前任务文件显式指定的数据日期；未来真实任务服务可以将其定义为所配置时区的当天 |
| `timezone` | 必填 IANA 时区名，最多 64 字节 | 当前设备演示 profile 为 `Asia/Shanghai` / `UTC`；设备不实现时区数据库 |
| `updated_at` | 必填 RFC 3339 UTC 时间戳，使用 `Z` | 快照内容最后更新时间；当前文件服务以修改时间为依据并缓存等价快照，只读请求不改变 |
| `tasks` | 必填 Task 数组，可以为空 | 已经由 Backend 选择与排序的今日任务，Web/设备不各自推导归属或重排序 |

不单独加入每次请求变化的 `generated_at`，避免把传输时间误当作内容更新。各消费者可在本地记录最后成功读取时间，但该时间不代表电子纸显示成功。

候选时间戳格式为 `YYYY-MM-DDTHH:mm:ss[.小数秒]Z`，日期须实际存在，秒为 00–59；此 Demo 子集不接受闰秒、无时区或偏移写法。未知字段忽略且不渲染，未知版本整体拒绝。对象校验器返回已知字段副本，不修改输入样例。

## Task 模型

| 字段 | 类型/草案约束 | 语义 |
| --- | --- | --- |
| `id` | 必填 string，1–64 个可打印 ASCII 字符（不含空格/控制符）；数组内唯一 | 稳定任务标识 |
| `title` | 必填非空白 UTF-8 string，最多 40 个 Unicode 码点且不超过 160 UTF-8 字节 | 纯文本；无换行或控制字符；UI 不作为 HTML 执行 |
| `status` | 必填 enum：`todo` / `done` | 第一期仅表示未完成/完成，不引入提醒确认等其他状态 |
| `due_at` | 必填，RFC 3339 UTC string 或 `null` | 截止时间可以不设置；不用于消费者自行判断“今日” |

这是读取 DTO，不规定数据库表。本地演示直接读取指定日期的任务文件，数组顺序即展示顺序；Web/设备不自行排序或过滤已完成任务。后续实现真实今日归属时再明确安排日期与截止日期的区别。

## Demo 容量与文本边界

- 建议第一轮合成任务数为 0–3 条，解码后 JSON body 不超过 4 KiB；这是待硬件验证的 Demo 上限，不是长期产品限制。

2026-11-12 更新：网页任务、共享概览和桌面导入支持最多10条任务，仍受4096字节的请求、源文件及响应限制。旧任务数据继续有效。当前网页预览展示前5条未完成任务，更多任务显示数量提示。历史独立live固件仍使用其原有三任务解析器，当前统一设备使用显示快照接口。
- 首版不分页，不默默截去多出的任务。若实际面板/字体无法完整呈现上述上限，先调整样例或共同修订容量/截断规则及预览，再验收。
- 超出数组/字段/body 上限、无效 UTF-8、缺字段、未知 enum/版本、非法时间戳均视为无效快照，保留上次成功内容并报告。接收缓冲必须有上限。
- 合法 `tasks: []` 应显示无任务；不能用网络失败代替空列表。
- 中文支持、字体范围和换行排版须由 Firmware Engineer 核实。无法显示的字符不能静默删除；当前已授权联网演示使用上述英文样例和明确 profile。像素布局不属于此业务 DTO。

标题禁用 Unicode Cc 控制字符和 Zl/Zp 行/段分隔符；允许 emoji 的合法 ZWJ 等格式字符，拒绝孤立代理码元。HTTP 层须严格 UTF-8 解码并在读取中限制 4 KiB，再调用文本校验器；仅调用对象校验器无法证明原始响应（含空白）的大小，也不能追回先前宽松解码丢失的字节信息。

## 错误与同步语义

`503` 表示源文件暂不可用、无效或不满足设备 profile；`500` 表示未预期内部错误。错误响应不解析为 DailyOverview：

```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Overview temporarily unavailable"
  }
}
```

网络超时、非成功 HTTP、无效快照均不得覆盖最后有效内容。服务设置 `Cache-Control: no-store`，当前不引入 ETag/304。

轮询目标 30 秒、请求/读取超时按具体传输实现有界设置，失败按 30/60/120/240/300 秒退避，成功后恢复正常间隔；处理串行，不产生重叠请求。固件实际超时与刷新间隔见 `docs/firmware/LIVE_DISPLAY.md`，不得将软件计时值描述为波形保证。

设备成功接收后验证完整快照；只有屏幕状态有效且 revision 等于“已成功显示版本”时才跳过刷新。显示失败标记屏幕状态未知，保留最后有效快照和最后成功版本的逻辑记录、不推进成功版本，并受控重试，即使当前 revision 与历史成功版本相同也不能直接跳过恢复。全刷失败后物理画面可能已改变，不能保证仍完整显示旧内容。显示完成后才恢复有效状态并推进已显示版本；跨日由 Backend 更新 date/revision，不由固件筛选任务。

## 冻结、测试与后续演进

`contracts/fixtures/` 提供样例，`contracts/daily-overview.ts` 提供共享类型与运行时校验，测试动态构造缺字段、超限、非法日期、未知版本/状态等无效输入。样例日期固定，Dashboard 必须标注为演示日期而不是冒充实时今日。本轮服务已授权直接采用该模型，后续接口变更继续由 Tech Lead 统一协调。

契约验收覆盖：同源同序、revision 稳定/变化、时区日期、合法空列表、网络/解析失败保留、显示失败状态未知及受控恢复（包括内容回到历史成功 revision）。所有 API 变更必须同时更新本文、fixtures、消费者和相关测试。Reminder/PhysicalEvent 的模型暂不定义，FocusSession 最小模型见下文。

## Focus Mode 增量（FOCUS-1，2026-11-03）

以下扩展同一 1.0 契约，无专注字段的旧快照仍有效，旧设备会忽略新字段；显示专注页需上传新版固件。读取响应新增可选 `focus`，缺失或 null 表示总览，活动值为 `{ "task_id": "任务ID", "started_at": "UTC时间戳", "ends_at": "UTC时间戳" }`。时间戳使用固定毫秒格式 `YYYY-MM-DDTHH:mm:ss.sssZ`。task_id 必须指向本快照的 todo 任务，ends_at 恰为 started_at 后 1500 秒。任务状态仍只有 todo/done；结束专注不完成任务。任务标题从 tasks 读取，不重复存储。

`PUT /api/v1/daily-overview/focus` 与任务保存共用本机同源写策略、4096 字节/超时限制和原子文件事务：

- 开始：`{ "revision": "当前读取版本", "action": "start", "task_id": "未完成任务ID" }`。固定 25 分钟，时间由服务时钟产生；已有专注时返回 409 `FOCUS_ALREADY_ACTIVE`，先退出再重新开始。
- 退出：`{ "revision": "当前读取版本", "action": "stop" }`。无活动专注则幂等返回当前快照。
- 成功返回完整 DailyOverview，错误结构同原接口。旧 revision 返回 409 `REVISION_CONFLICT`；缺失/已完成任务返回 400 `INVALID_FOCUS_UPDATE`；未知操作/多余字段/客户端自设时间或时长也返回 400。

服务每次读取按服务时钟判断到期；活动 focus 到期后响应 focus:null 并改变 revision，后续读取稳定，不按秒改变版本或写文件。任务源可选保存同结构 focus；读取不重写真实文件，已到期记录在下一次写事务时清理。进程重启可恢复未到期专注。修改专注任务标题保留专注，移除或完成该任务时同一原子保存清除专注。任务和专注操作在同一队列串行执行，共用 revision 防止覆盖。

没有设备回执。正常在线时电子纸下次成功轮询（约 30 秒）及刷新保护（60 秒）允许后恢复总览；离线时可能保留已过期专注画面，结束时间是计划时间，不保证此刻仍在专注。浏览器沿用服务轮询，不靠浏览器计时自动修改任务。结束时间按 overview.timezone 显示，独立于文件的演示日期。不加入暂停/自选时长/历史统计/提示音。


## V0.2 work state and Display Snapshot (2026-11-11)

Existing overview schema_version 1.0 and all task/focus routes remain supported. Optional work_state has goal/current_action/next_action, each 0–64 printable ASCII characters. Empty actions derive the first two unfinished tasks. Focus Mode temporarily displays the focused task as current action and its end time, preserving the saved goal/actions. Optional signals contains at most four records with id (1–64 ASCII, no spaces), content (1–96 ASCII), source (1–24 ASCII), created_at (canonical UTC milliseconds), priority normal/action_needed/urgent, status active/acknowledged/ignored/closed. Inputs are manual. Acknowledged/ignored/closed records stay in Hub history and leave the ambient display. Highest priority active signal wins, then newest created_at, then lexical id. Signal changes never mutate tasks or goal.

PUT /api/v1/daily-overview/work-state accepts {revision,work_state,signals} and returns the updated overview. It shares existing same-origin loopback policy, 409 revision conflicts, serialized queue, atomic persistence, 4096-byte limits and desktop import/backup validation. Task/focus writes preserve these extensions. Old files stay valid and keep existing revision hashes until extended. Source normalization includes optional fields only when present.

GET/HEAD /api/v1/display-snapshot returns schema_version display-1, layout_version goal-1, revision, width 400, height 300, commands. Revision combines source revision with layout version, and remains stable for unchanged content. Maximum body 4096 bytes, maximum 64 commands. Commands are arrays [0,x,y,width,height,color] filled rectangle, [1,x,baseline,font,color,text] bitmap text, [2,centerX,centerY,radius,color,filled] diamond. Coordinates are integers, text printable ASCII, font 0=FreeSans9pt7b,1=FreeSansBold9pt7b,2=FreeSansBold18pt7b,3=FreeSans12pt7b,4=FreeSansBold12pt7b. Colors 0 black,1 white,2 yellow,3 red. Renderer starts white, no anti-aliasing. Firmware validates the complete scene before drawing. Unknown schema/layout/commands are rejected and retain last valid frame. No fallback to independent layout.

contracts/display-snapshot.ts owns all layout/text fitting/selection. Backend emits its saved snapshot and Hub computes draft previews through the same function. contracts/display-fonts.ts contains the same Adafruit GFX font bitmaps used by the device. Fonts carry their upstream notices. Hub distinguishes unsaved preview and saved snapshot, and states that preview cannot prove physical delivery. Existing polling and 60-second physical refresh protection continue.

### 2026-11-11 original-photo presentation

The shared presentation now renders the original Daily overview, Current Priority, Today's tasks and progress layout. Priority uses the focused unfinished task during Focus Mode, then the first unfinished task in saved order. All saved tasks remain in the list. Existing work_state and signals continue to be managed by the Hub. Current data provides manual events, so the yellow footer uses the requested ONE THING AT A TIME fallback. The same display-1 schema, goal-1 layout identifier, command arrays and font0–2 glyph mappings apply. The opaque display revision uses goal-1:r1 plus the existing source revision to trigger a redraw of unchanged task data after the Hub presentation update.

### 2026-11-11 FreeSans typography

The requested 12pt UI glyph resources append font3 and font4 to the existing font table. Fonts0–2 retain their original glyph mappings. The normal Daily overview title and priority use Bold12, long priority titles fit through Bold9, task rows use regular9, and the empty-list body uses regular12. Brand, section titles and progress use Bold9. Date, labels and footer use regular9. Main title baseline moves from91 to86 and priority from151 to150 to align the new ink bounds inside the existing section positions. The display revision is goal-1:f1 plus the source revision. Devices consuming these12pt commands require the matching FreeSans firmware update. Task/focus models and endpoints continue their existing contract.

### 2026-11-12 minimal task presentation

The active shared layout places FOCUSDESK and the file date above Today and the completed/total count. The task area shows up to two unfinished tasks. An active focus task takes the first position, followed by the next unfinished task in saved order. Further unfinished tasks are represented by +N more. The priority title uses up to two lines, and the focus caption includes its planned end time in the overview timezone. Empty and fully completed lists have explicit messages.

The yellow AI RECOMMENDATION area currently displays No suggestion yet. because the source model contains manual signals and has no AI recommendation field. Work state and signal records continue through the existing Hub editing flows. The display revision prefix is goal-1:min1:, followed by the source revision. The renderer consumes display-1 / goal-1 commands and the existing Source Sans 3 font indexes 5–9.

### 2026-11-13 device adaptation of the web preview

The active device layout uses FOCUSDESK/date, Tasks/completion count, up to five unfinished tasks in saved order with focus first, and +N more for the remaining unfinished tasks. Every task uses a 16-pixel Nunito face, with the first task in bold. Header sizes are 10–11 pixels and the section title is 17 pixels. The yellow rounded recommendation area renders saved ai_suggestion in up to two 13-pixel lines, honoring line breaks and marking truncation with three dots. Blank suggestions use No suggestion yet. Non-English suggestions display an English-language prompt. Typographic English quotes, dashes and ellipsis are normalized to ASCII.

Display schema display-1, layout goal-1, 4096-byte transport, 64 commands and drawing kinds0–2 continue. Fonts10–17 are NunitoRegular10px, NunitoBold10px, NunitoRegular11px, NunitoBold11px, NunitoRegular13px, NunitoRegular16px, NunitoBold16px, NunitoBold17px. Glyph indexes0–9 retain their existing faces. The opaque revision prefix is goal-1:nun1: plus the source revision. The matching firmware provides the new faces. Rounded checkboxes and the recommendation background are composed from rectangle commands.


### 大任务进度与设备画面

本机 GET /api/v1/project-progress 返回逐个任务的百分比、已完成部分和步骤清单。PUT 使用 revision、taskId 和 plan/pin/unpin 更新清单或选择设备内容。有清单时根据已记录的步骤计数，无清单时仅采用可核对的比例。GET /api/v1/display-snapshot 继续提供标准 400×300 display-1 绘制指令。固定后设备显示大任务完整进度及完成部分，取消固定后恢复今日总览。当前设备字库支持 ASCII，可为自定义步骤提供英文短名。

### 每日回顾与专注时段

本机 GET /api/v1/focus-review?date=YYYY-MM-DD 提供对应日的计时时段、总秒数、观察文字及改进实验。PUT /api/v1/focus-review/experiment 以日期和 revision 保存计划、复查结果。POST /api/v1/focus-review/synthesis 接收日期，调用本机模型总结当日检查点并返回参与生成的数量和引用原文。超过 12 条时沿时间轴取样。原始图像不写入日记，计时仅依据 Hub 记录的专注会话。

每日回顾可返回 `appSessions: [{ appName, from, to, seconds }]`。录制期间，对相邻两次有效采样中同一前台应用累计间隔，以 ISO 时间返回指定日期内的起止时间，秒数保留毫秒精度。切换应用、空帧、停止或重启录制，以及超过 12 秒的采样间隔打断连续性。该数组与 `sessions` 的专注计时独立。旧数据仍可读取，旧截图显示为时间点。返回的观察可包含 `appName` 和 `taskId`，沿用当时的任务关联。私有回顾端点沿用本机访问限制。

工作台与每日回顾在有当日观察时自动请求小结。成功响应中的 `observationRevision` 标识生成时的观察集合，以 SHA-256 校验，避免把旧小结显示为新证据的结论。

### 论文阅读书签

屏幕观察和检查点可携带 readingSection 和 readingDocument，分别表示正文位置与画面中识别出的文档标题。只有章节位置时保留阅读进度候选。GET /api/v1/project-progress 的 statuses[].readingBookmark 提供当前书签以及可确认的上一个章节。PATCH /api/v1/checkpoints 以 id 和 readingSection 幂等确认对应记录，保留最初的手动或自动来源并记录 readingConfirmed。已确认的章节作为当前大任务的完成依据。自动采样核对画面标题、同任务手动审阅过的文档以及画面内容与待办的关系。自动归属只会对有画面依据的任务生效。多个任务都符合时，可结合用户指定的对象或专注任务消除歧义。删除最后一条对应的手动记录后，该文档关联失效。

### 邮件计划日与设备待办

本机 `GET /api/v1/calendar` 返回 `revision`、`today`、`timezone`、`entries`。每项包含稳定 `id`、网页标题 `title`、1–40 个可打印 ASCII 字符的 `deviceTitle`、`plannedDate`、原定的 `dueDate` 与 `dueAt`、`source`、可选的 `sourceTitle` 和 `status`。两个日期字段采用 YYYY-MM-DD。原文只有日期时 `dueAt` 为空，精确时间使用 UTC 字符串。邮件正文和网页标题不进入电子纸绘制指令。

本机 `PUT /api/v1/calendar` 接收 `{ revision, entry }`，entry 不含 status。改期沿用原 `id`。本机 `DELETE /api/v1/calendar` 接收 `{ revision, id }` 并保留移除记录。显式恢复使用 PUT 的顶层 `restore: true`。更新成功返回完整日历；冲突返回 HTTP 409。来源复用邮件导入的稳定标识，重复同步沿用用户选好的日期。日历存储在任务文件旁的 `.calendar.json` 中。

设备仍读取 `/api/v1/display-snapshot`。Hub 根据任务时区和实际时钟，将计划日已到的事项加入未完成清单；状态从 scheduled 变为 published。达到现有任务条数或大小上限时状态为 waiting。今日任务中的勾选和删除也会反映为 done 或 removed。运行中的专注优先展示，固定项目保留原进度，并在底栏显示其他已发布且尚未完成的第一项日历任务和其余数量。网页预览和设备共用同一布局。

今日清单执行「撤销删除」时，任务更新请求可携带可选的 `restoreTaskId`，标明用户明确要放回原清单的事项。普通后台重试沿用原请求。

### 并行 AI 活动与对话

本机每日回顾可含 `aiSessions`。每段保留 `runId,appName,title,from,to,state`。可选字段 `conversationId,conversationTurnId,conversationTitle,userExcerpt,assistantExcerpt` 来自可核对的聊天身份、用户提问与公开答复；两条摘录各不超过 320 个 UTF-16 代码单元。ID 为匿名标识，未辨认来源时允许缺省。时间跨日裁剪、重启断开，状态为 running、finished、interrupted。AI 日志单独限 90 日、4,096 段、16 MiB。不可读时返回 `aiUnavailable:true`，其余回顾仍可访问。

`aiConversationSummaries` 以应用与对话身份构成的分组键返回已生成且与当次消息摘录匹配的摘要。当天多轮在同一行，父轮与后台协作以可核实的根轮次去重。活动时长为各段并集，专注计时独立。旧来源无法关联时按应用展示为未关联的活动集合。

`POST /api/v1/recorder` 支持 `start-ai` 开始仅 AI 模式、`start` 开始常规模式、`stop` 停止。`/api/v1/ai-browser` 仅接受本机扩展来源，并核对当前状态会话。旧扩展的三字段事件仍可用；新版可提交哈希对话与轮次标识、标题和简短消息摘录。设备及局域网接口不提供这些内容。

开始仅 AI 模式的请求体为 `{"action":"start-ai"}`，状态中的 `mode` 为 `ai`；常规录制为 `screen`。扩展源码在 `extensions/chatgpt-activity`，运行 `python3 extensions/package-chatgpt.py` 更新工作台的离线下载包。
