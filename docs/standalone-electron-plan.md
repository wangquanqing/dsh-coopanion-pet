# 重新评估（二）：依赖 Electron 重做，带独立聊天面板

> 2026-10-20。**这份取代上一份 `standalone-reevaluation.md` 的结论。**
>
> 你给了两个参照：
> 1. **[Trae 桌面悬浮球](https://docs.trae.cn/ide_desktop-companion-robot)**（官方文档 + 你给的截图）
> 2. **[takboo/dsh-coopanion](https://github.com/takboo/dsh-coopanion)**（同类 DSH 插件的实证）
>
> 你的要求变了：**做，依赖 Electron 运行时，并且要独立聊天面板。**

---

## 一、结论先行

**技术上全部成立，且我已实测三条关键假设。** 这是可行的工程，不是设想。

| 关键假设 | 实测结果 |
| --- | --- |
| DSH 允许插件 `spawn` 原生进程（Electron） | ✅ **成功** —— 子进程真跑起来（`code=0 out=SPAWN_OK`） |
| 插件能拿到会话服务（聊天面板的基础） | ✅ **`ctx.sessionController` 与 `ctx.sessionQuery` 都有**（走 `ctx.inject` 获取） |
| 客户端能在 DSH 之外独立渲染 | ✅ **成功** —— 无 DSH 环境下 `opaque: 6050`、她在动 |
| Electron 二进制的体积 | ✅ **151.0 MB**（158,293,649 字节），下载约 133 秒 |

**但工作量比我上一份估的多**：加了独立聊天面板后，从 ~690 行升到 **~1,900 行**。

---

## 二、两个参照给出的设计

### Trae 的形态（官方文档原文）

```
桌面悬浮球可常驻桌面，方便你快速打开 TRAE 对话浮窗。
```

它的交互设计（我从文档里摘的，这是要复刻的模板）：

| 项 | Trae 的做法 |
| --- | --- |
| 常驻形态 | **悬浮球**常驻桌面（不是全身形象） |
| 打开对话 | **点悬浮球** / **快捷键**（Win `Alt+Space`，mac `Option+Space`）/ **右键菜单** |
| 对话形态 | **浮窗**（「像在 IDE 窗口或 Agent 窗口中一样发起对话」） |
| 右键菜单 | 打开主窗口 / 打开对话浮窗 / 隐藏直到下次重启 / 停用 / 悬浮球设置 |
| 设置位置 | 主程序 **设置 → 桌面悬浮球 → 功能 → 启用** |

**注意 Trae 的取舍**：它用**悬浮球**而不是全身形象常驻。截图里也是——左下角一个圆球，
点开才是对话面板。**这比「一个大形象浮在桌面上」克制得多**，也更不挡视线。

### takboo 的形态（读源码，未运行）

| 项 | 它的做法 |
| --- | --- |
| 窗口 | `transparent: true` + `frame: false` + `alwaysOnTop: true` + `skipTaskbar: true` |
| 穿透 | `setIgnoreMouseEvents(!active, { forward: true })` |
| 跨屏 | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` |
| 启动 | 宿主侧 `spawn` Electron 子进程 + IPC |
| 聊天 | 走 `sessionController.prompt()` + `sessionQuery.observeSession()` |
| 托盘 | 有（`Tray` + `nativeImage`） |
| 系统通知 | 有（`powerMonitor` + `Notification`） |

**两者合起来就是你要的**：Trae 的**产品形态**（悬浮球 + 浮窗 + 快捷键 + 右键菜单）
+ takboo 的**技术实现**（Electron 窗口 + DSH 会话服务）。

---

## 三、实测证据（这一节是这份评估与上一份的根本差别）

### 3.1 DSH 允许插件 spawn 原生进程 `[已验证]`

我写了一个最小探针插件，在 `apply` 里 `spawn('cmd', ['/c', 'echo SPAWN_OK'])`：

```
apply 执行了
spawn 调用成功（未抛异常）
子进程退出 code=0 out=SPAWN_OK      ← 真的跑起来了
```

**这是 Electron 路线的第一前提，它成立。** 上一份评估里我把这条列为「未验证、最关键」，
现在是**已验证**。

### 3.2 会话服务可用 `[已验证]`

同一个探针加 `ctx.inject(['sessionController'])`：

```
inject sessionController 回调执行了
  sessionController = 有
  sessionQuery = 有
  sessionController 上的方法: agents, commands, controlState, history, listState,
                              openPath, fileApplications, revealPath, canOpenPath, promotions
```

**关键细节**：在 `apply` 里直接 `ctx.get('sessionController')` 拿到的是**空**
（服务还没就绪）；**必须走 `ctx.inject`**。这是实现时要记住的。

`sessionController` 上的 `prompt()` 就是聊天面板的核心：

```ts
prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// takboo 的用法：
controller.prompt({
  sessionId, requestId, mode: 'queue',
  content: [{ type: 'text', text }], clientTimeZone,
}, signal)
```

还有 `create()` / `list()` / `rename()` / `openWorkspacePath()`——足够做一个完整聊天面板。

### 3.3 客户端能脱离 DSH 渲染 `[已验证]`

（上一份已测，此处沿用）无 DSH 环境下：`hasCanvas: true`、`opaque: 6050`、
`layout: {x: 936, mode: 'sit'}`、`toolBtns: 6`。

### 3.4 Electron 体积 `[已验证]`

```
electron-v44.7.0-win32-x64.zip → Content-Length: 158,293,649 字节
                              → 151.0 MB
（npmmirror 实测下载速度：1MB / 0.9 秒 → 全量约 133 秒）
```

**上一份里我把这条标为「未实测，按公开资料 ~100–150MB」——现在是实测的 151.0 MB。**

---

## 四、重新算工作量

### 要新写的部分

| 模块 | 量 | 参照 / 说明 |
| --- | --- | --- |
| Electron 主进程 | **~300 行** | 窗口 + 托盘 + 穿透判定 + 生命周期（takboo 的 `main.cjs` 278 行） |
| 宿主侧桥接 | **~200 行** | `spawn` + IPC + 状态机 + 异常恢复（takboo `bridge.ts` 172 行） |
| 静态服务 | **~80 行** | serve `assets/`（我的探针 40 行够用，加缓存/范围请求） |
| **独立聊天面板（新要求）** | **~700 行** | 见下节拆解 |
| 浮窗与悬浮球的形态切换 | **~150 行** | Trae 那种「球常驻、点开成浮窗」 |
| 快捷键（Alt+Space 等） | **~60 行** | Electron `globalShortcut` |
| 右键菜单 | **~120 行** | Electron `Menu`（Trae 的 5 项） |
| 与 DSH 的共存收敛 | **~100 行** | 避免「两个她」 |
| 设置项 | **~120 行** | 复用现有 `settings.section` |
| **合计** | **~1,830 行** | |

### 独立聊天面板的拆解（新要求，约 700 行）

| 部分 | 量 | 说明 |
| --- | --- | --- |
| 会话列表 | ~120 行 | `sessionController.list()` + 渲染 |
| 历史读取 | ~150 行 | `sessionQuery.observeSession()` + 消息投影（含工具调用折叠） |
| 发送 | ~120 行 | `prompt()` + 幂等（`requestId`）+ 乐观更新 + 失败回滚 |
| 流式接收 | ~120 行 | 订阅会话事件，增量渲染 |
| 渲染（Markdown/代码块） | ~100 行 | takboo 用了 `marked` + `dompurify`（两个依赖） |
| 会话切换与草稿 | ~90 行 | |

### 可复用的（这一块是白捡的）

| 部分 | 说明 |
| --- | --- |
| 渲染内核 + 形象 | `kit/`、`whale/`（12M）、`coo/`——**逐字节相同，实测能独立跑** |
| 客户端逻辑 | 气泡/装扮/音效/足迹/状态/对话栈/i18n（3,432 行）——**已实测能脱离 DSH** |
| `ModuleLoader` 适配层 | `preview-client.js`（77 行）**已存在** |
| 宿主侧工具与通道 | 12 个 `pet_*` 工具、SSE + POST（2,086 行）——与界面无关 |
| HTTP 通道 | 已是普通 `EventSource` + `fetch`，不需改造 |

---

## 五、代价（实测过的不再是估算）

| 项 | 量 |
| --- | --- |
| **Electron 运行时** | **151.0 MB**（实测）+ 首启下载约 133 秒（实测速度） |
| 新增依赖 | `marked` + `dompurify`（聊天面板渲染），或自己写最小 Markdown |
| 进程管理 | DSH 没开/开了/关了三种状态 + 异常退出恢复 + 单例 |
| 打包 | npm 包从「纯资源」变成「带原生依赖」，卸载要清运行时 |
| 平台差异 | takboo 为三平台各写了键盘活动检测（Windows C#、Linux Python、macOS JXA）——**如果我做「让位」功能就需要类似东西** |

---

## 六、与 Trae / takboo 的差异定位

| | Trae 悬浮球 | takboo | **我打算做的** |
| --- | --- | --- | --- |
| 常驻形态 | 悬浮球 | 全身形象 | **鲸鱼娘形象**（已有，不是球） |
| 对话面板 | 浮窗 | 聊天面板 | **独立聊天面板** |
| 与 DSH 的关系 | 是 TRAE 的一部分 | DSH 插件 | DSH 插件 |
| 形象 | 宠物（可选） | 大肥鱼 | **已有的 WebGL 鲸鱼娘 + Coo + 第三方包** |
| 工具 | TRAE 的 | 无 | **12 个 `pet_*` 工具**（已有） |

**我的差异化**：形象与工具是现成的（渲染内核逐字节相同、12 个工具已跑通），
而且有**形象包系统**（第三方可以导入角色）。**这些是 Trae 与 takboo 都没有的。**

---

## 七、建议的实施顺序

分五步，每步都能单独验收——**不要一次做完**。

| 步 | 内容 | 量 | 验收方式 |
| --- | --- | --- | --- |
| **1** | Electron 壳：起窗口、加载现有 `assets/`、透明+穿透+置顶 | ~400 行 | 她出现在桌面上、能穿透、能置顶 |
| **2** | 与 DSH 的连接：连上 SSE、工具能指挥她、DSH 页面连上时收敛 | ~250 行 | `pet_say` 能让她在独立窗口里说话 |
| **3** | 悬浮球形态 + 快捷键 + 右键菜单 | ~330 行 | 复刻 Trae 的交互（球常驻、点开、Alt+Space） |
| **4** | **独立聊天面板** | ~700 行 | 在浮窗里能看到会话列表、读历史、发消息 |
| **5** | 设置项 + 托盘 + 打包 | ~250 行 | 装机、开关、卸载干净 |

**第 1 步就能看到东西**——这是最重要的：**先把「她在桌面上」做出来，再谈聊天面板。**

**第 1 步之前要先验的一条**（我还没验）：

> **Electron 窗口在 DSH 的插件进程里能否真正显示**（不只是 `spawn` 成功）。
> 我验的是 `spawn` 能跑，但**没验 Electron 的 GUI 能否弹出来**——
> 插件进程的环境变量、会话、显示上下文都可能影响。
> **这是动手前必须验的第 1 条。**

---

## 八、我没验的（如实列出）

| 项 | 为什么没验 |
| --- | --- |
| Electron GUI 能否在插件进程里显示 | 需要先装 Electron（151MB 下载）——**这是第 1 步之前必须补的** |
| 插件进程的环境变量是否适合 GUI | 同上 |
| DSH 的审批策略是否会拦 `spawn` | 我的探针没被拦，但**探针是本地 file: 安装、未走 npm 分发**；真实安装路径可能有别 |
| takboo 的实际运行效果 | 只读了源码，**没安装运行** |
| Trae 悬浮球的实际交互细节 | 只有文档与一张截图，**没装 Trae** |

---

## 九、一句话

**这条路成立，而且我实测过三个前提。** 剩下的风险集中在「Electron GUI 能否在插件进程里弹出来」——
那是第 1 步就能验的事，**建议先花半天做第 1 步的最小验证，再决定要不要投入 1,830 行。**