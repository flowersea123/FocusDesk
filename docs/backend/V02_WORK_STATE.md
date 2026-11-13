# V0.2 工作状态后端

2026-11-11 实现记录。

## 数据路径

在现有任务 JSON 中增加可选 `work_state` 与 `signals`。旧文件继续有效，旧的任务与专注 revision 算法保持兼容。新增字段通过共享契约校验，导入验证同样保留字段。任务、专注及工作状态写入使用同一个队列和原子临时文件替换，任务与专注操作会保留工作状态和事件历史。

`work_state` 包含 `goal`、`current_action`、`next_action`。事件最多保留四条，含内容、来源、时间、优先级及状态。人工编辑事件不会修改 Goal 或任务。字段限制和排序以 `docs/API_CONTRACT.md` 为准。

## 路由

- `PUT /api/v1/daily-overview/work-state` 接收 `revision`、`work_state`、`signals`，返回完整 DailyOverview。沿用本机同源写限制、409 版本冲突和 4096 字节上限。
- `GET/HEAD /api/v1/display-snapshot` 使用 `contracts/display-snapshot.ts` 的 `buildDisplaySnapshot` 生成已保存的 400×300 显示快照，响应上限 4096 字节。GET 不修改任务文件。

桌面数据仍使用已有外置目录、数据锁、备份和恢复流程。确认导入旧格式文件时，导入后的数据以该文件为准。已有文件在覆盖前由现有迁移事务备份。

## 自动化证据

`backend/tests/work-state.test.mjs` 的 11 项测试覆盖旧哈希兼容、持久化和重启、任务与专注保留、幂等保存、写队列冲突、非法输入、调用者变异保护、替换失败、导入备份、本机同源权限以及 Snapshot GET/HEAD 一致性。

本模块执行 `node --test backend/tests/work-state.test.mjs`，11 项通过。随后执行 `npm test`，契约及后端共 147 项通过。测试在隔离临时目录运行，未读取或修改真实用户任务文件。HTTP 回归需要环境允许本机 loopback 连接。

Tech Lead 最终整合补充共享布局回归后，`npm test` 为155项通过。完整最终结果见 `docs/V02_DELIVERY.md`。
