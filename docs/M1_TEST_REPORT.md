# M1 Windows 安装版测试与交付报告

日期：2026-11-03（Asia/Shanghai）。应用版本 0.1.0，Windows 10/11 x64，Inno Setup 6.7.4，官方 Node.js 24.16.0 Windows x64。

## 实际产物

- 安装包：`E:\FocusDesk\.cache\m1-dist\FocusDesk-Setup.exe`，24,686,884 字节。
- SHA-256：`d5b23bc2476d60d0698fbf31772007740eba367951986f4c8cbc86a2f1fec4ec`。
- 构建清单：同目录 `FocusDesk-Setup.exe.manifest.json`。正式构建 `testBuild:false`，27 个程序文件；不含真实任务、私有配置、固件、npm 或开发依赖。
- 最终核对 25 个安装包/源码/构建输入哈希，均与清单一致。原始 Node LICENSE 和 React/React DOM/scheduler MIT LICENSE 随包保留。
- 用户说明：[安装与旧数据导入](WINDOWS_DESKTOP.md)；开发构建：[installer/README.md](../installer/README.md)；内部协议：[桌面生命周期](DESKTOP_LIFECYCLE.md)。

## 基线与回归

工作目录没有 Git 元数据，不能报告 Git diff 或提交状态。实施前保存了不含真实任务与私有配置的源码快照及哈希清单到 `.cache/m1-baseline`，未初始化 Git。原有测试先重新执行：126 项契约/后端/便携打包 + 40 项前端 + 7 项整合，**173/173 通过，无基线失败**。

最终软件验收合计 **243 项通过**：

| 测试组 | 通过数 | 范围 |
| --- | ---: | --- |
| 共享契约 | 63 | 原 HTTP/JSON 数据约束 |
| Backend | 73 | 原行为及新增数据目录、锁、导入备份、优雅停机 |
| 原便携打包 | 9 | 原入口继续可用 |
| 导入客户端 | 31 | 校验、确认、请求匹配、超时与不确定提交结果 |
| 桌面 host/原生启动器/日志 | 8 | 实际内置运行时、空 PATH、单实例、退出及异常回收 |
| 前端 | 40 | 原 Dashboard/任务/专注交互 |
| 原整合 | 7 | 实际服务、页面、LAN 读写权限与持久化 |
| 安装包构建单元测试 | 11 | 官方文件校验、白名单及构建参数边界 |
| 实际安装/跨版本升级/卸载 | 1 | 隔离环境 0.1.0 → 0.1.1 |
| 合计 | **243** | 全部执行通过；实际安装测试需显式启用 |

原有 26 个测试及支持文件重新逐一核对，字节未变；未删除或降低旧测试标准。TypeScript/Vite 构建通过，Dashboard 产物仍为 `index-BaRLauI1.js` / `index-DcOG3ksA.css`。最后的托盘恢复失败处理重新通过 2 项原生测试；随后 host 日志版本改为读取安装版 package.json，实际 host 空 PATH/导入/备份/退出用例再次通过，并已纳入最终安装包。

## 实际 Windows 验收

测试在当前 Windows 主机上使用独立 AppId、系统临时目录、中文及空格路径、独立用户数据与随机端口。启动应用时 PATH 为空，清除 Node 注入选项，实际执行安装目录中的官方 node.exe。未安装到正式个人目录，未停止用户已有服务或改写真实任务。

| 项目 | 结果与证据边界 |
| --- | --- |
| 安装及运行时 | 实际 Inno 安装成功；内置 Node 提供 Dashboard 与 API，无系统 Node PATH 依赖 |
| 就绪与打开入口 | 就绪前验证真实页面与 DTO；自动浏览器调用已实现，测试模式抑制浏览器副作用，未做人工浏览器弹出验收 |
| 托盘菜单 | 自动调用与托盘共用的 Dashboard/连接/日志等处理路径；未声称逐项人工点击验收 |
| 浏览器生命周期 | 服务由托盘进程持有，独立于浏览器；自动化不启动浏览器，人工关闭浏览器后的硬件观察待验收 |
| 单实例与退出 | 重复启动复用原实例；正常退出停止 launcher/host/backend；强制结束启动器后 Job Object 回收其子进程，数据锁可重新获取 |
| 端口冲突 | 明确报错，未知监听服务继续存在，数据未改；覆盖 Windows wildcard/specific-address 绑定重叠情况 |
| 错误与日志 | 非法已有数据保留；真实启动超时后清理子进程；日志字段白名单、轮转及容量测试通过 |
| 旧数据导入 | 预览后明确确认、版本保护、先备份再原子替换；无效数据、取消、并发修改、失败与超时均覆盖 |
| 升级 | 运行中的 0.1.0 实际升级到 0.1.1；安装后 package.version 确实变化，原实例正常退出，新版可重新启动 |
| 卸载 | 运行中卸载成功，端口停止响应，任务/配置/备份保留；测试安装注册及临时目录已清理 |
| 外部运行库 | PE 导入仅 Windows 系统 DLL，无额外 .NET/libgcc/libstdc++/libwinpthread 运行时依赖 |

原 LAN 入口仍要求系统 Node，这是保留的开发/旧便携用途，安装版不会调用这些入口。

## 固件与硬件边界

原静态与联网固件主机测试重新编译、运行通过。真实 ESP32-S3 工具链重新编译现有 sketch 与原样驱动源码目标文件，分别为 1,042,888 与 65,128 字节，位于 `.cache/m1-firmware-api-check.o` / `.cache/m1-firmware-driver-check.o`。这属于目标源码编译检查，**没有进行最终固件链接、上传、串口或本轮真机验收**。

本轮不修改固件、private_config.h、显示波形或设备 HTTP 协议。LAN 读取与本机同源写入策略保持。电脑关闭/睡眠、网络中断或退出 FocusDesk 后不会继续同步；设备仍按原行为保留最后画面。

## 可重复执行

开发机器需 Node 24+、现有前端开发依赖和 MinGW 编译器；这些不要求安装目标用户具备。官方工具准备和安装包构建：

```powershell
npm run build
node scripts/fetch-runtime.mjs --with-inno
node scripts/build-installer.mjs
```

全部软件测试分组执行：

```powershell
node --test contracts/tests/*.test.mjs backend/tests/*.test.mjs tests/packaging/*.test.mjs tests/migration/*.test.mjs tests/desktop/*.test.mjs
npm run test:frontend
npm run test:integration
node --test tests/installer/runtime.test.mjs tests/installer/build.test.mjs
$env:FOCUSDESK_RUN_INSTALLER_E2E='1'
node --test tests/installer/lifecycle.test.mjs
Remove-Item Env:FOCUSDESK_RUN_INSTALLER_E2E
```

原生测试还需要预先将构建出的 `launcher/FocusDesk.exe` 放到 `.cache/m1-native/launcher/FocusDesk.exe`；测试文件声明了这个位置，普通源码测试不会自行调用编译器。实际安装测试会自行构建隔离测试版和升级版，不使用正式用户数据。不要把默认跳过的安装测试算作实际通过。

## 剩余限制

1. 未提供干净 Windows VM；空 PATH、真实安装及系统 DLL 检查支持无开发环境运行，但另一台无开发环境电脑的完整人工验收仍需进行。
2. 未完成默认浏览器、文件选择、托盘图标/菜单的人工 GUI 验收，也未在本轮重新接入实物 ESP32。
3. 自有安装包/启动器尚未代码签名，SmartScreen 可能提示。官方 Node 和构建工具已校验来源与哈希。
4. 应用内实现只读专用网络诊断，不改防火墙。独立主机防火墙状态检查因自动审批服务额度失败而未执行；这不是不安全判定。Windows 网络授权、企业策略和路由隔离仍需目标电脑核实。
5. M1 没有配网/发现/配对：换电脑导致 IP/端口变化仍需修改设备 API 地址并上传；Wi-Fi 变化还需更新凭据。安装版不能替现有固件自动重新配置。
6. 导入是整文件替换，不自动合并；导入备份含任务数据且不自动清除。提交超时可能已经保存，界面要求核对结果，不宣称自动回滚。
7. 原生日志受容量限制；长期备份属于用户数据，需用户自行管理。退出只停止本应用拥有的进程，不关闭用户浏览器或其他程序。

M1 实现与当前环境内可完成的自动验收已交付。后续先在目标电脑人工验收，再按另行授权进入 M2/M3。
