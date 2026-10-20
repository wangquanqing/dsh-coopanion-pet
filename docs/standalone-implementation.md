# 独立窗口实现记录（v1.9.0，随 v1.9.1 发布）

> 2026-10-20。把桌宠做成**依赖 Electron 运行时的独立应用**：
> 桌面上一个真透明、可穿透、置顶的窗口，带全局快捷键、右键菜单、托盘与独立聊天面板。
>
> 参照三家：**本机上游 Coopanion**（同源架构）、**[takboo/dsh-coopanion](https://github.com/takboo/dsh-coopanion)**（同类 DSH 插件的实证）、
> **[Trae 桌面悬浮球](https://docs.trae.cn/ide_desktop-companion-robot)**（产品形态）。

---

## 一、五步交付，每步都实测验收

| 步 | 内容 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| **前提** | Electron GUI 能否在插件进程里弹出 | ✅ | `isVisible=true alwaysOnTop=true` |
| **1** | Electron 壳（窗口 + 透明/穿透/置顶 + 加载 assets） | ✅ | `opaque: 5864`、`bg: rgba(0,0,0,0)`、截图确认她渲染出来了 |
| **2** | 与 DSH 连接（SSE + 工具 + 共存） | ✅ | `online: true`、**闭环回执 `{ok:true}`** |
| **3** | 形象常驻 + 右键菜单 + 全局快捷键 | ✅ | `tray created`、`hotkey Alt+Space = registered` |
| **4** | 独立聊天面板 | ✅ | `count: 16` 会话、真实标题「皮肤插件设置恢复默认」 |
| **5** | 托盘 + 设置项 + 打包 | ✅ | 设置面板「独立窗口」组 4 行、tgz 11.6MB、**打包件端到端验收通过** |

**打包件验收**（从 `.tgz` 装，不是源码目录）：

```
启动: {ok:true, port:12267}
状态: {running:true, port:12267, online:true}
闭环回执: {ok:true}
Electron: 托盘 ✓ 快捷键 Alt+Space ✓ 窗口 visible ✓
interactive=true                    ← 穿透判定在工作
```

---

## 二、架构

```
DSH 宿主进程
  └─ 插件 index.js
       ├─ 起本地 bridge 服务（刻意不在 /api 下 → 不走鉴权）
       │    ├─ /dsh-coopanion-pet/desktop/events   → 挂进同一条 channel
       │    ├─ /dsh-coopanion-pet/desktop/report   → 交回 handleReport
       │    └─ /dsh-coopanion-pet/chat/{list,history,send}
       └─ spawn Electron 子进程（desktop/main.cjs）
            ├─ 自己的静态服务（镜像 DSH 路由形状 → client.js 一个字不用改）
            ├─ 宠物窗口（transparent + alwaysOnTop + setIgnoreMouseEvents）
            └─ 聊天面板窗口
```

### 三个关键设计

**1. 独立窗口连的是同一条 `channel`** —— 因此 `pet_*` 工具、状态气泡、语音、审批
**全部照旧可用**，不是另做一套。这是「完整能力」的实现方式。

**2. bridge 刻意不在 `/api` 下** —— 独立窗口没有 DSH 的 cookie，走 `/api` 会被 401。
（这是做 v1.8 沙箱时踩过的同一个根因。）

**3. Electron 自己起服务，镜像 DSH 的路由形状** —— `client.js` **一个字都没改**。
因此 DSH 没开时她也能出现（静态资源由 Electron 自己提供）。

---

## 三、参照三家的取舍

| | Trae 悬浮球 | takboo | **本实现** |
| --- | --- | --- | --- |
| 常驻形态 | 悬浮球 | 全身形象 | **全身形象**（用户明确要求「悬浮球换成宠物形象」） |
| 对话面板 | 浮窗 | 聊天面板 | **独立聊天面板**（与 DSH 同批会话） |
| 快捷键 | `Alt+Space` | — | **`Alt+Space`**（与 Trae 一致） |
| 右键菜单 | 5 项 | — | **7 项**（含穿透/置顶两个开关） |
| 形象 | 宠物（可选） | 大肥鱼 | **WebGL 鲸鱼娘 + Coo + 第三方形象包** |
| 工具 | TRAE 的 | 无 | **13 个 `pet_*`** |

**差异化**：形象与工具是现成的，且有**形象包系统**（第三方可导入角色）——这是另外两家没有的。

---

## 四、过程中修掉的 9 个真 bug

| # | bug | 现象 | 根因 |
| --- | --- | --- | --- |
| 1 | **未声明变量** | 插件加载失败、全 404 | `desktopBridge` 只有赋值没声明 → ESM 严格模式抛 `ReferenceError` |
| 2 | **`files` 字段缺 `desktop`** | 「找不到 desktop/main.cjs」 | pnpm 按 `files` 过滤，**源码目录里看不出来** |
| 3 | **spread 顺序反了** | 状态永远 `running: false` | `{...state, ...status}` 让默认值覆盖真实值 |
| 4 | CommonJS/ESM 混用 | `does not provide an export` | bridge 写成 `module.exports` 而 index.js 是 ESM |
| 5 | 进程树残留 | 宿主退出后 4 个 `electron.exe` 不走 | `child.kill()` 只杀主进程 → 改 `taskkill /T /F` |
| 6 | **`await` 在非 async 函数** | 语法错误 | bridge 的 handler 是普通函数 |
| 7 | **prefix 路由带尾斜杠** | `/chat/history` 404 | 与 v1.8 包路由**同一个坑**（第二次踩） |
| 8 | **会话标题读不到** | 显示 `session-a5ae` | `list()` 的行**没有 `title`**，标题在 `projections` 里 |
| 9 | **旧实例占端口** | 新代码验证全 404 | 旧宿主还占着 18968，加载的是旧代码 |

### 两条重要教训

1. **`node --check` 查不出未声明变量** —— 后来改用 `import()` 验证模块能真加载，才抓到 bug 1
2. **验证前必须确认没有旧实例占着端口** —— 否则结果完全失真，我因此误判了一次

---

## 五、Electron 运行时的分发

**实测体积：151.0 MB**（`electron-v44.7.0-win32-x64.zip`，158,293,649 字节），
下载约 133 秒（本机实测速度）。

**策略：`optionalDependencies`**（与 takboo 一致）：

```json
"optionalDependencies": { "electron": "^44.7.0" }
```

**查找顺序**（`lib/desktop-bridge.js` 的 `findElectron`）：
1. 偏好里指定的路径（设置面板可填）
2. 插件自带（`desktop/electron/`，打包时可放）
3. 环境变量 `DSH_COOPANION_ELECTRON` / `ELECTRON_EXECUTABLE`
4. npm 装的 `electron` 包

**找不到时**：独立窗口不可用，**但本体照常**——如实回报 `no-electron`，不假装成功。

---

## 六、已知限制（如实列出）

| 项 | 说明 |
| --- | --- |
| **GPU 环境** | 本机验证时用了 `--no-sandbox --disable-gpu --use-gl=swiftshader`；有真实 GPU 的机器上不需要这些参数（但保留它们不影响） |
| **三平台差异** | 只在 Windows 上验证过。Linux/macOS 的 `taskkill` 路径走了 `child.kill('SIGTERM')`，**未实测** |
| **让位空闲检测** | takboo 为三平台各写了键盘活动检测（Windows C#、Linux Python、macOS JXA）；**本实现没做**——她的状态气泡不会因「用户在打字」而让位 |
| **聊天面板的 Markdown** | 只做纯文本 + 换行，没做 Markdown/代码块渲染（takboo 用了 `marked` + `dompurify`） |
| **图片附件** | 面板不支持发图（DSH 的 `attachment` API 没接） |
| **多显示器** | 窗口开在主显示器的 workArea 上；**跨屏移动未做** |
| **面板不跟随主题** | 用 `prefers-color-scheme`，不跟 DSH 的主题设置 |
| **`openMainWindow`** | 用 `shell.openExternal` 打开 DSH 的 URL——**在无 GUI 环境失败被吞**，未实测真实效果 |

---

## 七、v1.9.1：独立窗口之外的两件收尾

v1.9.0 把独立窗口做出来了，但**发布链条上还有两个洞**，v1.9.1 一并补上：

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | **`pet_set` 在默认设置下 100% 失败**（v1.8 遗留，与独立窗口无关） | 见下节 |
| 2 | **npm 上没有 1.9.0，而文档教人装 `@1.9.0`** | 1.9.1 才真正发到 npm；`docs/standalone-usage.md` 与 README 的版本号同步改过来 |

另外两处文档/打包不一致：**README 指向 `docs/standalone-usage.md`，但 `package.json` 的 `files` 不含 `docs/`**
（从 npm 装的人点开是 404），v1.9.1 把 `docs/` 与 `FEATURES.md` 一并打进包里。

**发布结果（2026-10-20 14:42）**：`npm 1.9.1` 已发，`dist-tags.latest = 1.9.1`，
`gitHead = 1a3ad65`（与远端 `main` 一致）；从 registry 拉的 tgz shasum `5954208…`
与本地 `npm pack` 产物**逐字节相同**。装进临时 profile 验过：`docs/` 九个 md 齐全、
`apply` 是函数、13 个工具造得出来、包内 `pet_set` 的三条回报与 `self-adjust` 判定都符合预期。

**1.9.0 始终没在 npm 上**——它只作为代码与 tag 存在。装 1.9.x 请用 **1.9.1**。

### `pet_set` 的 ask 层：从「一律拒绝」到「真的问一句」

**症状**：默认设置下，模型调 `pet_set` 改任何东西都回 `needs-approval`——包括只改漫游倾向这种
本来就不该问的。而所谓「工具侧已经问过了」的 `confirmed` 字段，**从来没有调用方传过**。

**根因**（三处叠加，见 `client.js` 的 `set` 分支）：

1. 判据把 7 个 ask 类键**无条件**列出来，不看这次到底改不改它们；
2. `DEFAULT_SELF_DIRECT` 里 `sound` 等项本来就属 ask，于是 `needsAsk('sound')` 在默认档恒为真；
3. 工具侧不传 `confirmed`，也不认识 `needs-approval`，模型只能收到一句泛化的失败。

**修法**：把判定抽成纯逻辑 `assets/self-adjust.js`，页面**真的问**一句，工具等答案再回报。

| 层 | 做什么 |
| --- | --- |
| `assets/self-adjust.js` | 四级模式 → 逐项档位（`directMap`）；只判**本次 patch 里出现的键**（`planSelfPatch`）；回答解读（`readConsent`） |
| `client.js` 的 `set` | 先规划、再问（可以 / 以后都行 / 不用了）、按答案放行；回 `applied` 与 `refused` |
| `lib/tools.js` 的 `pet_set` | 等 125 秒（覆盖页面侧 120 秒兜底）；`declined` / `no-answer` / `self-adjust-off` 分开回报 |
| `assets/settings.js` | `custom` 档显示**逐项开关**，值直接问 `directMap`（避免两处规则漂移） |

**顺带修掉的一个死锁**：v1.9.0 的 `confirm` 分支超时只清等待槽、**不 resolve**，
而命令是串行执行的——一条卡住的命令会把之后的所有命令一起卡死。现在三个出口
（答完 / 超时 / 按 Esc / 纯净模式不弹气泡）都会 settle。

**验证**：25 条单测 + 真浏览器 5 个用例（见 `test/` 与 README 的「v1.9.1」表）。

---

## 八、下一步可以做的

按价值排序：

1. **让位空闲检测**（takboo 有，三家参照里唯一缺的交互细节）——用户在打字时她让位
2. **面板 Markdown 渲染** —— 代码块、表格（takboo 用 `marked`，会引入两个依赖）
3. **多显示器支持** —— 记住她在哪个屏、跨屏跟随
4. **面板发图** —— 接 DSH 的 `attachment` API
5. **Linux/macOS 实测** —— 目前只有 Windows 的验证数据
