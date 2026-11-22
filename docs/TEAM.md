# 团队协作与交付

## 2026-11-18 GitHub 源码交接

前端负责推荐、首页布局与隔离浏览器操作，Linux 验证负责干净安装、全量回归及便携包实启，固件验证负责逐像素对照和 ESP32-S3 目标编译。Tech Lead 负责 macOS 全量回归、真实模型、仓库与导出文件审查、使用说明及整合。验收结果见[本次交接验证](VERIFICATION.md)。

## 2026-11-16 中文任务与添加按钮

任务编辑、任务数据与导入、真实浏览器验证并行开展。Tech Lead 整合设备短名、预览和发布。

## 2026-11-16 对话归组、内容小结和截图内存

Codex 来源负责历史身份匹配及公开消息，浏览器来源负责本地扩展、同一聊天跨标签归组，采样验证负责图像引用检查和 Linux 回归。Tech Lead 负责日志兼容、对话聚合、本机小结、时间轴以及发布核验。

## 2026-11-16 时间段显示与全功能回归

Tech Lead 负责活动时间轴、每日回顾及回归修复整合。浏览器验收、用户流程、跨平台验证分别使用隔离数据。跨平台角色负责安装器参数校验与配网传输测试的主机兼容。结果记录在根目录 revise。

## 2026-11-16 并行 AI 活动与截图内存

Codex 来源、录制生命周期与时段存储、macOS 截图内存实验分别核验。Tech Lead 整合 ChatGPT 浏览器扩展、时间线和使用入口。真实 Chrome 使用隔离配置和合成页面验证，平台覆盖和测量边界见根目录 revise。

## 2026-11-16 邮件日历

邮件角色负责历史邮件及行动项的就地安排和自动导入。Hub 角色负责计划日期、截止日期、去重、日历保存与到日显示。Tech Lead 负责工作台日历、导航与本机交付。已在隔离服务使用合成邮件、真实本机模型和可控日期验收。各平台及设备画面的实测范围见根目录 revise。

## 2026-11-16 今日活动与接续任务

时间轴组件、自动每日小结、隔离浏览器验收分别由三个角色负责。Tech Lead 已整合前台采样时段、日期与任务映射、工作台推荐和本机交付。各平台及模型实测见根目录 revise。

## 2026-11-16 工作台直接操作

任务列表负责逐行增删改、撤销与键盘操作。专注和建议面板负责选中任务的衔接与就地编辑。Tech Lead 负责主导航、响应式布局、页面状态和最终整合。浏览器验收使用临时 Hub 与合成任务。代码已整合，改动和各平台实测范围见根目录 revise。

## 截图与任务进度

视觉识别负责截图归属与页码，任务进度负责阅读位置聚合与设备显示，前端负责进度卡及录制操作。Tech Lead 整合记录契约、会话目标、持久化与端到端验证。本轮在隔离副本使用合成画面验证识别、存储、任务页和设备显示。实现与平台验证范围见根目录 revise。

## 前台页面记录 · 2026-11-16

Tech Lead 负责契约、Hub 会话生命周期、本地模型复用、文字记录、整合与端到端验收。macOS 采集角色负责 `backend/src/foreground-mac/` 与对应测试，桌面平台角色负责 `backend/src/foreground-platform/` 与对应测试。界面角色负责记录页、手动补记、导航与前端回归。验证使用合成页面，系统授权由当前使用者掌握。

本轮已完成整合并释放文件。系统权限、原生取样、模型回放与跨平台实测范围见根 `revise`。

## 2026-11-16 专注工作台迭代

本次完成六轮本地迭代。Tech Lead 整合任务进度、设备绘图、阅读与回顾流程。界面角色负责工作台、打包及浏览器体验验证，视觉识别角色负责截图推理、手审与周期自动记录，复盘角色负责专注时段、改进实验与论文书签。各轮修改与实测结果记录于根 `revise`。

## 2026-11-14 个人 Outlook 连接

认证角色负责个人登录、续期、原学校缓存和认证回归；界面角色负责邮箱类型选择与浏览器验收；待办角色负责 Linux 上的独立软件与增量收件检查。Tech Lead 整合服务接口、在本机验证真实个人账号同步并记录结果。相关文件已释放，验证范围见根 `revise`。

## 2026-11-14 学校 Outlook 一次登录与自动同步

OUTLOOK-SYNC 由 Tech Lead 整合试读页、服务生命周期、说明和端到端检查。邮件角色负责 `outlook-delta.mjs`、`mail-source.mjs` 和增量读取测试。认证角色负责 `outlook-auth.mjs`、凭据库依赖与认证测试。待办角色负责 `outlook-worker.mjs`、增量游标、摘要和写入重试测试。复用本机模型与现有 Hub，测试使用合成数据和隔离待办。

已完成整合。四组文件释放，相关验证与平台执行情况见根 `revise`。Graph 身份验证与邮箱端的正式验收依赖学校应用注册及使用者登录。

## 2026-11-14 邮件 AI 可行性验证

先用独立的 `experiments/mail-ai/` 验证一条链路，再讨论正式产品设置。Tech Lead 负责多模态模型实测、分析器、命令入口、整合、使用说明、`revise` 与三平台验收配置。三项独立交付各自单一写入，使用临时数据和样例。

- 邮件输入：`experiments/mail-ai/mail-source.mjs`、该目录的 `package.json` / `package-lock.json`、`tests/mail-source.test.mjs`。解析 EML、读取 Outlook 收件箱正文及受限图片输入。
- 待办导入：`experiments/mail-ai/task-import.mjs`、`tests/task-import.test.mjs`。复用真实 Hub 的任务接口，处理精确日期、重复邮件、用户编辑、数据冲突和容量。
- Canvas 可行性：`experiments/mail-ai/canvas.mjs`、`tests/canvas.test.mjs`。读取指定课程作业，复用同一作业链接身份；账号和真实课程的验收单独记录。
- 三平台检查由 Canvas 工作完成后的同一角色接手 `.github/workflows/mail-ai.yml`，在可用的本机环境执行隔离测试。Tech Lead 负责记录实际运行平台。
- 本机试读页：收件适配完成后，邮件角色接手 `experiments/mail-ai/{trial.mjs,trial.html,tests/trial.test.mjs}` 和 `mail-source.mjs` 的内存读取入口。使用真实邮件解析器、本机模型、同一套待办核对规则及已有 Hub，提供样例、EML 上传与可选加入待办。

本轮 EMAIL-AI-1 已完成整合，各文件释放。Tech Lead 在根 README 增加试读入口，并归档原句核对、跨平台验证与真实模型逐例结果。macOS/Linux 各 26 项软件测试通过，Chrome 完成 10 项合成邮件交互检查，Windows 矩阵待实际运行。现有 Hub API 与固件协议继续适用。Outlook、Canvas 使用只读适配器，已完成模拟接口验证，真实账户登录及后台同步留待后续集成。

## MAC-DEV-SIM 本机开发与模拟屏（2026-11-13）

用户选择本轮先完成 Mac 本机开发与模拟屏，不制作原生 Mac 安装应用。复用真实 Hub、现有显示快照协议和设备字形；不改固件、任务业务、真实数据或进行设备操作。

- Tech Lead：根 package.json、README、AGENTS.md、docs/MAC_DEVELOPMENT.md、docs/HANDOFF.md、本登记、scripts/dev.mjs、tests/development/**、backend/src/service.ts 及相关 HTTP 路由测试；负责开发启动、页面整合、浏览器验收和最终验证。
- Mac Runtime：backend/src/data-lock.ts、backend/tests/desktop-lock.test.mjs、backend/tests/desktop-server.test.mjs；实现 macOS 单实例数据锁，保留 Windows/Linux 行为，验证进程退出及崩溃恢复。desktop-server 的规范化路径断言经 Tech Lead 移交。
- Simulator UI：frontend/src/DeviceSimulator.tsx、frontend/src/simulator/**、frontend/src/device-simulator.css、对应前端测试，以及 frontend/src/main.tsx、frontend/src/App.tsx、frontend/vite.config.ts；使用真实 /api/v1/display-snapshot 和共享位图渲染，提供快速检查及设备节奏模式、断线保留、读取/显示状态区分。
- Firmware Parity：scripts/test-display-host.mjs、tests/firmware/mac-host/**、docs/firmware/HOST_SIMULATION.md 与本地忽略缓存；准备可在 Mac 重跑的原生固件解析/渲染及像素一致性检查，不修改固件或替代真实硬件验收。

以上文件单一写入，跨范围先协调；测试使用隔离合成数据。当前状态：已完成整合，全部文件释放。契约/后端173项、前端115项、HTTP集成7项、开发生命周期5项共300项测试通过，生产构建通过；原生固件主机1149项检查与21场景逐像素对照通过。浏览器完成12项交互/像素检查，并验证生产页面在真实Hub停止后保留画面、重启后继续同步。未执行ESP32目标编译、烧录或真机验收。

## README-SIMPLIFY 首页精简（2026-11-13）

用户要求简化GitHub首页。Tech Lead接手根README与本登记，将安装体验放在前面，保留源码启动命令和开发入口，链接到现有详细说明。完成本地链接、命令与差异核对后同步GitHub，文档文件释放。

## GITHUB-HANDOFF 交接整理（2026-11-13）

用户授权清理、隐私检查、版本验证和上传新建的私有 FocusDesk 仓库。Tech Lead负责 `.gitignore`、根README与版本、`backend/data/tasks.example.json`、`docs/HANDOFF.md`、`docs/firmware/READINESS.md`及本登记，整合构建和发布。Privacy Audit仅只读检查隐私与许可，不写文件。历史实验模块仍被统一固件引用，保留其目录结构。发布源码使用示例任务数据，本地任务、私有配置和连接卡由Git忽略。回归发现旧测试夹具遗漏新增建议契约，Tech Lead接手 `tests/desktop/{host,native}.test.mjs` 与 `tests/packaging/portable.test.mjs`，补齐夹具文件及预期清单后复测。另接手 `tests/integration/live-demo.test.mjs`，将已移除work_state编辑区的旧断言更新为当前任务与建议保存入口。

本次交接验证完成。270项Node、59项前端、1项隔离真实安装升级卸载通过，1149项固件主机检查与21场景像素比对通过。当前ESP32完整编译与链接成功，Flash1002189字节、静态RAM83004字节，源码及BIN/ELF/MAP哈希核对通过。0.2.0正式交接安装包与34份payload完成隐私和哈希复查。真机上传与显示验收由设备持有人执行。所有文件整合后释放。

## DEVICE-UI-1 网页样式适配设备（2026-11-13）

用户授权设备适配并明确仅需英文。Tech Lead接手共享布局、八份Nunito真实字形、固件字体表、相关测试及编译，原专业子任务已因额度限制停止并释放。新字体编号10–17，保留绘图0–2指令，显示FOCUSDESK、Tasks、五条等字号任务、当前任务加粗、更多计数、专注结束时间和两行英文AI建议。中文建议在设备上提示使用英文，网页保留其编辑与保存能力。目标编译与软件验证完成后由用户烧录验收。

代码已完成并释放。30项相关契约/接口回归、15项前端回归、252项C++主机检查与21场景各120000像素比对通过，网页构建通过。用户明确后续自行验证，ESP32完整编译及上传/实物验收交由用户在Arduino IDE进行。本轮完整目标编译尚未产出成功清单，`.cache/device-latest-build.json`仍对应先前版本，应使用当前源码入口验证上传。

## AI-SUGGESTION 网页编辑（2026-11-12）

用户授权主页新增AI建议填写与修改入口。Tech Lead负责前端输入、读取/保存适配、实时预览及回归；Storage负责可选字段、写接口、原子持久化、导入保留及API说明，文件占用已释放。建议最多120字符，预览两行，支持保存、取消和清空。59项前端、64项保存/导入相关及60项既有契约测试通过，网页构建成功。隔离浏览器确认中文两行输入、显式HTTP保存、磁盘与刷新恢复及手机边界；正式Hub需重新启动加载新接口。

## TASKS-10 网页任务整理（2026-11-12）

用户要求提高真实任务上限并移除预览外字段的编辑入口。Tech Lead负责App、TaskEditor及其前端回归；Capacity负责共享任务常量、容量相关契约/HTTP/导入测试和API说明，文件占用已释放。上限10项，网页移除Goal、Current Action、Next Action和手动Signal编辑区，保留任务与Focus。相关共享/后端/导入测试132项、前端测试52项通过，`npm run build`通过；隔离浏览器验证10项加载、编辑上限、5项预览与更多计数、编辑区移除和390px布局通过。已有数据由现有保存流程保留，源码Hub需重启加载新共享上限。

## UI-ROUND-1 网页预览分工（2026-11-12）

用户将本轮范围收窄到网页预览，设备界面等待后续指令。Tech Lead已撤回本轮共享任务上限和真实任务编辑容量调整，负责 `frontend/src/EpaperPreview.tsx`、对应样式与前端预览测试、网页构建和验证。字体准备仅写 `frontend/public/fonts/` 及其来源许可。新预览采用圆润网页字体、整体较小的字号、同字号任务与当前任务加粗，最多展示5条任务，另提供独立多任务示例以检查空间。真实数据继续使用现有读取/保存流程，当前电子纸布局仍由现有共享快照模块提供。

## UI-MINIMAL-1 当前分工（2026-11-12）

用户确认简洁电子纸布局并授权实施。Tech Lead 独占 `contracts/display-snapshot.ts`、`contracts/tests/display-snapshot.test.mjs`、`frontend/src/FocusPanel.test.tsx`、`docs/API_CONTRACT.md`、本登记及 `.cache/ui-minimal-*` 验证产物。Firmware Reviewer 只读复核绘图协议、字体、版本和预算。布局包含顶部 FOCUSDESK 与日期、Today 与完成数量、最多两条未完成任务、隐藏任务计数、黄色 AI RECOMMENDATION 区域。当前推荐正文采用 No suggestion yet.。验收包含共享/后端/前端测试、网页构建及主机像素比对。

已完成并释放。`npm test` 158项、`npm run test:frontend` 55项、`npm run test:integration` 7项通过，`npm run build` 成功。使用现有MinGW重新编译主机渲染器，190项C++检查通过；15个场景各120000像素与共享栅格一致。Firmware Reviewer独立复核运行11项布局测试和15份原始像素数据通过。共享布局修改显示revision为 `goal-1:min1:` 前缀，设备继续接收 `display-1` / `goal-1` 指令。实际生成并查看正常、长文本、专注、空、全部完成及确认方案预览，产物在 `.cache/ui-minimal-parity/`。首轮沙箱内HTTP/目录链接权限和MinGW启动受限，对应检查经自动审批后在沙箱外复测通过。源码Hub需重新启动以加载布局模块，设备实际显示待用户确认。

## UI-SOURCE-SANS 当前分工（2026-11-11）

Tech Lead独占共享字体生成、Display Snapshot排版字体选择、共享测试、许可和最终构建/截图。Font Tooling负责项目缓存中的真实FreeType/GFX转换工具、可复现转换脚本及新增 `firmware/focusdesk_device/fonts/SourceSans3*.h`、原字体许可。Firmware负责 `display_snapshot.h` 和 `v02_snapshot_test.cpp`，在现有0–4映射后追加5=SourceSans3Regular9、6=Bold9、7=Bold18、8=Regular12、9=Bold12。UI Reviewer只读核验实际点阵和字号，不写业务。角色先报告拟写文件，资源和脚本具体文件由任务单独占，最终交由Tech Lead整合。Core3.3.12固定，私有配置/硬件操作沿用边界。

## UI-FREESANS 当前分工（2026-11-11）

Tech Lead独占 `contracts/display-fonts.ts`、`contracts/display-snapshot.ts`、`contracts/tests/display-snapshot.test.mjs`、`scripts/generate-display-fonts.mjs`、显示字体说明与整合证据。Firmware独占 `firmware/focusdesk_device/display_snapshot.h`、`tests/firmware/v02_snapshot_test.cpp` 和本轮字体固件说明，先报告拟写范围。字体0=FreeSans9、1=Bold9、2=Bold18继续保留，追加3=FreeSans12、4=Bold12。Frontend Review仅只读检查字号/间距及现有预览逻辑。其他业务、网络、配网、私有配置和现有排版分区保持本轮边界。所有文件单一写入者，完整目标编译由Tech Lead在源码冻结后执行。

已完成并释放。字体主机138检查通过，282项主软件与33项配网Node测试通过，15场景各120000像素一致。Core3.3.12完整编译/链接成功，Flash977789、静态RAM83004字节。18份构建源码、5份字体头文件和固件产物核验成功，业务源码11份基线一致。照片示例的图形指令与文字顺序逐项一致，仅标题字号/基线变化。新版字体需配套更新Hub并手动重新烧录统一固件，真机验收待用户操作。

## UI-RESTORE 当前分工（2026-11-11）

唯一视觉输入为用户本轮提供的原版电子纸照片，另有文字验收要求。Tech Lead独占 `contracts/display-snapshot.ts`、`contracts/display-fonts.ts`、共享显示测试、字体生成脚本、截图/对比/整合记录。Frontend独占 `frontend/src/**` 和自身说明，保留数据源/写入Hook业务及原任务/事件/设备/Focus功能，仅排版配色与相应测试。Firmware先只读核验字体/绘图执行器的UI适配范围，跨文件变更先报告。Backend Reviewer只读核验现有数据、建议来源和UI范围，禁止访问真实任务/私有配置。接口与业务源码冻结。各文件单一写入者，最终完整固件构建由Tech Lead执行。

已交付并释放。Frontend完成9份前端源码/测试及一份说明，55项前端测试通过。Firmware只读确认原绘图协议和三档字体可继续使用，Backend只读核对真实建议来源并记录11份业务源码基线。Tech Lead完成共享排版/测试、15场景像素比对、浏览器截图和完整目标编译，额外接收 `scripts/check-display-parity.mjs` 增强场景输入及输出目录参数。固件源码与三档字体资源保持既有哈希，所有文件占用已释放。

## V0.2 UI 实施分工（2026-11-11）

Tech Lead 独占 contracts/**、docs/API_CONTRACT.md、根规范、scripts/generate-display-fonts.mjs、tests/integration/**、构建/截图记录。Backend Architect 独占 backend/src/**、backend/tests/** 和 docs/backend/**，禁止读取或修改真实 backend/data/tasks.json。Frontend Developer 独占 frontend/** 和 docs/frontend/**。Firmware Engineer 独占 firmware/focusdesk_device/**、必要的实验传输路径白名单/预算、tests/firmware/v02*、docs/firmware/V02*。共享字体和布局由 Tech Lead 交付后消费。其余原驱动、旧 live/static、private_config、NVS 与历史 release 文件不分配修改。各角色先汇报拟写文件，越界先协调，共享工作区每文件单一写入者。验收区分软件、主机像素比对、目标编译和用户真机。

整合移交记录

- 固件角色获准扩展 `tests/provisioning/transport.test.mjs`，原34断言保留并增至46，完成后释放。
- 后端角色获准更新 `tests/packaging/portable.test.mjs`、`tests/desktop/{host,native}.test.mjs`、`tests/migration/import-client.test.mjs`、`tests/installer/build.test.mjs` 的契约依赖夹具和相应回归，完成后释放。实际 migration 文件名以交付记录为准。
- Tech Lead 接收 `scripts/import-client.mjs` 的可选字段保留、`scripts/{package-lan,build-installer}.mjs` 的字体许可清单，以及 `scripts/check-display-parity.mjs`。截图保存于 `docs/frontend/assets/`。无业务生命周期重写。
- 三位专业角色完成并释放源码。Frontend 最后补充任务草稿清除失效 Focus 的两项测试后再次释放。Tech Lead 负责最终构建、截图和目标编译，所有测试使用隔离合成数据。

最终整合完成。Tech Lead 接收所有文件，统一事件显示时区并补充时区/同名任务回归，最终软件主回归278通过，配网Node33通过，C++检查及13场景像素比对通过。Core3.3.12完整编译/链接及18份源码/三份固件产物核验成功。源码文件占用已全部释放，真机验收和V0.2正式打包待用户后续阶段执行。

## M2 Release 文件登记

- Release Lead独占 `docs/releases/M2_RELEASE.md`、`M2_RELEASE_MANIFEST.md`、快速入门、脱敏源码/产物目录与版本哈希清单，以及根状态/交接记录。产品源码与测试冻结。
- Windows Audit只读检查现有安装包、对应staging/manifest及既有安装升级卸载报告，输出安全审计摘要到 `.cache/m2-release-audit/`。
- User Guide独占 `docs/releases/USER_GUIDE.md`、`KNOWN_LIMITATIONS.md`，记录预刷硬件、手机配网、同一Hub、刷新节奏及H7限制。
- License/Firmware Audit独占 `docs/releases/THIRD_PARTY_NOTICES.md`、`FIRMWARE_UPLOAD.md`，核对固件许可、对应源码范围和上传前提，所有硬件操作留给交付负责人。

交付目录由主Agent统一生成，专业角色不得复制凭据、真实用户数据或直接发布固件。目录中的固件准入受AP凭证审查及用户答复约束。

用户已批准预刷设备试用模式，公共包排除BIN/ELF/MAP及设备连接卡。Windows Audit核对原安装包与27份payload一致；User Guide及License/Firmware Audit文档已交付并释放。Release Lead已装配71个文件，70条文件校验及ZIP中71份内容核对通过，保留17份公开构建源与17份许可文本。18份原产品源哈希仍一致，安装包未重建。公开目录的已知AP凭证、禁止路径及开发机用户路径扫描均零命中。H1-H6按用户2026-11-07人工确认记录，H7暂缓。SDK/字体来源闭环及新设备凭证/NVS准备列为后续固件或硬件交付事项。

## M2 P3 显示集成文件登记

- Tech Lead独占 `firmware/focusdesk_device/focusdesk_device.ino`、驱动包装源/README、`scripts/build-provisioning-poc.ps1`、统一构建/文档与整合。负责复用P2生命周期和原显示源、最小上传入口及最终构建。
- Firmware/Sync独占新增 `firmware/focusdesk_device/display_sync.h`、`tests/firmware/device_sync_test.cpp`，以及 `firmware/focusdesk_live/live_state.h` 的最小轮询唤醒方法。负责任务/专注显示同步、跨Hub版本隔离、刷新保护与主机回归。
- Firmware/Transport独占实验 `focusdesk_provisioning_poc.ino` 的生命周期命名及有界通用HTTP读取提取，保留原独立入口与Hub验证，新增必要传输测试。不得改同步模块或显示驱动。
- Backend/Review仅只读核对现有接口与回归命令，负责原固件/软件基线运行，所有写入仅限测试缓存。

所有角色跨文件先协调；真实私有配置不读取/打印，设备上传仍由用户操作。

P3已完成软件与目标构建整合并释放全部文件。三个专业角色完成同步、传输和原243项软件/旧固件回归。Tech Lead完整编译/链接通过，18份源码及固件哈希核对一致；Flash987,661字节，静态RAM83,372字节，.bin/.elf/.map及manifest均已核验。详细证据和待真机项目见 `docs/firmware/DEVICE_INTEGRATION.md`。本轮仅编译，未上传/擦除/打开串口，真机显示同步、断电恢复及运行heap由用户验收。

## M2 P2 NVS 文件登记

- Tech Lead独占实验 `focusdesk_provisioning_poc.ino`、`poc_logic.h`、状态机及集成测试、根授权/契约/README/构建记录。负责启动恢复、候选Wi-Fi和Hub验证、失败回退、重连及最终编译。
- Firmware/Storage独占新增 `firmware/experiments/focusdesk_provisioning_poc/config_store.h`、`nvs_config_store.h`、`tests/provisioning/config_store_test.cpp`。负责有版本的完整配置、NVS双槽提交/恢复及故障注入测试，完成后释放。
- Frontend独占实验 `portal_page.h`、`tests/provisioning/portal.test.mjs`。增加Hub地址输入、保存/失败回退状态及页面回归，保持原有测试覆盖。

以上目录均为独立实验；上传、手机操作和断电验收由用户执行。共享接口由Tech Lead先行登记，其他角色跨文件先协调。

P2已完成软件整合并释放全部文件。Frontend交付32项页面回归；Firmware/Storage交付331条存储断言；复核角色额外独占交付 `hub_validation.h` 和 `tests/provisioning/hub_validation_test.cpp`，295条断言通过并释放；Tech Lead补充81条配置状态机断言，原83条输入/状态断言通过。共790条C++断言及32项页面测试。Core3.3.12最终完整编译/链接及9份源码哈希检查通过，日志/manifest见构建记录。已向用户提供手动上传及断电验收步骤，当前没有P2真机结果，不宣称NVS实物验收通过。

## M2 独立配网 PoC 文件登记

- Tech Lead：`firmware/experiments/focusdesk_provisioning_poc/focusdesk_provisioning_poc.ino`、`poc_logic.h`、`private_config.example.h`、`tests/provisioning/**`（页面测试除外）、`scripts/prepare-provisioning-poc.mjs`、根规范及实验说明。负责最小硬件确认、输入安全、异步试连/结果保留、运行内存与整合。
- Firmware/Build：`scripts/build-provisioning-poc.ps1`、`docs/firmware/PROVISIONING_POC_BUILD.md`、`.cache/p1-*` 构建目录。负责固定Core3.3.12的完整链接和编译容量报告，不烧录。
- Frontend Developer：独立PoC的 `portal_page.h` 与 `tests/provisioning/portal.test.mjs`，不得修改正式Dashboard。接口由主Agent提供，完成后释放。

原正式固件、M1及真实凭据不改。测试机型号/按钮由用户实物信息与后续串口信息确认；不做完整电路逆向，不分配额外GPIO。主Agent最终整合；运行heap与手机真机行为等待手动测试，不用编译数字冒充。

Frontend已交付并释放（最终18项页面测试）；只读复核已完成，发现并修复旧连接误报/窗口到期界面及SDK双栈socket误拒。Tech Lead整合后C++83条断言通过；SDK原生受保护AP启动与DHCP顺序已复核。Build角色因额度停止，构建脚本、构建记录及相关缓存独占移交Tech Lead。Tech Lead已完成Core3.3.12完整CLI编译/链接，Flash865,756字节、静态RAM44,364字节，完整产物及哈希记录在构建报告。用户手动确认页面打开、ESP32获取路由器IP及手机断开重连后仍可查询结果，实测heap已记录在实验README；错误密码提示等未确认项如实保留。当前PoC源码及记录已整合并释放，本轮停止追加手动测试。

## M1 实际实施文件分配

基线：2026-11-03 重新运行原有测试，126+40+7=173 全通过。目录无 Git，不初始化/回退已有工作。

- Tech Lead：`launcher/**`、`scripts/desktop-host.mjs`、`scripts/desktop-logs.mjs`、`scripts/desktop-paths.mjs`、`tests/desktop/**`、根配置/文档、`.cache/m1-*`。负责原生 Win32 托盘、bundled Node 宿主、日志、测试和整合。
- Backend Architect：`backend/server.ts`、`backend/src/runtime-options.ts`、`backend/src/overview-loader.ts`、新 `backend/src/data-lock.ts` / `desktop-data.ts`、对应新 backend 测试。负责外部配置、数据锁、初始化与已确认导入/备份；现有HTTP接口不改。
- Firmware Engineer（本轮转交安装构建职责，不改固件）：`installer/**`、`scripts/build-installer.mjs`、`scripts/fetch-runtime.mjs`、`tests/installer/**`。负责官方固定 Node/Inno工具验证、Win32源码编译和Inno安装包构建，先与主Agent确认启动文件接口。
- Frontend Developer：本轮只读现有Dashboard；独占 `scripts/import-client.mjs` 与 `tests/migration/**`，负责原生宿主导入流程适配/验证（与 Backend/Tech Lead 协议协调）。不新增HTTP接口、不重写Dashboard。

所有真实 tasks/private_config 保留。子Agent不得再委派；跨文件先与Tech Lead协调。

M1 最终交付：Backend Architect、Frontend Developer 与本轮承担安装职责的 Firmware Engineer 均已交付并释放文件；Tech Lead 已整合原生启动器、host、日志、构建产物及文档，当前无并行写入者。正式0.1.0安装包已生成且哈希核对通过。最终243项软件测试、构建、原固件主机测试及ESP32源码目标文件检查通过；包含真实隔离0.1.0→0.1.1升级/运行中卸载。未更改现有Dashboard或固件；人工GUI、干净电脑和实物链路验收待用户完成。测试与限制详见 `docs/M1_TEST_REPORT.md`。

Tech Lead 由主 Agent 担任，三位 Subagents 是专业协作角色。初始后端协作计划已由最新用户指示更新：本轮 Backend Architect 直接完成单一本地演示服务，不等待 B。

## 任务输入、输出与文件范围

| 角色 | 输入 | 输出/交付标准 | 默认文件范围 |
| --- | --- | --- | --- |
| Tech Lead | 用户目标、B 的约束、专业评估、测试报告 | 架构建议、任务单、统一契约、文件分配、集成与验收证据；不将未知事项写为事实 | `AGENTS.md`、`README.md`、`.codex/agents/**`、`docs/*.md`、`contracts/**`、`tests/integration/**`、根配置 |
| Frontend Developer | Tech Lead 指定的候选/冻结契约、fixtures、UI 范围、显示约束与未知项 | 今日任务页面、数据源适配、示意预览；加载/空/错误可区分；前端测试及构建结果 | `frontend/**`、`docs/frontend/**` |
| Firmware Engineer | 核实硬件、许可决策、契约、fixtures、B 的地址 | 可重复构建、JSON 解析、轮询去重、显示与失败恢复；区分主机测试/编译/真机证据 | `firmware/**`、`tests/firmware/**`、`docs/firmware/**` |
| Backend Architect | 最新授权、统一契约与设备 profile | 本轮单一本地演示服务/文件任务源/静态页面服务与真实 HTTP 测试；提醒留后续 | `backend/**`、`docs/backend/**`；共享文件经 Tech Lead 协调 |

模块测试随模块负责人。共享 fixtures/接口由 Tech Lead 单独维护，B 参与审核。前端不得为联调自行创建生产后端；固件不得另造设备业务模型。

## 调度与文件交接

任务单最少包含 `ID / 目标 / 输入 / 输出 / 可写路径 / 依赖 / 验收 / 限制`。先确认当前阶段授权，再分配文件。各 Agent 先报告拟写文件；Tech Lead 登记后才开始。

跨模块请求需写清目标文件、原因、接口影响、测试影响。Tech Lead 与原负责人协调，原负责人释放占用，再把具体文件交给新负责人。本轮后端由 Tech Lead 直接分派。即使 Tech Lead 要改模块文件，也执行同样的交接。

并行适用于不同目录的任务和只读评估。共享接口变更由 Tech Lead 串行处理；合并前检查是否有其他 Agent 尚未交付。禁止覆盖或回退他人改动。

Agent 报告格式：`任务 ID → 结果 → 改动文件 → API 影响 → 验证命令/实际结果 → 未解决项 → 释放文件`。超范围事项交回 Tech Lead，不自行追加工作。

## 活动文件登记

| 阶段/任务 | 写入者 | 文件范围 | 状态 |
| --- | --- | --- | --- |
| R0 团队与文档 | Tech Lead | 第一轮新增根文档、`docs/*.md`、`.codex/agents/*.toml` | 第一轮已完成并释放 |
| R0 前端评估 | Frontend Developer | 无，只有只读权限 | 已交付并释放 |
| R0 固件评估 | Firmware Engineer | 无，只有只读权限 | 已交付并释放 |
| R0 后端协作评估 | Backend Architect | 无，只有只读权限 | 已交付并释放 |

用户最新指示“先做我们能做的”，已授权以下不依赖 B 的工作。候选契约用于 Mock，不代表已由 B 确认。

| 当前任务 | 写入者 | 具体文件范围 | 状态 |
| --- | --- | --- | --- |
| TL-M1 共享候选契约/样例/校验 | Tech Lead | `contracts/**`、根 `.gitignore`、`README.md`、`AGENTS.md`、`docs/*.md`、`.codex/agents/*.toml` | 已整合，48 项契约测试通过，文档与配置检查通过，释放 |
| FE-M1 本地 Mock Dashboard | Frontend Developer | `frontend/**`、`docs/frontend/**` | 已交付，17 项测试/构建/本地 HTTP 检查通过，释放 |
| FW-P1 构建与硬件准备 | Firmware Engineer | `docs/firmware/READINESS.md` | 已交付，硬件与工具链未知项已记录，释放 |
| BE-R1 候选契约复核 | Backend Architect | 无，只读 | 已完成共享契约与前端读取逻辑复核，未建立后端 |

| 当前静态屏任务 | 写入者 | 具体文件范围 | 状态 |
| --- | --- | --- | --- |
| FW-S1 Arduino 最小静态显示 | Firmware Engineer | `firmware/focusdesk_static/**`、`firmware/LICENSE`、`firmware/THIRD_PARTY_NOTICES.md`、`tests/firmware/**`、`docs/firmware/STATIC_DISPLAY.md`、`docs/firmware/READINESS.md` | 已交付并释放；主机测试通过，驱动/许可证哈希一致；操作文档移交 Tech Lead |
| TL-S1 整合与编译核查 | Tech Lead | 根规范、根文档、`docs/*.md`、`.gitignore`、`.codex/agents/*.toml`、`.cache/**`；接收两份固件操作文档 | 已记录源码及主机测试；自动目标构建失败，交由用户 IDE 手动验证，未上传 |
| FW-S2 去掉底部颜色测试区 | Firmware Engineer | `firmware/focusdesk_static/static_page.h`、`tests/firmware/static_page_test.cpp`、`docs/firmware/STATIC_DISPLAY.md` | 已交付并释放；色块/标签已删除，其余任务保留；主机编译运行通过（含底部逐像素白底、成功/超时/闲置）；新版未上传 |

FW-S1 输入：用户确认同一套硬件、Arduino IDE，参考 JD79668 驱动接口和 GPIO，已定位的本机工具链。输出：可直接用 IDE 打开的独立 sketch、默认诊断任务页、主机行为测试、手动验证/上传步骤和明确的结果标识。无网络、无原 Hub/API/私有配置。只允许用户手动刷新/重启，不自动连续刷屏。

前端的输入为 `API_CONTRACT.md` 及 Tech Lead 创建的候选 fixtures/validator；输出为可运行本地 Dashboard、状态测试、API 替换入口和启动说明。固件准备的输入为参考硬件事实及本机工具路径；输出为已核实/待确认分开的清单及后续最小验证步骤。二者不依赖 B 的实现。

## 当前联网 Demo 分配（用户已授权直接推进，不等待 B）

| 任务 | 写入者 | 独占路径 | 输入 / 输出 / 验收 |
| --- | --- | --- | --- |
| BE-L1 单一本地演示服务 | Backend Architect | `backend/**`、`docs/backend/**` | 已交付并释放；只读 API/文件任务源/静态服务，23 项真实 HTTP 测试通过 |
| FW-L1 ESP32 联网任务页 | Firmware Engineer | `firmware/focusdesk_live/**`、`tests/firmware/live*`、`docs/firmware/LIVE_DISPLAY.md`、`firmware/THIRD_PARTY_NOTICES.md` | 已交付并释放；实际 parser/state/renderer/ino 五组主机测试通过，不上传；操作文档移交 Tech Lead 记录目标核查 |
| FE-L1 Dashboard HTTP 联调 | Frontend Developer | `frontend/**`、`docs/frontend/**` | 已交付并释放；构建默认HTTP/开发Mock可选，23 项测试/构建通过 |
| TL-L1 契约/整合 | Tech Lead | 根配置、`contracts/**`、`docs/*.md`、`.codex/agents/*.toml`、`tests/integration/**`、`.cache/**`；接收设备操作文档 | 已整合并释放；96 项软件测试、CLI smoke、ESP32 ino/driver 目标文件编译、文档检查通过；未最终链接/上传/真机验收 |

各角色先报告具体文件即可开始已分配路径的工作；越模块请求移交，三位不可同时改共享文件。静态 sketch 保留且只读。当前只有一个本地演示后端；任务保存已获授权，禁止额外新建 Hub、数据库或超范围业务。

## 角色配置使用边界

## 当前网页编辑任务

| 任务 | 写入者 | 独占路径 | 输入 / 输出 / 验收 |
| --- | --- | --- | --- |
| BE-W1 本机保存接口 | Backend Architect | `backend/**`（真实 `backend/data/tasks.json` 禁止自动修改）、`docs/backend/**` | 输入统一写请求；输出版本校验/原子持久化/本机同源写入及真实 HTTP 测试 |
| FE-W1 网页任务编辑 | Frontend Developer | `frontend/**`、`docs/frontend/**` | 输入读取快照与保存 API；输出英文任务添加/编辑/完成/明确移除、保存反馈、冲突与草稿保留；测试/构建通过 |
| FW-WR1 兼容复核 | Firmware Engineer | 只读，无可写文件 | 确认读取 DTO/版本语义/任务容量与现有固件兼容，不修改或上传固件 |
| TL-W1 共享协议与整合 | Tech Lead | `contracts/**`、根规范、`docs/*.md`、`.codex/agents/*.toml`、`tests/integration/**` | 写入模型/文档、整合真实持久化/读取与构建验证，不操作真实任务 |

三位 Subagents 随后因额度限制退出，后端/前端任务已停止并移交 Tech Lead。当前由主 Agent 独占接手 `backend/**`（不自动修改真实 data/tasks.json）、`frontend/**`、对应模块文档与测试；固件仅复核读取兼容，不改代码或上传。没有并行写入者。

最终交付：主 Agent 已完成 BE-W1/FE-W1/TL-W1 并释放占用，FW-WR1 已确认读取格式兼容。共享/后端 100、前端 32、整合 2，共 134 项测试与构建通过。未改或重烧固件，未自动修改真实任务文件。

## 电子纸参考图样式

FW-STYLE1 由 Tech Lead 独占接手（Subagents 已停止，无并行写入者）：`firmware/focusdesk_live/live_page.h`、`tests/firmware/live_test.cpp`、`tests/firmware/live_fakes/Adafruit_GFX.h`、`tests/firmware/live_fakes/Arduino.h`、必要的 `tests/firmware/live_page_preview.cpp`、设备操作文档及 `.cache/` 预览/编译检查。输入为用户参考图和现有 1.0 任务快照；输出为适配 400×300 的英文排版、实际字体边界测试和代码渲染预览。原驱动/波形、网络、后端和私有配置不修改；不上传。

FW-STYLE1 已完成并释放：五组固件主机测试通过；普通/空/全完成/长标题四种帧缓冲预览已检查；真实 ESP32-S3 工具链生成最新 sketch 目标文件（918592 字节）与驱动目标文件（65128 字节）。仅源码编译检查，未最终链接或上传，新样式等待用户 Arduino IDE 验证/上传及真机观察。API 无变化，真实任务数据未修改。

## 最小专注模式

用户随后确认 FW-STYLE1 真机验收通过。FOCUS-1 已获授权，三位原 Subagents 仍处于额度错误状态，由 Tech Lead 独占接手 `contracts/**`、`backend/src/**`、`backend/tests/**`、`frontend/src/**`、`firmware/focusdesk_live/live_model.h` / `live_page.h`、`tests/firmware/live*`、`tests/integration/**`、根规范与模块文档、`.cache/**`；无并行写入者。输入为现有任务/写策略/参考版式；输出为固定 25 分钟开始/退出/到期、统一可选 focus 字段、英文设备页及相关测试。真实任务文件/私有配置/显示驱动只保留，不读取凭据、不上传。接口先更新 `docs/API_CONTRACT.md`，主 Agent 完成软件测试/构建和源码编译后交由用户操作真机。

FOCUS-1 已完成并释放。交付新增可选 focus 数据和本机同源 start/stop、同一原子任务存储、网页控件/预览、固件专注页和操作文档。契约 63、后端 48、前端 40、整合 3，共 154 项软件测试与构建通过；固件主机 parser/state/renderer/实际 sketch 测试通过，真实 ESP32-S3 最新源码和原样驱动目标文件编译成功。未最终链接/上传，专注页和真实 25 分钟测试待用户验收。测试只用临时数据，未修改真实任务/私有配置；驱动/波形/引脚/轮询保护未改。

## Windows 局域网服务

LAN-1 由 Tech Lead 独占修改根启动/打包配置、`scripts/**`、`backend/server.ts`、`backend/src/network-info.ts` / `runtime-options.ts` / `service.ts`、`backend/public/**`、`backend/tests/**`、`tests/integration/**` 与相关文档；Dashboard、任务存储、专注处理、设备固件保持原实现。Backend Architect、Firmware Engineer 如可运行，仅进行只读复核；不读用户私有配置，不与主 Agent 并行写文件。输入现有服务和用户明确保留的本机写策略；输出 Windows 启动/可改端口、实时网卡地址与独立连接页、无开发依赖的便携目录，以及回归/迁移验证。便携目录明确要求目标机器有 Node.js 24+；本阶段不冒充安装包或自动配网。

LAN-PACK 已把 `scripts/package-lan.mjs` 和 `tests/packaging/portable.test.mjs` 独占移交 Frontend Developer；Tech Lead 不写这两份，负责其余启动脚本、构建和集成。Backend/Firmware 两位保持只读，已确认默认应全网卡绑定、IP 变化需要改设备编译期地址并重新上传；不实现自动发现。

LAN-1 / LAN-PACK 已完成整合并释放。Frontend Developer 交付白名单导出及 9 项临时项目测试；Backend Architect 只读复审未发现实质问题；Firmware Engineer 确认原设备配置兼容，未读私有配置。最终契约 63、后端 54、前端 40、便携导出 9、整合 7，共 173 项软件测试通过，构建通过；原静态/联网固件主机测试全部重新编译运行通过。整合实际将源码导出到中文/空格临时目录，从无关 cwd 启动真实 launcher，验证本机编辑/专注/重启恢复、实际 LAN IPv4 读取和拒写、端口占用/非法配置、优雅退出；所有自有服务停止，用户服务未操作。实际导出目录 `.cache/releases/FocusDesk-LAN` 共 19 文件，仅合成任务，无开发依赖或私有配置，目标需 Node.js 24+。尚未由用户在第二台实物电脑和 ESP32 上重新验收；没有制作安装包、自动配网或改变系统防火墙。

`.codex/agents/` 下四份独立 TOML 均包含 `name`、`description`、`developer_instructions`，模型和推理设置沿用父会话。`tech_lead.toml` 用于保留主 Agent 职责，不再额外启动一个 Tech Lead。

文件配置与运行中角色分开记录：本轮三位 Subagents 通过任务提示承担角色；不声称新 TOML 已在本会话热加载。目录边界通过任务单和审查执行，不能提供文件系统级隔离。
