# M1 桌面生命周期与内部协议

安装版链路：`launcher/FocusDesk.exe` → 安装目录内 `runtime/node.exe scripts/desktop-host.mjs` → 同一内置 Node fork 现有 `backend/server.ts`。没有系统 Node/Python/.NET 运行时依赖，也没有 Windows Service。Dashboard 仍由原 Backend 以本机 HTTP 提供；原 HTTP API、DTO 和 LAN 只读策略不变。

原生 Win32 启动器提供托盘、文件选择、明确导入确认、单实例、错误弹窗和浏览器入口。它以 exe 目录的父目录定位安装根，使用用户目录派生的 mutex/window 名识别实例。启动时先以 suspended 创建 Node，再加入带 KILL_ON_JOB_CLOSE 的 Job Object，最后恢复执行；启动器异常退出时只回收自己创建的进程树。服务端另按 canonical 数据文件路径持有 OS 锁，防止不同启动入口/端口并行写同一文件。

启动器与 host 使用只在父子进程之间的 stdin/stdout 行协议：host 输出 READY/ERROR/IMPORT_CONFIRM/IMPORT_RESULT/NETWORK，启动器输入 STOP/IMPORT/IMPORT_COMMIT/IMPORT_CANCEL/NETWORK。文件路径仅用于用户选择后的内部读取，不输出到日志或公共 API。

host 与 Backend 继续使用 Node IPC 的 focusdesk-ready/focusdesk-stop，并增加本地导入 preview/commit/result。preview 包含已验证的源对象，返回当前 revision；只有用户确认后才发 commit。同一个 loader 队列处理读取、网页写入和导入；停机先拒绝新工作并等待队列完成，再释放数据锁。关闭浏览器独立于应用生命周期。

host 在宣告就绪前检查 Dashboard 与任务 API 的有效响应。Windows 可能允许 wildcard 与已有 specific-address TCP 监听重叠，因此 host 在 fork 前先检查 loopback 端口，避免把其他服务错误当成本应用；不会终止未知监听者。默认就绪期限20秒，正常停机等待8秒后仅终止本次Backend；原生外层12秒期限和Job对象再保证进程回收。

应用日志只接收安全事件码和白名单运行字段，不记录子进程任意输出、任务正文、导入文件内容或请求body。日志单文件128KiB，三个归档；备份文件属于用户数据而不是日志，包含原任务内容。Windows网络检查只读调用系统防火墙/网络状态，不写防火墙规则。

测试专用参数：`--test-mode` 禁止浏览器/对话框副作用，并在隔离目录写test-state.json；`--user-data-dir` 指定测试数据根；`--command dashboard|connect|logs|network|exit` 走与托盘相同的操作处理；`--shutdown` 等待本用户当前实例真正退出供升级/卸载使用。发行快捷方式不含测试参数。

安装版测试使用独立AppId和临时目录，避免操作正式安装或默认用户数据。原LAN命令/便携包仍保留其开发用途；本轮没有修改或上传设备固件。
