# Source Sans 3 字形构建

2026-11-11。项目使用Source Sans 3原始TTF字形，通过Adafruit GFX官方fontconvert与FreeType生成可打印ASCII单色位图。

## 固定输入

| 输入 | 固定版本或来源 | SHA-256 |
| --- | --- | --- |
| Source Sans 3 Regular | Version3.052，Adobe commit `87b37a2daaed80fcb8e8ccb0085c4d72ddade12e` | `4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f` |
| Source Sans 3 Bold | 同一commit与版本 | `9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a` |
| 官方LICENSE.md | 同一Adobe commit，SIL OFL1.1 | `56af9b9c6715597e458284a474dc118a50a4150e9d547c70f7b4a33c3e6a9328` |
| FreeType源码 | 官方2.13.3 tar.xz | `0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289` |
| GFX fontconvert.c | 已安装Adafruit GFX1.13.0 | `b73dacc8694731a9b33c439fbbfb426ad6b383b3d3a8974df756d5dff016cd11` |
| GFX gfxfont.h | 同一Adafruit GFX版本 | `4e1b06371217d63102bac242d4a3ec8dcaff93cd34b4241bbc39eda521a1be11` |

字体源文件和完整许可来自Adobe官方仓库，FreeType源码来自官方发行站点。脚本使用固定commit和完整哈希核验下载缓存。[Adobe字体来源](https://github.com/adobe-fonts/source-sans/tree/87b37a2daaed80fcb8e8ccb0085c4d72ddade12e) · [FreeType发行目录](https://download.savannah.gnu.org/releases/freetype/)

TTF保留原始Version3.052和Adobe版权。生成头文件记录字体来源、Reserved Font Name ‘Source’、转换参数及输入哈希，完整官方OFL许可保留在 `firmware/focusdesk_device/fonts/SourceSans3-LICENSE.txt`。当前官方许可通知为2010–2024 Adobe，字体文件内嵌版权为2010–2023 Adobe。

## 复现命令

从项目根目录运行下列脚本。

```powershell
.\scripts\generate-source-sans-fonts.ps1
```

开发者环境需要MinGW GCC、Windows自带tar及已安装的Adafruit GFX1.13.0。脚本的可选参数为 `-CompilerPath` 和 `-GfxDirectory`。首次运行下载固定FreeType源码及字体，随后可使用已核验缓存离线重现。

FreeType按其 `docs/INSTALL.ANY` 的直接源码构建方法编译。本项目的开发工具配置启用TrueType、SFNT、PostScript名称、自动提示、单色与平滑光栅模块，全部构建输入和中间文件存放在 `.cache/source-font-tools/`。fontconvert可执行文件仅依赖Windows系统KERNEL32.dll和msvcrt.dll。

实际字形参数为141DPI、TrueType interpreter35、`FT_LOAD_TARGET_MONO`、`FT_RENDER_MODE_MONO`，字符范围U+0020–U+007E，共95个。转换器逐字形导出像素、advance和相对基线偏移。共享预览和固件直接使用这些位图与度量。

## 生成资源

| 文件和C标识 | 字号 | 头文件SHA-256 |
| --- | --- | --- |
| SourceSans3Regular9pt7b | 9 | `4c4a0c230058ddae85248b69f36fe807ae025ec680f30906067df87347d214cc` |
| SourceSans3Bold9pt7b | 9 | `bfca7653f51f59888bbaa65ef27113d9b2b70b7188e3a13b8f982b93d4b07ff9` |
| SourceSans3Bold18pt7b | 18 | `bfeb92da208831786d5c554b34fca93948dc0f7c5f7c1e4ddee3b4f020dd8180` |
| SourceSans3Regular12pt7b | 12 | `4f1c5fc85c3001dd9377759d6ca02188111adba4b9e006ec9d63b9ef0cf5bd45` |
| SourceSans3Bold12pt7b | 12 | `881ff9bcd6ca568e838493524ed2170907d771611e8a0fe9b81bb85756170576` |

头文件位于 `firmware/focusdesk_device/fonts/`，均包含Arduino/GFX必要声明。转换过程中每份资源均检查95个ASCII glyph和预期C标识，五次转换的stderr为空。实际原生fontconvert构建成功，编译日志为空，结构化构建记录为 `.cache/source-font-tools/build-manifest.json`。

本步骤只生成字形并验证可复现输入。完整ESP32目标构建、共享快照像素对照和实物屏幕验收由Tech Lead统一记录。
