# Windows 安装包构建

M1 使用 Inno Setup 6.7.4、官方固定 Node.js 24.16.0 Windows x64 和项目原生 Win32 启动器。开发机器需要 Node 24+、可编译当前 Win32 源码的 MinGW g++；安装目标机器不需要 Node/npm 或开发环境。面向 Windows 10/11 x64，每用户安装，不注册系统服务或防火墙规则。

## 构建与下载来源

在 `E:\FocusDesk` 执行：

```powershell
npm --prefix frontend run build
node scripts/fetch-runtime.mjs --with-inno
node scripts/build-installer.mjs
```

默认产物为 `.cache/m1-dist/FocusDesk-Setup.exe`，相邻 `.manifest.json` 记录应用版本、官方 URL、固定哈希、原生源码哈希、逐文件 payload 哈希和最终安装包哈希。每次在 `.cache/m1-builds/` 创建新 staging，不覆盖源文件或用户数据。重复构建可替换 `.cache` 中同名发行产物；自定义输出已存在时拒绝覆盖。生成时间及压缩容器会影响字节，不声称不同机器构建逐字节相同。

固定官方元数据见 `installer/runtime-lock.json`：

- Node zip 来自 `https://nodejs.org/dist/v24.16.0/`，先核对官方 `SHASUMS256.txt`，再验证 zip、解出的 `node.exe` 和 `LICENSE` 的固定 SHA-256。只提取这两个条目，不复制系统 Node 冒充验证，也不把 npm 或 SDK 一起打包。解出运行时还实际执行版本/架构检查。
- Inno 来自官方 `jrsoftware/issrc` 的 `is-6_7_4` release，下载哈希与官方资产 digest 一致；本轮额外检查其 Authenticode 为有效 Pyrsys B.V. 签名。官方 `setup.iss` / `isportable.iss` 的 `/PORTABLE=1` 将工具放到 `.cache/m1-toolchain/inno-6.7.4`，禁用卸载注册、快捷方式与文件关联，不改变全局开发环境。重用缓存前复核编译器固定哈希。
- 网络下载失败或哈希不符时终止；不会退回系统 Node、静默换版本或执行未核验下载。缓存损坏应在确认路径后仅清理对应工具缓存，再运行准备命令。

原生编译使用 `-municode -mwindows -std=c++17 -static -static-libgcc -static-libstdc++ -pthread` 和 Windows 系统库。当前已安装 MinGW 8.1.0 为 win32 thread model；启动器使用 Win32 线程 API，避免要求额外 std::thread runtime。PE 导入已检查：启动器不依赖 libgcc/libstdc++/libwinpthread DLL，bundled Node 也仅导入 Windows 系统 DLL。此检查与空 PATH 本机测试不替代干净 Windows VM 验收。

## 安装布局与生命周期

默认应用目录为 `%LOCALAPPDATA%\Programs\FocusDesk`：

```text
launcher/FocusDesk.exe
runtime/node.exe
runtime/LICENSE
licenses/react.LICENSE.txt
licenses/react-dom.LICENSE.txt
licenses/scheduler.LICENSE.txt
backend/server.ts
backend/src/*
backend/public/*
contracts/*.ts
frontend/dist/*
scripts/desktop-host.mjs
scripts/desktop-logs.mjs
scripts/desktop-paths.mjs
scripts/import-client.mjs
docs/WINDOWS_DESKTOP.md
package.json                 # 仅生成运行所需 type:module 元数据
```

白名单不包含 backend/data、个人 config、private_config.h、.env、固件、共享 fixtures、测试、node_modules 或开发缓存。仅额外从已安装 React、React DOM、scheduler 包中复制原始 MIT LICENSE 到 `licenses/`，不打包其开发源码或 node_modules 目录。运行后数据/配置/日志/备份由应用放在独立 `%LOCALAPPDATA%\FocusDesk`，安装包不预置个人任务。Node 的原始第三方许可保留于 `runtime/LICENSE`。

安装创建开始菜单入口，默认勾选桌面快捷方式；启动目标为 `launcher/FocusDesk.exe`，可选安装后运行。升级的 `PrepareToInstall` 和卸载的 `InitializeUninstall` 先运行已有 launcher 的 `--shutdown` 并等待返回 0；失败则停止安装/卸载，不用 Restart Manager 杀其他 Node。没有删除外置用户数据的卸载步骤。退出/关闭协议由启动器负责验证实例已停止。

## 验证

普通构建边界测试：

```powershell
node --test tests/installer/runtime.test.mjs tests/installer/build.test.mjs
```

真实安装生命周期测试需 Windows 及可运行本地工具：

```powershell
$env:FOCUSDESK_RUN_INSTALLER_E2E='1'
node --test tests/installer/lifecycle.test.mjs
Remove-Item Env:FOCUSDESK_RUN_INSTALLER_E2E
```

该测试创建独立测试 AppId，将应用安装到系统临时目录的中文/空格路径，使用独立 `--user-data-dir` 和随机 loopback 端口，不操作默认用户数据或已有服务。验证空 PATH 启动、运行中从 **0.1.0 升级到 0.1.1**、安装后版本变化、重启、运行中卸载以及任务/配置/备份保留；最后卸载测试注册并清理自建临时目录。Windows 卸载日志可能晚于主进程释放，清理使用有限重试。

测试构建参数：

```powershell
node scripts/build-installer.mjs --output .cache/m1-test-dist/FocusDesk-Setup.exe --test-user-data-dir "C:\isolated-test\userdata"
```

此参数会让测试版快捷方式、启动和 shutdown 全部指向指定测试数据目录，并使用独立 AppId；manifest 标为 `testBuild:true`。测试还可加 `--test-app-version 0.1.1`，只有同时指定隔离数据目录时才接受版本覆盖，用于真实升级验收。仅供隔离验证，不作为正常发行包。正常发行命令不带测试参数，使用根 package.json 的版本。

用户使用说明由 `docs/WINDOWS_DESKTOP.md` 提供。本轮安装包未代码签名；安装/升级/卸载实测范围与尚未完成的跨机器验证以主项目测试报告为准。
