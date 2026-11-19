# 联网 Demo 手动操作

目标：电脑保存任务修改后，网页和电子纸显示同一份新内容，不再为每次任务修改重新烧录。

## 1. 启动电脑服务

在 PowerShell 运行：

```powershell
Set-Location E:\FocusDesk
npm run demo
```

当前依赖和网页产物已准备。首次在新环境运行时，先在 `frontend/` 执行 `npm ci`，再回根目录 `npm run build`。需要 Node.js 24+，本地服务没有其他依赖。

浏览器打开 `http://127.0.0.1:8787/`，应显示三条英文合成任务和“本地演示服务”标识。直接访问 `http://127.0.0.1:8787/api/v1/daily-overview` 可检查同一份 JSON。

服务终端列出电脑局域网 IPv4 候选。电脑与 ESP32 需能互通，设备 URL 使用实际可达的电脑 IPv4，例如 `http://192.168.1.10:8787/api/v1/daily-overview`。示例 IP 不是自动检测结果；不要把 127.0.0.1 或 localhost 填进设备。服务不会自动改防火墙。按 Ctrl+C 停止，无开机启动或后台服务。

## 2. 配置并上传联网程序

打开 [focusdesk_live.ino](../firmware/focusdesk_live/focusdesk_live.ino)。将同目录 `private_config.example.h` 复制为 `private_config.h`，填入：

```cpp
#define FOCUSDESK_WIFI_SSID "你的2.4GHz网络名称"
#define FOCUSDESK_WIFI_PASSWORD "你的网络密码"
#define FOCUSDESK_API_URL "http://电脑实际局域网IPv4:8787/api/v1/daily-overview"
```

值需自行替换；不把真实密码贴到聊天。私有文件已被忽略。没有填写时程序报告 `CONFIG_REQUIRED`，不会连接占位网络。

Arduino IDE 沿用原 `ESP32S3 Dev Module` 的板卡、USB、Flash、PSRAM 设置和实际端口；先验证再手动上传。上传会替换板上当前应用。已含显示驱动和 ArduinoJson，沿用本机 GFX/BusIO，不需要全局另装 ArduinoJson。

串口 115200。读取/显示分别以 `FETCH_OK`、`DISPLAY_OK` 标识，相同版本以 `UNCHANGED` 标识。具体超时和错误见 [设备说明](firmware/LIVE_DISPLAY.md)。

## 3. 改任务并核对更新

推荐在本机 `http://127.0.0.1:8787/` 点击“编辑任务”，修改后“保存更改”。也可编辑首次启动后生成的 `backend/data/tasks.json`，版本由 Hub 管理。请避免网页与外部编辑器同时写入。[任务数据示例](../backend/data/tasks.example.json)。见 [任务编辑](TASK_EDITING.md)。

- 网页下次约 30 秒轮询读取，也可点“重新读取”。
- 设备也轮询，但新画面受前次显示尝试完成后至少 60 秒间隔约束；完整刷新还需面板时间。网络错误会退避，不能保证固定秒数显示。
- 核对网页任务、API revision、串口与实物；网页预览不是设备回执。
- 当前标题使用 1–40 个可打印 ASCII 字符；0–3 条任务，status 为 todo/done，due_at 必填可为 null。日期来自文件，中文等不支持的数据会明确报错，不静默丢字。
- `tasks: []` 是合法无任务，应替换旧任务；非法 JSON、服务停止或断网则不应清空画面。修复/恢复后等待下一轮。

任务页没有 BLACK/RED/YELLOW 测试区，原四色全刷波形不变，原静态工程仍保留。

## 验证边界

软件检查覆盖真实 HTTP、文件更新、空任务、错误恢复及实际构建页面的同源读取。固件主机测试使用实际代码与硬件替身；无线通信、刷新效果和串口结果由用户运行后确认，当前不声称联网版本已烧录或真机验收。

实际结果：共享契约 49、服务 23、前端 23、整合 1，共 96 项通过；TypeScript/Vite 构建与服务 CLI 启动检查通过。固件五组主机测试通过，真实 ESP32 工具链已编译 ino/driver 目标文件，尚未做最终链接。Agent 检查服务已停止，用户按上面命令自行启动并手动上传。
