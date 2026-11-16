# FocusDesk

本地 Hub 与 ESP32-S3 电子纸任务屏，支持任务编辑、25 分钟专注、截图检查点和大任务进度。本地开发版包含下列工作台功能；已发布的 Windows 安装版版本为 0.2.0。

## Mac 本机开发与模拟屏

安装 Node.js 24 或以上版本，在仓库根目录执行：

```sh
npm --prefix frontend ci
npm run dev
```

打开 [Dashboard](http://127.0.0.1:5173/) 编辑任务，在 [设备模拟屏](http://127.0.0.1:5173/simulator) 查看保存后的真实显示快照。首次运行只在任务文件不存在时复制示例；已有数据保留。前端修改自动更新，后端或共享排版修改自动重启 Hub 并刷新页面，修改代码前先保存编辑草稿。Ctrl+C 同时停止两个服务。

模拟屏使用设备相同的位图字体和绘图规则，提供快速检查、设备节奏、模拟断网和 PNG 导出。软件模拟不验证物理刷新、无线连接或实际色彩。[开发流程与验证边界](docs/MAC_DEVELOPMENT.md)

## 自动查看今天的工作

打开本机工作台，顶部会按时间排列今日活动。专注任务有计时条。开启「开始记录」后，同一应用的连续前台采样也有时长条，单次屏幕观察以时间点显示。切换、锁屏或长时间没有采样时会断开。点击时间轴可以查看相应的记录。

「接下来做什么」会显示正在计时的任务，或最近一次有依据、可以接着做的工作，并给出记录里的下一步。只有前台应用记录时，可以直接回看该应用的活动。没有相关记录时，工作台按截止时间和清单顺序推荐待办。「今日工作小结」会随记录自动整理，可以展开依据查看原文。模型暂时不可用时也能查看当日记录和任务建议。

## 在任务列表里操作

- 点勾选框完成或重新打开任务。每行右侧提供改名、在下方插入和删除。删除后点「撤销删除」可恢复该任务和原截止时间。
- 列表下方的「添加任务」在末尾新建一项。在任务行聚焦时按 Shift + Enter 可在该行下插入。输入标题后按 Enter 保存，Esc 取消。工作台中也可按 Alt + Shift + N（Mac 为 Option + Shift + N）打开新增输入框。
- 点任务名查看其截图进度。空闲的专注计时器随选择切换，点「开始专注」即可开始。已有计时可在面板中结束。

## 记录当前页面、任务进度与每日回顾

1. 打开工作台，在「今日任务」右侧点「开始记录」，再回到正在工作的应用。网页、PDF、编辑器的画面会随前台切换。Mac 首次使用需按系统提示允许 FocusDesk Capture 录制屏幕。在工作台或 Mac 菜单栏点停止可结束本次记录。[打开任务工作台](http://127.0.0.1:8787/)
2. 最近一次截图能对应某项待办时，相应任务行会显示「截图识别」，下方同步显示它的进度和画面摘要。点其他任务名可以查看其已有进度。候选任务不明确时，观察仍会出现在同一页的时间线。你可以指定要核对的待办，之后也可以恢复自动识别。已完成的步骤按截图中的勾选或完成标记记录。
3. 任务可以叫 `Read paper`。打开论文正文后，进度卡可显示实际文档标题和读到的章节。截图里有明确的阅读器页码时，例如第 6 / 12 页，阅读位置显示 50%。只有章节时显示章节名。已经完成了哪些章节可另外确认。有步骤清单时按已完成项计算任务完成率，阅读位置与完成率分别标明。
4. 编程等任务可在进度卡查看最近一次关联的工作画面。若截图没有任务完成比例或清单证据，卡片保留已有完成进度。点「在电子屏显示此任务」即可查看对应的设备画面。
5. 同页时间线可复核记录，手动补记截图也在这里。「每日回顾」会汇总所选日期的专注计时和屏幕观察。

前台记录是间隔采样的文字时间线。Hub 大约每 4 秒观察一次前台页面。切换应用或标签后会取样，PDF 翻页等画面在连续两次采样中稳定后也会触发识别。视频等持续变化的同一页面最多每 45 秒分析一次，快速闪过的内容可能略过。自动采集的图像仅在内存中处理，磁盘保存文字。已有图片可在「手动补记截图」里添加。

macOS 14 及以上使用菜单栏助手。源码首次构建助手需要 Apple Command Line Tools 和 macOS 14 或更新的 SDK，之后会复用已编译副本。Windows 使用本机 .NET Framework 桌面组件，Linux 使用带 XComposite 和可验证锁屏状态的本机 X11 桌面。Wayland 和无桌面环境会在记录页说明当前能力。各平台的实测范围见根 `revise`。

截图分析与 AI 小结使用本机图文模型，默认地址为 `http://127.0.0.1:18187`，别名为 `focusdesk-mail`，与邮件试读共用。任务文件旁的 `.checkpoints.json`、`.progress.json` 和 `.focus-review.json` 保存相关文字。[模型启动命令](experiments/mail-ai/README.md)

## 本地 AI 邮件试读

个人、学校和工作 Outlook 邮箱支持一次登录、自动读取新邮件，用本机图文模型总结正文与截图，并将能从原文核实的未来 DDL 加入现有待办。可在邮件页配置对应类型的微软应用、查看摘要与同步结果，也可单独试读 EML。命令行也能按需读取 Outlook 收件箱和指定 Canvas 课程的作业。当前提供源码试用入口。[启动与账号配置](experiments/mail-ai/README.md) · [三个小模型的实测结果](experiments/mail-ai/evaluation/RESULTS.md)

## 安装体验

1. 下载 `FocusDesk-Setup.exe`。[安装包](https://github.com/flowersea123/FocusDesk/releases/tag/v0.2.0)
2. 安装后，从桌面或开始菜单打开 FocusDesk。
3. 编辑任务，通过“设备连接”页面查看Hub地址，让电脑与设备连接同一局域网。

电子纸需要配套固件，首次连接按设备说明操作。最新界面的真机验收由设备持有人完成。[设备连接与固件说明](firmware/focusdesk_device/README.md)

## 接手开发

下载或克隆仓库，安装Node.js 24或以上版本，在仓库根目录用PowerShell执行以下命令。

```powershell
npm --prefix frontend ci
if (!(Test-Path backend/data/tasks.json)) {
    Copy-Item backend/data/tasks.example.json backend/data/tasks.json
}
npm run build
npm run demo
```

打开浏览器访问本机Hub。[打开Hub](http://127.0.0.1:8787/)

准备完成后，可双击 `Start FocusDesk.cmd` 启动。修改前端代码后，先运行 `npm run build`，再启动Hub。

## 主要开发位置

| 内容 | 位置 |
| --- | --- |
| Hub界面 | `frontend/src/` |
| 后端接口与保存 | `backend/src/` |
| 任务筛选、排序和电子纸排版 | `contracts/display-snapshot.ts` |
| 设备固件 | `firmware/focusdesk_device/focusdesk_device.ino` |

后续重点为AI模型接入、自动生成建议和任务展示逻辑。现有协议、字体和容量范围内的排版调整可通过更新Hub完成，新增设备字体或修改驱动需要更新固件。

## 详细说明

- [开发交接与验证结果](docs/HANDOFF.md)
- [API与数据契约](docs/API_CONTRACT.md)
- [安装包构建](installer/README.md)
- [Windows使用与数据目录](docs/WINDOWS_DESKTOP.md)
- [Mac开发与设备模拟](docs/MAC_DEVELOPMENT.md)

固件采用GPL-3.0-only，第三方资源按随附许可使用。Windows应用自有代码的统一发行许可待所有者确定。[固件许可](firmware/LICENSE) · [第三方来源](firmware/THIRD_PARTY_NOTICES.md) · [字体许可](contracts/DISPLAY_FONT_LICENSE.txt)
