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

## 截图、任务进度与每日回顾

1. 在「今天任务」添加任务。打开「大任务进度 → 定义完成步骤」可填写一行一个的清单，或选用论文章节模板。清单里的各步骤等权。
2. 打开「屏幕记录」，选择对应任务、上传截图或共享指定窗口。本机模型提取画面里的摘要、下一步和已完成部分。默认核对后保存。选择任务并勾选自动记录后，本次周期共享可以每分钟自动保存有变化的文字。手动与自动记录均带来源，可在记录中删除。
3. 回到「今天任务」，进度条下方列出已完成的部分。点「在电子屏显示此任务」即可切换画面，也可打开模拟屏核对。设备现有字库使用英文，中文自定义步骤可填写「阅读实验部分 | Experiments」。
4. 阅读普通 PDF 时，打开含正文的章节页即可留下阅读书签。在同一篇论文中继续到后面的章节后，「大任务进度」会提示上一节，点「确认已读」才计入完成部分。目录页和刚打开的正文页不会增加百分比。若任务简称与论文标题不同，先手动保存一次正文书签，核对文档标题；随后的自动采样可识别同一论文。删除该任务下最后一条手动关联的书签即可解除关联。
5. 在「每日回顾」查看所选日期的计时时长和屏幕记录，点击「生成 AI 小结」可查看带依据的总结。写下一项「下一次尝试」，之后再填「复查结果」。首次启用计时记录后开始累计。

截图分析与 AI 小结使用运行在本机的图文模型，默认地址为 `http://127.0.0.1:18187`，别名为 `focusdesk-mail`，与邮件试读共用。截图在推理后仅留在当前浏览器草稿中；保存到磁盘的是文字。可在任务文件旁找到 `.checkpoints.json`、`.progress.json` 和 `.focus-review.json` 三份配套记录。[模型启动命令](experiments/mail-ai/README.md)

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
