# FocusDesk 统一设备固件

Arduino IDE打开本目录的 `focusdesk_device.ino`。这是手机配网、NVS保存和原电子纸任务/专注同步的统一上传入口。

## 当前英文界面

顶部显示FOCUSDESK、日期、Tasks和完成数量。总览最多显示四条未完成任务，任务名称使用固件已有的较大 FreeSans 字形。当前专注任务优先且加粗，其余任务保持保存顺序，超出四条时显示剩余数量。黄色圆角区域显示网页保存的英文AI建议，最多两行，清空时显示No suggestion yet.。

采用当前显示快照协议的设备只需重启更新后的 Hub 即可读取新排版。设备读取 `/api/v1/display-snapshot`，由Hub生成布局和文字截断，固件执行相同绘图指令。任务使用现有字体编号 0、1，页眉和建议继续使用已有 Nunito 字形。网页原生字体有抗锯齿，设备使用单色位图字形。

建议使用英文。已有非英文建议会在设备上显示Use English for device suggestions.，可在主页AI建议输入栏修改。网页中的多任务示例属于排版预览，设备读取实际保存的任务和建议。

## 上传与首次使用

1. 电脑运行更新后的FocusDesk，在设备连接页面查看局域网IPv4与端口。配网页面的Hub地址填写 `http://电脑局域网IPv4:端口`。
2. IDE沿用之前成功的板卡、USB、Flash、分区和PSRAM设置，固定Arduino-ESP32 Core3.3.12，Debug Level=None，Erase All Flash Before Sketch Upload=Disabled，验证后手动上传。
3. 手机连接原来的 `FocusDesk-Setup-XXXXXX` 热点，打开 `http://192.168.4.1`，填写路由器2.4GHz Wi-Fi名称、密码和Hub地址并保存。
4. 若板上已有P2保存的有效配置，普通上传且分区不变时会直接读取该记录，自动连接Hub。页面应显示已保存配置的连接结果。
5. Dashboard保存一条任务修改，观察电子纸自动更新。成功轮询间隔30秒，相邻刷新间隔至少60秒，刚刷新后修改请留出约1–2分钟，包含全刷耗时。
6. 开始/退出专注，分别观察专注页和总览恢复。拔电再上电后确认自动连接并重新读取当前任务。

热点窗口为10分钟，之后设备继续连接Hub并轮询任务。按RST重新打开修改窗口。保存新配置失败时保留并恢复旧的有效配置。手机因AP+STA切换信道掉线时，重新加入设备热点即可查询结果。

热点密码沿用本地连接卡 `.cache/p1-local/connection.txt`。首次准备仍运行 `node scripts/prepare-provisioning-poc.mjs`，生成器保留已有本地密钥。Hub通过页面填写和修改；ESP32使用同一局域网可达的HTTP IPv4地址。

## 复用与行为

统一入口包含原P2模块的 `provisioningSetup/provisioningLoop`，复用其受保护AP、异步试连、Hub验证及同一 `focusdesk_p2` NVS命名空间。原独立配网sketch继续可单独运行。

统一固件复用 `live_model.h` 的基础解析工具，通过 `display_snapshot.h` 执行Hub的共享布局。显示驱动和GPIO来自已有联网工程。正常30秒读取、失败退避、60秒刷新保护继续生效。来源Hub和显示revision共同标识已显示版本，同revision的其他Hub会重新显示。网络或解析失败保留最后有效画面，显示失败时记录屏幕状态未知并受控重试。

电子纸全刷由原驱动同步执行。刷新期间配置请求可能排队，刷新完成后处理；HTTP页面服务仍由独立任务运行。配置候选试连/保存期间暂停任务读取和新显示，候选完成或失败回退后恢复。

NVS采用P2普通明文存储；擦除Flash、变更分区表或Core默认NVS分区恢复仍可能清除配置。自动发现和设备配对属于后续阶段。

## 仅编译

```powershell
.\scripts\build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device
```

脚本跟踪入口和所有项目内引用源的哈希，生成 `.bin/.elf/.map` 及manifest，仅编译。统一入口的成功构建清单位于 `.cache/device-latest-build.json`。运行heap和实物同步结果需用户上传后确认。

许可沿用现有固件GPL-3.0-only，见 `firmware/LICENSE`。

Nunito字体来自Google Fonts固定提交 `8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f`，采用SIL OFL1.1，原始版权与许可在 `fonts/Nunito-LICENSE.txt`。生成脚本为 `scripts/generate-device-ui-fonts.ps1`，使用已准备的FreeType2.13.3缓存和原生GFX转换工具，显式设置像素尺寸及变量字重。构建字形清单位于 `.cache/device-ui-font-tools/manifest.json`。
