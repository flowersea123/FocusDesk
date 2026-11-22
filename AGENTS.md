# FocusDesk 项目协作规范

## Development Scope

FocusDesk includes:
- Windows Hub Dashboard
- Node.js Backend
- ESP32-S3 Firmware
- E-paper Display
- Windows Installer

The user determines the scope of each task.

Do not assume that the current development scope
is permanently limited to UI.

## Development Rules

- 在根目录 `revise` 记录每次修改的内容与实际验证。新功能适配 Linux、macOS、Windows，注明哪些平台已实际执行。
- 先作本地 Git 提交，提交说明列出具体行为变化。推送 GitHub 前由用户确认。

- Follow the user's explicit task instructions.
- Modify only relevant files and modules.
- Prefer minimal changes.
- Preserve existing functionality.
- Do not modify unrelated modules.
- Run only relevant tests.
- Do not scan the entire repository for simple tasks.
- Do not rewrite architecture unless requested.

## 授权与当前阶段

- MAC-DEV-SIM（2026-11-13）：用户选择先完成 Mac 本机开发与电子纸模拟屏，暂不制作原生 Mac 应用。允许 macOS 数据锁、统一开发入口、真实 Hub 显示快照模拟、固件主机像素对照、相关测试与说明；复用现有业务和协议，不改固件、私有配置或已有个人任务，不烧录。入口与验收边界见 `docs/MAC_DEVELOPMENT.md`。

- GITHUB-HANDOFF（2026-11-13）：用户授权清理可确认废弃内容、审查隐私、补齐交接说明、验证当前版本，并上传新建私有GitHub仓库 `flowersea123/FocusDesk`。当前行为和接手范围见根README与 `docs/HANDOFF.md`。后续开发重点包括AI功能与任务展示逻辑，具体实现按产品负责人任务执行。下方各日期条目记录历史阶段范围。

- UI-SOURCE-SANS（2026-11-11）：用户在字体样例后授权直接选择并替换为更美观字体，Tech Lead采用Source Sans 3，保留当前布局及字号层级。允许生成真实GFX单色字形、共享预览资源及配套字体索引，保留旧映射兼容，更新许可/必要测试和完整编译。仅字体与必要文字适配，业务/配网/驱动/Core保持当前范围。构建依赖可放项目缓存，不修改全局工具。设备上传和真机验收由用户执行。

- UI-FREESANS（2026-11-11）：用户授权当前排版的字体、字重与必要间距调整，统一FreeSans9/12及FreeSansBold9/12，空间允许时使用更大FreeSansBold。当前布局分区和业务保留。为同步12pt字形，可在既有显示字体编号后追加资源，既有0–2映射保留，预览/设备/字体校验同时更新。所有文字显式选择FreeSans字形。Core3.3.12固定，Tech Lead整合共享资源及排版，Firmware负责UI字体执行器与主机检查，编译后由用户手动上传。

- UI-RESTORE（2026-11-11）：用户要求以本轮原版真机照片为唯一视觉参考，恢复400×300 Daily overview / Current Priority / Today's tasks / Progress结构，只在原黄色底栏承载真实已有建议，缺省ONE THING AT A TIME。本轮仅显示/UI及相关测试/截图/编译，Backend业务、数据模型、API字段/路径、任务状态推进、配网/NVS/通信和持久化保持现状。Hub保留任务编辑、完整事件列表、设备入口和Focus管理。配色仅黑白黄红，保留既有数据，不生成AI建议。Tech Lead负责共享布局、字体资源和整合，专业角色按TEAM登记分工；烧录/串口由用户操作。

- V0.2-UI（2026-11-11）：用户授权统一 Goal-centered Hub 与 400×300 四色设备 UI，增加可编辑 work_state 和手动 signals，复用任务/专注/原子持久化/revision/配网与刷新保护。共享 Display Snapshot 由单一布局生成器产生，浏览器和统一固件消费相同指令与字体。可增量扩展 API 和测试，Core 3.3.12、驱动/引脚/波形/NVS/private_config 不改。先软件验证再完整编译，不上传、不打开串口。历史 M2 release 目录保持冻结。

- M2-RELEASE（2026-11-07）：用户授权发布工程整理，固定现有Windows安装包与P3固件，检查哈希/许可/敏感信息，新增 `docs/releases/**` 及独立试用交付目录。产品源码、API契约、Core/依赖及NVS格式冻结，禁止烧录/擦除/串口。H1-H6由用户于2026-11-07人工真机确认通过，H7暂缓未执行。发布文档必须区分人工与自动化证据。可整理脱敏对应源码及构建说明；现有固件内置测试AP凭证的分发规则须按用户答复执行，确认前不把该BIN放入公共目录。

- M2-P3-DISPLAY（2026-11-07）：用户授权下一步接通P2配网/NVS和原有Dashboard→电子纸显示，要求恢复此前已可用的任务与专注同步。允许新增统一 `firmware/focusdesk_device` 入口、复用P2生命周期及显示驱动/解析/排版/刷新保护、相关测试及构建记录。保留旧live/static与独立配网入口及私有配置，P2模块可为复用做小幅提取。使用已保存Hub构造原daily-overview读取地址，配置变更失败恢复旧源；同revision跨Hub不得误判为未变，正常轮询30秒和刷新保护60秒保留。Core3.3.12不升级，用户手动上传/串口/真机验收。M1、Dashboard、后端协议与业务逻辑沿用现有实现，不进入自动发现/配对。

- M2-P2-NVS（2026-11-04）：用户授权在独立配网实验中持久化Wi-Fi名称、密码及Hub地址，断电恢复、修改配置与无效候选保护。覆盖P1的RAM-only限制，仅修改实验固件、相关测试/构建脚本和说明；正式live/static、显示引脚、M1与Dashboard保持既有版本。候选先在RAM中试连Wi-Fi并核验现有Hub，成功后以可恢复NVS事务替换，失败保留并恢复旧配置。沿用Core3.3.12及受保护AP，RST打开配置窗口，用户手动上传/断电测试。Tech Lead负责集成及API说明，可将独立存储/页面任务分派给专业角色。

- M2-P1-POC（2026-11-04）：用户已授权最小必要硬件确认及独立配网PoC的实际实现/完整编译。仅新增 `firmware/experiments/focusdesk_provisioning_poc/**`、相关测试/构建脚本/实验说明；原live/static固件、private_config、M1、Dashboard、电子纸引脚及显示链路不改。采用已安装Core3.3.12，WPA2独立随机密码、AP+STA、手机浏览器192.168.4.1、Wi-Fi输入与重连后状态查询；无正式NVS/BLE/mDNS/配对。用户确认板上有BOOT/RST，具体板型及Flash/PSRAM设置未知，不据此指定新GPIO。Agent可仅编译及使用项目局部工具缓存；上传/串口/手机操作由用户手动进行，真机结果不得伪称已通过。此授权取代此前本轮只读审查边界，但仅限独立PoC。

- M1-INSTALL：用户已明确授权实际实施 Inno Setup + 固定 Node.js 24 Windows x64 + 自包含原生托盘启动器。允许外置用户数据/配置/轮转日志、单实例、显式确认的旧数据导入、现有 IPC 扩展、完整构建脚本和实际测试。保持既有任务/Focus/API协议及LAN只读限制，Demo入口保留。禁止改固件/private_config、配网/发现/配对/云/账号。安装或生命周期验收仅用隔离的临时目录和测试数据，不替用户安装到正式个人目录或停止现有服务；可下载构建必需官方运行时/项目局部构建工具，不改全局开发环境。

- LAN-1：用户授权将现有项目整理为可迁移 Windows 电脑的局域网服务；保留 Dashboard、任务和 25 分钟专注逻辑，用户进一步确认本机写入、其他 LAN 设备只读的权限不变。允许补充可移植启动/配置、网卡 IP 自动识别与连接说明页、ESP32 地址重新配置说明、便携服务目录及相关测试。IP 变化采用人工重新填写现有设备服务器地址，安装包/自动配网下一阶段再做。不改真实任务/私有配置，不上传，不自动调整防火墙，不继承参考项目服务。

- 用户已确认新版排版真机通过，并授权最小 Focus Mode：网页选一条未完成任务，开始固定 25 分钟专注；电子纸显示专注任务和结束时间，手动退出或到期后恢复总览。不自动完成任务，不添加暂停、历史统计、提醒、AI 或新后端。沿用单一服务/原子文件保存，专注状态加入现有读取契约；旧无专注字段的数据仍有效。Tech Lead 负责本轮整合；不修改真实任务数据或私有配置、不上传。到期由服务在读取时判定，设备依赖成功轮询同步，保留原刷新保护。

- 最新用户提供参考图，授权将电子纸任务页调整为该视觉风格。当前仍使用英文，按 400×300 适配品牌/日期/大标题/红色重点/任务勾选/进度和黄色下一步提示；重点取第一条未完成任务，下一步取后续未完成任务，不新增业务字段或伪造进行中状态。只调整显示排版及必要测试/预览，API、数据、联网轮询、刷新波形和用户私有配置保持原样；用户手动验证和上传。

- 最新用户已确认不需要中文任务版本，并同意在网页添加、修改和完成英文任务。本轮实现网页任务编辑与保存、必要的任务移除操作、最小写入 API、原子文件持久化、版本冲突保护和测试。沿用现有 1.0 读取 DTO、最多三条任务和已验证联网固件，不修改或上传固件；不得自动覆盖真实任务文件或重置演示数据。此条取代旧阶段“无写入 API/CRUD”的限制，不扩展为数据库/账号/提醒/AI。

- 最新用户指示为“直接也做了吧，不管 B”：授权直接完成本地演示服务、统一任务文件、Dashboard HTTP 接入、ESP32 Wi-Fi/JSON 拉取与版本刷新，不再以 B 尚未开始为阻塞。本轮后端只实现完成 Demo 所需的文件任务源/读取 API/静态页面服务，不扩大到数据库、AI、提醒引擎或产品级用户系统。以下旧阶段对 B 的等待要求在本轮范围内由此条取代。
- 用户负责在 Arduino IDE 中填写本地 Wi-Fi 配置、手动验证/上传及屏幕验收；Agent 可实现代码、安装必要的项目局部依赖、运行测试与仅编译，不打开串口或烧录。保留已完成的静态 sketch，新建独立联网 sketch，沿用原样显示驱动和其 GPL-3.0-only 许可。

- 默认在对话中回答内容请求，不自行扩展为创建文件、修改文件、搭建网页或执行操作；交付形式不清楚时先澄清。
- 第一轮组织与文档已完成。用户最新授权为“先做我们能做的”：允许推进不依赖 B 的共享契约候选/Mock 样例、本地 Dashboard 与相关测试，以及固件构建条件检查和硬件确认清单。
- 本轮采用此前建议的 React + TypeScript + Vite，本地开发和预览；不发布网站、不初始化 Git。后端尚未开始，B 未确认前不另建后端/Mock 服务；面板、许可与接线未确认前不复制驱动、不烧录设备。
- 后续用户已要求参考 Attention Router 的显示方式，并确认继续使用同一块板、同一套屏与接线，使用 Arduino IDE 手动操作。当前授权准备独立最小静态显示程序、保留原许可复用 JD79668 驱动并进行主机测试/仅编译；上传、串口与实物操作由用户手动完成，Agent 不烧录。此测试固件保留 GPL-3.0-only 许可，不替整个 FocusDesk 项目决定发行许可。英文诊断页仅用于硬件验证，不改变中文产品目标，也不算共享任务/完整链路验收。
- 当前阶段与待确认决策见 `docs/PROJECT_STATUS.md`；第一阶段范围见 `docs/DEMO_PLAN.md`。
- 用户明确要求团队协作：由主 Agent 担任 Tech Lead，可为已授权且相互独立的任务委派专业 Subagents。子 Agent 不自行继续委派。

## 产品边界

- 面向普通用户逐步产品化：常规启动、连接和日常使用应尽量通过清楚的界面与引导完成；安装、服务器地址和设备配置逐步转为用户可理解的流程，技术诊断集中在设置/帮助中。每阶段保留既有功能与数据行为，明确临时人工步骤；本轮之后再推进 Windows 安装包与自动配网。

- FocusDesk 是独立的低干扰个人注意力接口，产品方向为 Daily Overview、Focus Mode、Task & Reminder、Physical Interaction。
- 五周优先完成 Web Dashboard → Backend → ESP32-S3 → JD79668 电子纸显示的简单 Demo。
- Attention Router 只读参考目录为 `E:/attention-router-s3-jd79668`。不继承其 Web Console、Hub、API、Scene 或业务架构，不修改该项目。
- 初始Demo阶段排除AI、运行时Multi-Agent、复杂提醒引擎、多租户和连接器。后续交接已将AI列为开发方向，按产品负责人最新任务确定范围。开发团队的多Agent协作属于开发流程。
- 初始计划由成员 B 负责 Backend；最新用户已明确授权本轮 Codex 直接实现本地演示后端，无需等待 B。保持一个统一后端和契约，后续协作以最新用户指示为准。

## 角色与文件所有权

以下是协作规则，不是操作系统级沙箱。所有 Agent 仍继承父会话权限。目录可能尚未创建；列表不构成开始实现的授权。

| 角色 | 默认可修改范围（开发获准且任务分配后） | 责任边界 |
| --- | --- | --- |
| Tech Lead（主 Agent） | 根文档、`AGENTS.md`、`.codex/agents/**`、`docs/*.md`、`contracts/**`、`tests/integration/**`、根构建配置 | 架构、分配、契约、验收、最终整合；修改模块内部也先协调 |
| Frontend Developer | `frontend/**`、`docs/frontend/**` | Dashboard、交互、内容预览、前端自身测试 |
| Firmware Engineer | `firmware/**`、`tests/firmware/**`、`docs/firmware/**` | ESP32-S3、显示驱动、通信、硬件记录与固件验证 |
| Backend Architect | 本轮 `backend/**`、`docs/backend/**`；其他共享文件须 Tech Lead 分配 | 直接实现单一本地演示服务、文件任务源、HTTP 与自身测试，不另建并行架构 |

共享接口和数据模型规范为 `docs/API_CONTRACT.md`，共享fixtures由Tech Lead在 `contracts/fixtures/` 统一维护。联调范围由产品负责人与Tech Lead确定。仓库协作细则见本文件和 `docs/TEAM.md`，`.codex/agents/*.toml` 为维护者本地可选配置。

## 协作协议

1. Tech Lead 下发任务单：任务 ID、目的、输入、允许修改的确切路径、依赖、验收、当前阶段限制。
2. 动手前，Agent 报告拟修改文件。Tech Lead 维护 `docs/TEAM.md` 的活动文件登记，确保一个文件同一时间只有一位写入者；只读检查可并行。
3. 修改其他模块、共享文档、fixture、根配置前，必须先向 Tech Lead 提出请求。Tech Lead 与该模块负责人协调后，明确移交具体文件；未移交前保持只读。本轮后端代码由 Tech Lead 直接分派。
4. 共享工作区内不得覆盖、回退、清理其他人的改动。文件已由别人修改时停止该文件写入并汇报；不得假定独立分支会隔离共享磁盘。
5. API/字段/枚举/日期/排序/错误语义改变必须先同步接口文档，再协调所有消费者和相关测试；后端实现方确认可实现性。破坏性变更由 Tech Lead 向用户报告。
6. 不确定的架构、依赖、许可、硬件和范围决策由 Tech Lead 汇报用户，不以赶进度为由自行扩大范围。日常文件移交由 Tech Lead 协调，无须反复询问用户。
7. 交付必须包含：任务 ID、结果、修改文件、接口影响、验证命令和实际结果、未解决项。所有代码修改必须通过与行为相关的测试；失败或未执行必须明确说明，不得宣称通过。
8. Tech Lead 审查接口一致性、文件越界、测试证据并完成最终整合。只读评估、编译通过、模拟测试和真机验收分别记录；缺少实物时不能宣称链路完成。
9. 完成任务后释放文件占用并停止，等待 Tech Lead 后续分配。用户要求确认后再开发时，所有 Agent 均遵守该暂停边界。

## 第一阶段验收原则

- 网页和设备消费同一契约、同一 Backend 数据；前端本地 Mock 不能冒充端到端完成。
- 不把“预览内容”或“接口读取成功”称为“真机已同步”。没有设备回执的第一版，通过串口和屏幕实物记录验收。
- 合法空列表要显示无任务；网络/解析失败不发起刷新，保留最后有效快照。显示失败时保留逻辑记录、不推进成功版本，并将实际屏幕状态标为未知，受控重试；不能保证全刷失败后旧画面仍完整。不把异常伪装为空列表。
- 明确 Mock 标识、时区、版本、长文本与中文支持边界；不静默丢任务或丢字。
- 新建根工具、依赖或驱动复用前先落实必要决策；不复制参考项目的私有配置、密钥、Wi-Fi 信息或业务模块。
