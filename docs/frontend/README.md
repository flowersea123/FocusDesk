# Dashboard 本地演示

状态：FE-L1。生产构建默认从同源本地演示服务读取任务；Vite 开发模式默认使用浏览器 Mock。两种模式使用同一份共享 `DailyOverview 1.0` 契约，不需要等待外部 Backend。网页读取成功不代表 ESP32 在线或电子纸已同步。

## 运行完整本地页面

在 `E:\FocusDesk` 运行：

```powershell
npm run build
npm run demo
```

打开 `http://127.0.0.1:8787`。服务提供构建后的 `frontend/dist` 和同源 `/api/v1/daily-overview`，设备联调时使用电脑实际局域网 IPv4 地址。`npm run demo` 监听局域网接口；只在本机使用时可运行 `npm start`。服务入口为 `backend/server.ts`，具体参数和文件格式见后端说明。

修改 `E:\FocusDesk\backend\data\tasks.json` 后保存，页面通常在 30 秒内读取，也可点击“重新读取”。任务文件包含显式演示日期，因此网页标注“文件演示日期”，不声称自动按实时日期筛选。服务生成 revision；本机页面已提供任务编辑器，通过版本保护的保存 API 原子更新任务文件。局域网 IP 页面和 Mock 模式只读。

当前设备内置字库演示使用可打印 ASCII 英文标题。服务会拒绝不支持的标题并返回错误；网页保留上次成功内容，不把失败当空任务。通用 DTO 仍支持 UTF-8，原中文 fixtures 继续用于浏览器 Mock 测试。

## 开发与验证

在 `E:\FocusDesk\frontend` 运行：

```powershell
npm run dev
npm test
npm run build
```

开发地址默认 `http://127.0.0.1:5173`，端口占用时以 Vite 输出为准。开发模式默认无需启动服务，从 `../contracts/fixtures/` 直接读取合成数据；“开发演示工具”可切换正常、空列表、全部完成、次日、读取失败。固定日期明确标为演示日期，不修改任务或发送写入请求。

新环境先在前端目录运行 `npm ci`。需要检出完整项目，因为前端只读引用 `../contracts/daily-overview.ts` 和 fixtures，不能单独复制前端目录运行。

## 数据源配置

`VITE_DATA_SOURCE` 未设置时，`npm run dev` 默认 `mock`，`npm run build` 默认 `http`。明确设置的 `VITE_DATA_SOURCE=mock` 或 `http` 优先于模式默认值；例如需要构建独立 Mock 页面时：

```powershell
$env:VITE_DATA_SOURCE = 'mock'
npm run build
```

恢复同源 HTTP 默认构建前移除覆盖：

```powershell
Remove-Item Env:VITE_DATA_SOURCE -ErrorAction SilentlyContinue
Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue
npm run build
```

HTTP 读取地址为 `{VITE_API_BASE_URL}/api/v1/daily-overview`。不设置 base URL 时使用页面同源路径；若明确设置，base URL 不含 `/api/v1`，例如 `http://127.0.0.1:8787`。当前 Vite 没有 API 代理；开发服务器与演示服务分端口时会跨域，不能把 ESP32 能访问当作浏览器跨域已配置。使用服务提供的构建页面即可保持同源。

可将 `.env.example` 复制为 `.env.local` 后调整；样例默认不启用任何覆盖。环境变量变化需要重启 Vite/重新构建。`VITE_*` 会写入浏览器资源，不能放密钥。

## 读取与展示规则

- 今日任务列表和电子纸内容示意使用同一个共享校验器检查过的快照，保持数据源顺序，完成数量由快照计算。
- 初次加载、初次失败、合法空列表分开显示；后续读取或失败时保留上次成功内容并明确提示。合法空数组会清空旧列表。
- HTTP 使用 GET、`cache: no-store`、5 秒总超时；先检查 Content-Length，再逐块限制最多 4096 字节，以严格 UTF-8 解码并交给统一校验器。
- 每次 HTTP 请求完成后等待 30 秒再读取，失败等待 30/60/120/240/300 秒；请求不重叠。手动重读会取消之前请求。
- HTTP 模式停用 Mock 场景按钮，开发工具区改为任务文件修改指引。任务编辑使用草稿、保存/取消与冲突提示；本机页面支持选择未完成任务开始固定 25 分钟专注，以及手动退出。服务返回专注快照后预览才切换，失败不乐观更新；读取到期快照恢复总览。提醒执行/AI 不在范围内，详见 [FOCUS_MODE.md](../FOCUS_MODE.md)。
- 浏览器本机时间只用于“最近成功读取”；任务截止时间使用快照时区，今日归属不由前端推导。
- 预览是内容示意，不承诺与实物像素一致。没有设备回执，不显示设备在线或已同步；中文浏览器预览不证明电子纸支持对应字库。

## 验证边界

测试覆盖 UI 同源顺序、Mock 状态切换、合法空列表、初次失败与重试、HTTP 来源选择、串行轮询、失败保留/退避/恢复，以及 HTTP 超时、严格 UTF-8、有界流读取和契约拒绝。构建检查 TypeScript 与静态打包。

当前工具没有浏览器控制/截图能力；jsdom 行为测试不代替真实浏览器视觉验收。整合同源服务的 HTTP 检查由 Tech Lead 记录，ESP32/屏幕实物验收由用户完成，不因网页读取成功而宣称完整链路已验收。

FE-L1 实际验证（2026-11-02）：`npm test` 通过 2 个测试文件、23 项测试；`npm run build` 通过 TypeScript 检查和 Vite 生产构建。此次未启动额外预览服务或安装依赖。
