# FocusDesk

本地 Hub 与 ESP32-S3 电子纸任务屏，支持任务编辑、25分钟专注和手动填写AI建议。当前版本为0.2.0；提供 Windows 安装版和 macOS 本机开发模式。

## Mac 本机开发与模拟屏

安装 Node.js 24 或以上版本，在仓库根目录执行：

```sh
npm --prefix frontend ci
npm run dev
```

打开 [Dashboard](http://127.0.0.1:5173/) 编辑任务，在 [设备模拟屏](http://127.0.0.1:5173/simulator) 查看保存后的真实显示快照。首次运行只在任务文件不存在时复制示例；已有数据保留。前端修改自动更新，后端或共享排版修改自动重启 Hub 并刷新页面，修改代码前先保存编辑草稿。Ctrl+C 同时停止两个服务。

模拟屏使用设备相同的位图字体和绘图规则，提供快速检查、设备节奏、模拟断网和 PNG 导出。软件模拟不验证物理刷新、无线连接或实际色彩。[开发流程与验证边界](docs/MAC_DEVELOPMENT.md)

## 本地 AI 邮件试读

在本机读取一封 EML，用图文模型总结正文与随信截图、识别截止时间，然后将核对通过的待办加入现有任务列表。命令行也能按需读取 Outlook 收件箱和指定 Canvas 课程的作业。当前提供源码试用入口。[启动与账号配置](experiments/mail-ai/README.md) · [三个小模型的实测结果](experiments/mail-ai/evaluation/RESULTS.md)

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
