# FocusDesk 开发交接

整理日期为2026-11-13，交接版本为0.2.0。目标仓库为GitHub私有仓库 `flowersea123/FocusDesk`。

后续 Mac 开发扩展见本地 `codex/mac-device-simulator` 分支，含 `npm run dev`、真实 Hub 驱动的 `/simulator` 页面、macOS 数据锁和可重跑的固件主机像素校验。启动和本轮验证见 [Mac 本机开发与设备模拟](MAC_DEVELOPMENT.md)。本页末尾保留原 Windows 交接批次的验收记录。

## 已完成与待开发

已具备本地Hub任务编辑、文件持久化、25分钟专注、建议文本编辑、共享电子纸排版、手机配网、有效配置NVS保存和Windows安装包。当前任务上限十项，电子纸展示五条未完成任务。

后续重点是AI模型接入、自动生成建议和任务展示规则。现有建议由用户手动输入。建议字段上限120个UTF-16代码单元，电子纸展示英文与最多两行。设备字体当前仅覆盖可打印ASCII。

任务展示修改集中在 `contracts/display-snapshot.ts`。前端入口为 `frontend/src/App.tsx`，任务编辑为 `TaskEditor.tsx`，建议编辑为 `AISuggestionEditor.tsx`。HTTP入口为 `backend/src/service.ts`，持久化与版本冲突处理为 `overview-loader.ts`。

## 数据与通信

浏览器在本机写入任务或建议，后端校验revision并原子保存文件。开发板请求 `GET /api/v1/display-snapshot`，Hub调用共享布局生成器返回绘图指令。设备使用Hub地址与revision共同识别显示版本，正常每30秒轮询，相邻刷新尝试至少间隔60秒，失败逐步退避。

主要接口如下。

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/daily-overview` | 完整任务与专注数据 |
| `PUT /api/v1/daily-overview/tasks` | 保存任务 |
| `PUT /api/v1/daily-overview/focus` | 开始或退出专注 |
| `PUT /api/v1/daily-overview/ai-suggestion` | 保存建议 |
| `GET /api/v1/display-snapshot` | 设备绘图指令 |
| `GET /api/v1/server-info` | 连接与Hub验证信息 |

写入沿用本机同源权限和409冲突处理。完整字段、边界及错误语义见 [API契约](API_CONTRACT.md)。

仅修改Hub布局时，应同步更新显示revision前缀，使数据未变的设备也能识别排版更新。新增指令、改变协议版本或使用固件尚未内置的字体，需要配套更新固件。

## 开发环境与首次启动

按根README安装前端依赖、复制示例任务文件、构建并启动。后端使用Node.js 24内置模块。保留 `frontend/package-lock.json`，使用 `npm --prefix frontend ci` 安装依赖。

当前源码开发数据在 `backend/data/tasks.json`，安装版使用 `%LOCALAPPDATA%\FocusDesk`。仓库提供 `backend/data/tasks.example.json`，本地真实任务由Git忽略。源码示例采用固定日期，当前产品尚无自动跨日任务筛选。

## 固件构建与升级

统一入口是 `firmware/focusdesk_device/focusdesk_device.ino`。它复用了 `firmware/experiments/focusdesk_provisioning_poc/` 和 `firmware/focusdesk_live/`，重建时保留目录层级。

依赖版本为Arduino-ESP32 Core3.3.12、Adafruit GFX1.13.0与BusIO1.17.4。ArduinoJson7.4.2已随源码提供。先运行 `node scripts/prepare-provisioning-poc.mjs`，生成忽略的 `private_config.h` 和 `.cache/p1-local/connection.txt`。

最直接的构建方式是在Arduino IDE打开统一入口并验证。沿用设备已成功使用的板卡、Flash、分区、USB与PSRAM设置，Debug Level选None。普通上传保留NVS时应关闭Erase All Flash Before Sketch Upload。

项目构建脚本使用Arduino IDE自带CLI，以及本地 `.cache/arduino-cli.yaml`。新机器可在已安装环境下创建以下配置，替换占位路径。

```yaml
directories:
  data: '<Arduino15 directory>'
  downloads: '<project-root>/.cache/arduino-downloads'
  user: '<Arduino sketchbook directory>'
build_cache:
  path: '<project-root>/.cache/arduino-build-cache'
```

安装Windows版Arduino IDE时，Arduino15默认在 `%LOCALAPPDATA%\Arduino15`，sketchbook通常在用户Documents下的Arduino目录。脚本所需编译器和SDK版本由Core3.3.12安装提供。随后运行以下命令。

```powershell
.\scripts\build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device
```

脚本默认采用通用ESP32-S3编译配置。实物仍按原IDE成功设置确认。编译清单在 `.cache/device-latest-build.json` 指向的文件中。当前固件使用USB手动上传，配网页面管理Wi-Fi和Hub地址。设备已有最新兼容固件后，日常编辑任务与建议会通过网络同步。

## 交接验收

软件验证包括契约和后端、前端、HTTP集成、便携打包、原生托盘、导入、安装包和配网页面测试，另执行固件主机渲染检查、像素比对和ESP32目标编译。结果记录在本页末尾。

接手后的实物验收按以下流程执行。

1. 安装或启动Hub，并确认能打开设备连接页。
2. 设备供电，按已保存配置连接，必要时按RST进入手机配网页面修改Wi-Fi与Hub地址。
3. 保存任务修改，观察设备下一次同步后的画面。
4. 开始并退出专注，检查任务优先顺序和结束时间。
5. 保存及清空英文建议，检查底部内容。
6. 测试超过五条任务、空列表与全部完成。
7. 重启设备，检查配置恢复与重新同步。

本次整理的实物验证仍待设备持有人执行。旧版硬件验收记录具有各自的日期与版本，最新Nunito布局需要配套固件确认。

## 清理、隐私与发布

删除对象限定为可重新生成的废弃缓存与重复产物。历史配网、联网和静态模块因共享依赖及诊断用途继续保留。历史发布档案由维护者本地保存，GitHub交接发布使用本次构建。

Git忽略覆盖个人任务、私有固件配置、连接卡所在缓存、开发代理配置、日志、构建产物及常见密钥文件。两个本地私有配置中的实际网络信息已做精确值复查，计划发布源码中没有复制这些值。发布前再次核对Git候选文件和最终安装payload。当前源目录原先没有Git历史，本次建立首个版本。

仓库为私有。固件与第三方资源保留各自许可，Windows应用自有代码的统一许可由所有者决定。固件二进制含本地热点配置，本次源码仓库与Release提供Windows安装包及其清单。

## 本次验证结果

| 验证 | 本次结果 |
| --- | --- |
| TypeScript与Vite生产构建 | 通过 |
| 契约、后端、集成、打包、托盘、导入、安装及配网Node回归 | 270项通过，零失败、零跳过 |
| 前端回归 | 59项通过 |
| 隔离实际安装、升级、卸载 | 1项通过，空PATH启动及数据保留通过 |
| 固件主机渲染、同步、配网与NVS | 1149项检查通过 |
| JS与原生帧缓冲像素比对 | 21个场景各120000像素一致 |
| 从Git候选内容导出源码并使用示例数据启动 | Dashboard、连接页、数据接口与显示快照通过 |
| 源码与安装payload隐私复查 | 219份源码文件、34份payload文件通过，安装包SHA-256一致 |
| ESP32完整编译与链接 | Core3.3.12通过，Flash1002189/1310720字节，静态RAM83004/327680字节，源码与BIN/ELF/MAP哈希核对通过 |
| 最新固件上传与实物验收 | 待设备持有人执行 |

本次清理删除795份npm缓存文件与2份中止构建的临时记录，共228200867字节。旧配网、联网与静态模块保留共享依赖与诊断用途。

回归修正了旧托盘和便携包测试夹具遗漏 `ai-suggestion.ts` 的问题，并将HTTP集成测试中已移除的work_state编辑区断言更新为当前任务和建议保存入口。

Windows安装包版本为0.2.0，SHA-256为 `949d06ea8564a62842d24f2ba92a30a6a6220006d2fed576cfadbdf610d950d5`。Release同时附payload哈希清单。软件回归中的安装升级场景使用测试版0.1.0到0.1.1覆盖相同最新源码，正式交接安装包使用0.2.0。
