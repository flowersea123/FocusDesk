# FocusDesk

Windows 本地 Hub 与 ESP32-S3 电子纸任务显示设备。当前交接版本为 0.2.0，整理日期为 2026-11-13。

## 当前功能

- 在 Hub 添加、修改、完成和删除任务，最多保存十项。
- 设备显示最多五条未完成任务，专注任务优先，其余保持保存顺序，超过五条时显示剩余数量。
- 支持固定 25 分钟 Focus Mode，以及手动填写、修改和清空 AI 建议。
- Hub 生成 400×300 四色 Display Snapshot，固件执行绘图指令。当前设备文字与建议使用英文，字体为 Nunito。
- 设备通过手机网页配置 2.4 GHz Wi-Fi 和 Hub 地址，并将有效配置保存在 NVS。
- Windows 安装包内置 Node.js，原生托盘负责启动和退出服务。

AI 模型接入、建议自动生成、设备 OTA 和自动发现属于后续开发。已保存的 work_state 与 signals 仍由数据层兼容，当前网页集中展示任务和建议。

## 首次运行源码

需要 Node.js 24 或以上版本。在仓库根目录使用 PowerShell 执行以下命令。

```powershell
npm --prefix frontend ci
if (!(Test-Path backend/data/tasks.json)) {
    Copy-Item backend/data/tasks.example.json backend/data/tasks.json
}
npm run build
npm run demo
```

打开 `http://127.0.0.1:8787/` 管理任务，`http://127.0.0.1:8787/connect` 查看设备连接地址。电脑和设备接入同一局域网。电脑本机允许写入，其他局域网设备只读。

源码运行的数据位于 `backend/data/tasks.json`，已被 Git 忽略。示例文件包含合成任务，日期为固定样例日期，可按产品后续设计调整。安装版的数据位于 `%LOCALAPPDATA%\FocusDesk`。

## 设备与固件

硬件为 ESP32-S3 + GDEM042F52/JD79668，分辨率400×300，黑白黄红四色。正式入口是 `firmware/focusdesk_device/focusdesk_device.ino`。

设备正常每30秒读取 `/api/v1/display-snapshot`，版本变化后安排全刷，两次刷新尝试之间至少间隔60秒。修改后通常需留出约1–2分钟观察。读取失败保留最后有效快照，显示失败会受控重试。

任务筛选、排序、位置和换行由 `contracts/display-snapshot.ts` 生成。在既有协议、字体和容量内修改这些规则，更新 Hub 即可。新增字体、中文支持、绘图指令，或修改配网与驱动，需要更新固件。当前通过USB手动烧录。

首次构建先运行 `node scripts/prepare-provisioning-poc.mjs`，生成本地热点密码及连接卡，再按设备说明配置Arduino环境。当前Nunito固件与Hub需要配套使用。

- [设备上传与配网](firmware/focusdesk_device/README.md)
- [交接说明与验证结果](docs/HANDOFF.md)
- [接口与数据契约](docs/API_CONTRACT.md)

## Windows 安装包

在 GitHub Releases 获取本次交接安装包及校验清单。开发侧重新构建使用以下命令。

```powershell
npm run build
node scripts/fetch-runtime.mjs --with-inno
npm run build:installer
```

构建需要 MinGW g++、Inno Setup 6.7.4 和固定 Node.js 24.16.0 x64 工具包。准备脚本使用项目内缓存。安装包输出到 `.cache/m1-dist/FocusDesk-Setup.exe`。

- [安装包构建说明](installer/README.md)
- [Windows 使用与数据目录](docs/WINDOWS_DESKTOP.md)

## 验证

```powershell
npm test
npm run test:frontend
npm run test:integration
npm run test:packaging
npm run test:desktop
npm run test:migration
npm run test:installer
node --test tests/provisioning/*.test.mjs
```

部分 Windows 原生与安装生命周期测试需要本机工具。实际安装测试通过 `FOCUSDESK_RUN_INSTALLER_E2E=1` 显式启用，并使用隔离目录。固件主机与完整目标编译方法见交接说明。

## 目录与历史资料

| 目录 | 用途 |
| --- | --- |
| `frontend/` | React + TypeScript + Vite Hub界面 |
| `backend/` | Node.js服务、文件持久化、HTTP接口 |
| `contracts/` | 数据校验、共享布局、字体资源 |
| `firmware/focusdesk_device/` | 当前统一设备入口 |
| `firmware/experiments/focusdesk_provisioning_poc/` | 被统一固件复用的配网与NVS模块 |
| `firmware/focusdesk_live/` | 被统一固件复用的解析器、驱动和JSON库，以及旧联网入口 |
| `firmware/focusdesk_static/` | 硬件诊断与旧静态入口 |
| `installer/`、`launcher/` | Windows安装器与原生托盘 |
| `scripts/`、`tests/` | 构建、打包与回归验证 |
| `docs/` | 当前契约、交接及历史阶段记录 |

历史阶段记录带有各自的日期、布局和验收范围。当前行为以源码、本页和交接说明为准。旧M2发布文件保留在维护者本地的忽略目录，源码中的历史文档链接涉及该目录时需使用原归档。

## 隐私与许可

私有配置、个人任务、连接卡、日志、开发缓存和固件二进制已纳入Git忽略规则。新开发者生成自己的本地配置。设备连接信息由交付者单独提供。

固件保留GPL-3.0-only及原作者声明，ArduinoJson保留MIT，Nunito与Source Sans 3保留OFL。其他组件按随附许可使用，Windows应用自有代码的统一发行许可待所有者确定。

- [固件许可](firmware/LICENSE)
- [驱动与JSON库来源](firmware/THIRD_PARTY_NOTICES.md)
- [共享字体许可](contracts/DISPLAY_FONT_LICENSE.txt)
