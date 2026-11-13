# FocusDesk 候选共享契约

用于浏览器 Mock 与本地联网 Demo 的统一类型、运行时校验和固定样例。用户已授权直接完成本轮服务，不再等待 B；本目录只维护契约，服务实现位于 `backend/`。语义规范见 [API_CONTRACT.md](../docs/API_CONTRACT.md)。

- `daily-overview.ts`：`DailyOverview` / `Task` 类型、`parseDailyOverview`、`parseDailyOverviewText` 和容量常量。
- `focus-update.ts`：固定 25 分钟专注的 start/stop 写请求；`DailyOverview.focus` 为可选兼容扩展，缺失/null 表示总览。
- `fixtures/focus.json`：英文专注快照，结束时间跨越上海本地午夜，供前端/固件一致性验证。
- `fixtures/today.json`：固定演示日期 2026-11-02，含 todo/done。
- `fixtures/empty.json`：合法空列表。
- `fixtures/completed.json`：同日全部完成、独立 revision。
- `fixtures/next-day.json`：次日样例，date/revision 均改变。
- `fixtures/device-demo.json`：设备联网演示的英文样例，供本轮服务种子使用；文件源的 revision/updated_at 由服务计算。
- 中文标题只代表前端演示内容，不代表真机字库已核实。

Node.js 24+ 下运行，无需安装依赖：

```powershell
Set-Location E:\FocusDesk\contracts
npm test
```

校验器检查 JSON 体积、必填字段、真实日期、UTC 时间戳、IANA 时区、任务数、唯一 ID、状态和 Unicode 标题；拒绝未知版本，忽略未知字段并返回已知字段的副本。固定样例不应伪装为实时“今天”。前端只读使用这些文件，所有变更由 Tech Lead 协调。
