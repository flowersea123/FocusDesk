# 本地演示服务

这是当前 FocusDesk Demo 的唯一后端，使用 Node.js 24 内置模块，无 npm 依赖、数据库或设备回执；已增加本机同源任务保存与专注开始/退出接口。任务及专注来自 `backend/data/tasks.json`，网页与 ESP32 读取同一份 DailyOverview 1.0。Focus Mode 的期限、原子持久化和手动验证见 [FOCUS_MODE.md](../FOCUS_MODE.md)。

## 启动

先构建同源 Dashboard，再以前台进程启动服务：

```powershell
cd E:\FocusDesk\frontend
npm run build
cd E:\FocusDesk\backend
npm start
```

打开 `http://127.0.0.1:8787/`。当前入口默认读取项目根的 `focusdesk.config.json`，默认已允许局域网访问；需要显式指定监听地址仍可使用：

```powershell
node server.ts --host 0.0.0.0
```

设备 API 为 `http://电脑实际局域网IPv4:8787/api/v1/daily-overview`。启动时打印候选 IPv4；它们不代表设备已可达。电脑与设备需能互通；程序不修改防火墙。服务是受控局域网的局域网可读、本机同源可编辑的演示，不发布到公网。按 Ctrl+C 退出，不建立后台常驻服务。

可选参数为 `--host IPv4`、`--port 1..65535`、`--data 路径`、`--dist 路径`；相对覆盖路径以当前工作目录为基准，默认路径以程序自身为基准。默认 LAN 绑定 `0.0.0.0:8787`，CLI 优先于根配置；项目根 `npm start` 显式保留 loopback 用途。

Windows 普通用户可双击根 `Start FocusDesk.cmd`；独立 `/connect` 页面和 `GET/HEAD /api/v1/server-info` 动态识别当前地址，不变更 Dashboard、业务 DTO 或本机同源写策略。迁移、端口调整和 IP 变化后的设备配置见 [WINDOWS_LAN.md](../WINDOWS_LAN.md)。

## 改任务并观察更新

编辑 `E:\FocusDesk\backend\data\tasks.json`。它包含 `date`、`timezone`、`tasks` 及可选 `focus`，字段参见统一 `docs/API_CONTRACT.md`。建议通过网页开始/退出专注，由服务生成时间。保存后下一次读取生效，无须重启；安装新服务代码则需重启。

- `date` 是明确的演示日期，不自动变成实时今日。
- 当前设备 profile 仅支持 `Asia/Shanghai` 或 `UTC`；其他合法 IANA 时区返回 `503 / UNSUPPORTED_DEVICE_TIMEZONE`。
- 当前标题使用 1–40 个可打印 ASCII 字符，可含普通空格，不接受全空白、中文或控制符。合法中文 DTO 在本轮服务返回 `503 / UNSUPPORTED_DEVICE_TEXT`，通用共享 DTO 的 UTF-8 支持仍保留。
- 任务 0–3 条，数组顺序就是展示顺序。`tasks: []` 是合法无任务；`status` 为 `todo` 或 `done`，`due_at` 必填且可为 `null`。
- 文件原始 UTF-8 字节（含空白）不得超过 4096；输出也经过共享校验器验证，最大 4096 字节。
- 不需编辑 revision 或 updated_at：revision 是规范化内容的 SHA-256，updated_at 来自文件 mtime。内容/顺序/日期/时区变化才产生新版本；同进程内只改空白或对象键顺序保持已有有效快照不变。
- 进程重启后根据文件 mtime 重建 updated_at，相同业务内容的 revision 仍相同。它不是递增计数器。
- 文件不存在、非法、超限或不可读时明确返回 503，不用旧快照冒充读取成功，也不重建覆盖文件。修复文件后下次读取恢复。正在编辑中的不完整 JSON 可能短暂触发 503，网页和设备应保留自己的最后有效内容。

## API 和静态资源

唯一读取 API 为 `GET /api/v1/daily-overview`；`HEAD` 返回相同响应头、无 body。成功响应使用 `application/json; charset=utf-8`、`Cache-Control: no-store` 和精确 `Content-Length`，不压缩、不使用 chunked transfer。读取路径非 GET/HEAD 返回 405。

`PUT /api/v1/daily-overview/tasks` 接受 `{revision,tasks}`，只允许 loopback peer、loopback/localhost Host 和同源 Origin。请求 UTF-8 JSON，最多 4 KiB、读取期限 5 秒。成功返回完整 1.0 快照；400 数据错误、403 来源、409 旧版本、413 超限、415 类型、408 上传超时、503 源/保存失败。

读写共用串行队列，版本匹配后写同目录唯一临时文件、sync/close、rename，不先删除原文件；no-op 不重写，失败清理自己的临时文件。提交前再次核查已观察到的外部改动，不提供跨进程编辑器锁。详见 `docs/TASK_EDITING.md`。

服务从 `frontend/dist` 提供 `/`、HTML/CSS/JS、图片和字体。缺失资源返回 404，不回退成首页；未知 `/api/*` 也返回 404。源码、JSON 任务文件、source map、隐藏文件、路径遍历和指向 dist 外部的符号链接不作为静态资源提供。

## 验证

```powershell
cd E:\FocusDesk\backend
npm test
```

测试使用操作系统临时目录和短暂 loopback 随机端口，完成后关闭服务并清理自己的目录；覆盖真 HTTP、共享 seed、文件变更、稳定版本、空任务、错误/恢复、严格 UTF-8、4 KiB 边界、设备文本/时区、HEAD、静态资源及路径逃逸。无需先启动手工服务。

软件测试和网页读取不代表电子纸已显示；无设备回执，实际显示仍由用户观察与串口记录确认。
