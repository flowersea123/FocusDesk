# P3 配网与电子纸统一固件验证

日期为2026-11-07，Asia/Shanghai。

## 实现

统一上传入口 `firmware/focusdesk_device/focusdesk_device.ino` 包含P2的配置生命周期，通过已保存Hub读取原daily-overview API，再交给原DTO解析、排版和JD79668驱动。独立P2和旧联网示例均保留为可单独使用的入口。

- P2内部setup/loop改为具名的 `provisioningSetup/provisioningLoop`，独立入口仍提供原Arduino setup/loop。
- 提取原生有界HTTP传输为 `requestJson`，同时服务配置验证和任务读取。后者在AP窗口关闭后继续运行，新配置排队会取消在途任务读取。
- 新增 `DisplaySync`，复用原 `PollState`。仅新增轮询唤醒方法；正常30秒读取、60秒刷新保护、原失败退避保持生效。
- 用Hub origin和revision组合标识显示版本，切换Hub时即使revision相同也会安排新显示，同时保留刷新保护。
- 配置候选期间暂停任务同步，保存成功后使用新源，失败后恢复旧源；读取、解析失败保留最后有效快照，显示失败标记画面状态未知。
- 构建脚本跟踪引用的全部项目内源码，包含P2及原显示源。统一产物通过 `.cache/device-latest-build.json` 指向manifest。

## 已执行的软件验证

| 验证 | 实际结果 |
| --- | --- |
| 原有软件套件 | 243/243，零跳过，包括前端40项与Node203项 |
| 前端构建 | 通过，既有产物名称一致 |
| 原静态/联网固件主机回归 | 通过，含实际sketch配置/未配置、解析/排版、专注及驱动失败恢复 |
| 原P2 C++回归 | 790条断言通过 |
| 原配置页JavaScript回归 | 32/32通过 |
| 新显示同步回归 | 107条检查通过 |
| 实际传输方法提取编译/执行 | 34条C++断言通过，Node1/1 |

所有C++检查使用C++17、`-Wall -Wextra -Werror`。首次受限环境中的回环/junction/native操作因EACCES/EPERM失败，相同原软件测试在受审查的沙箱外重新执行，全部通过；没有修改测试标准。回归日志为 `.cache/p3-software-regression-native.log`、`.cache/p3-frontend-regression.log`、`.cache/p3-frontend-build.log`。

新显示同步主机测试使用原fixtures及解析器，覆盖普通任务/完成状态、专注进入/退出、离线和非法响应、配置中断、旧源恢复、跨Hub同revision、失败退避与时间回绕。传输测试编译实际方法，覆盖6秒总时限、窗口关闭后任务读取、配置排队取消、socket错误及2048/4096字节边界。

## 完整构建

固定Core3.3.12，完整编译/链接成功，进程退出码0。实际命令沿用下列入口，并加 `-Jobs 8 -ReuseBuildDirectory '.cache\p1-builds\20261104-005851-dcc87771\build'` 复用已验证缓存。板卡FQBN为 `esp32:esp32:esp32s3`，4MB/default分区，memory_type为qio_qspi、Debug0；已与此前成功P2构建的板卡/分区/Flash/USB/Debug属性对比，无差异。具体实物Flash/PSRAM仍以原IDE设置为准。

```powershell
.\scripts\build-provisioning-poc.ps1 -SketchDirectory firmware/focusdesk_device
```

完整构建耗时2998.39秒。当前环境冷构建包含依赖检测、显示库与58份Core源码编译，日志未发现warning/error/undefined reference。沿用Core默认 `-w` 告警设置，此结果表示日志没有产生告警，不能视作额外启用全部编译器告警的审计。

| 产物/容量 | 最终结果 |
| --- | --- |
| Flash占用 | 987,661 / 1,310,720字节，75% |
| 静态RAM占用 | 83,372 / 327,680字节，25% |
| 链接报告剩余动态预算 | 244,308字节，非运行heap |
| 应用.bin | 987,808字节 |
| 应用.elf | 12,674,240字节，ELF32/Xtensa，machine94 |
| 应用.map | 14,654,595字节，已确认配网生命周期、DisplaySync及原显示驱动符号 |

产物目录为 `.cache/p1-builds/20261104-005851-dcc87771/build/`，基名 `focusdesk_device.ino`。复用缓存目录名的p1前缀是历史命名，当前该目录产物为统一固件。

最终manifest为 `.cache/device-builds/20261107-144919-828c58ca/build-manifest.json`，日志同目录 `compile.log`，入口指针 `.cache/device-latest-build.json`。18份项目内源码在构建前后及完成后核对一致，固件SHA再次核验一致。

| SHA-256对象 | 哈希 |
| --- | --- |
| 入口focusdesk_device.ino | `961b43ece368d9fee6ae2555982675d6187cc91e653196a81befcc5439416188` |
| 应用.bin | `7837d38fbb231c3c211fe08d42816222298f3ed2bc2b7ba0b94f2030c8f564d4` |
| 应用.elf | `1faf7d733409f9e9dd7a4fa8b9d88a4eceae322a3433d8af0892df0cb1dd4d77` |
| 应用.map | `d4b79d961ab5658e34e1434e090be1cb08b3326f20d192da3081e60a14b8b2b5` |

实际依赖为已安装的Adafruit GFX Library1.13.0、Adafruit BusIO1.17.4，以及Core附带Wire/SPI3.3.12。本轮没有安装或升级依赖。产物可交付用户按下一节进行真机验收；本轮没有上传、擦除Flash或打开串口。

## 实物验收及边界

真实上传、串口与屏幕操作由用户执行。用户于2026-11-07确认H1手机配网/Hub连接、H2任务同步、H3专注显示、H4退出专注恢复总览、H5窗口关闭后同步、H6断电恢复配置及同步均通过。这些是用户人工真机验收结果。H7运行内存和长期稳定性暂缓，未执行。正式阶段记录见 `docs/releases/M2_RELEASE.md`。

1. 普通上传且分区不变，确认沿用P2有效NVS并自动连接。
2. Dashboard保存任务修改，等待约1–2分钟观察任务画面更新，包含原刷新保护和全刷耗时。
3. 开始及退出专注，观察专注页与总览。
4. 拔电重插，观察自动连接并重新读取当前任务。
5. AP窗口关闭后继续修改Dashboard，观察显示同步；修改网络/Hub时按RST重新打开配置。

电子纸全刷继续使用原同步驱动，可能暂缓主循环中的配置/重连处理，新请求会排队。HTTPD仍单独运行，窗口过期授权实时拒绝新写入。主机测试和目标编译不能替代上述真机确认。

Hub目前通过页面手填HTTP IPv4地址，保存新配置时需要Hub在线。NVS仍为普通明文存储，继承P2分区恢复/擦除边界。实际Flash/PSRAM设置沿用用户已工作的板卡配置，通用FQBN只表示编译基线。H1-H6的用户人工确认不替代H7运行heap、长时稳定性和更多并发网络场景测量。
