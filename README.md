# FocusDesk

Windows 本地 Hub 与 ESP32-S3 电子纸任务屏，支持任务编辑、25分钟专注和手动填写AI建议。当前版本为0.2.0。

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

固件采用GPL-3.0-only，第三方资源按随附许可使用。Windows应用自有代码的统一发行许可待所有者确定。[固件许可](firmware/LICENSE) · [第三方来源](firmware/THIRD_PARTY_NOTICES.md) · [字体许可](contracts/DISPLAY_FONT_LICENSE.txt)
