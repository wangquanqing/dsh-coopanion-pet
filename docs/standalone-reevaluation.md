# 重新评估：桌宠脱离 DSH 独立运行（2026-10-20）

> **这份文档修正 2026-10-18 的 `standalone-research.md`。**
> 那份里有一条**结论性错误**，先更正它，再基于实测重新算代价。
>
> 触发：你发现了 [takboo/dsh-coopanion](https://github.com/takboo/dsh-coopanion)——
> 它走的就是当初被搁置的那条路，而且**做成了**。

---

## 一、先更正：我当时的判断错在哪

`standalone-research.md` 里我写过三行「代价」：

| 我当时的结论 | 实情 |
| --- | --- |
| 「**窗口透明**：做不到全透明…只能近黑背景的边框窗口。**这是最大的体验损失**」 | **错**。Electron 的 `BrowserWindow` 支持 `transparent: true` + `backgroundColor: '#00000000'`，真透明 |
| 「鼠标穿透：独立窗口里做不到」 | **错**。`win.setIgnoreMouseEvents(true, { forward: true })` 是窗口级能力，比我在页面里模拟的更彻底 |
| 「置顶：`--app` 窗口默认不置顶…不一定稳定」 | **错**。`win.setAlwaysOnTop(true, 'floating')` 是原生支持 |

**错在哪**：我列的「路线 A」只考虑了 **`msedge --app` 这一个壳**，把它的局限
（那是普通浏览器窗口）当成了「独立壳这条路」的局限。**我漏掉了更直接的一条：把 Electron 作为 npm 依赖自己拉一份。**

我甚至写了「本机没有可用的 Electron 运行时」「DSH 桌面端的 Electron 不对外暴露」——
**这两条事实是对的，但结论错了**：Electron 根本不需要 DSH 提供。

我列了「5 个前置验证」，其中第 2、3 条正是「能否置顶」「透明是否真做不到」——
**如果当时验了，就会立刻发现路走得通**。我没验就下了结论。

---

## 二、takboo 的实证（读它的源码，未安装运行）

`takboo/dsh-coopanion@0.4.13`（HEAD `a5f5408`，AGPL-3.0）：

```js
// desktop/main.cjs:218-222
win = new BrowserWindow({
  transparent: true, frame: false, resizable: false, skipTaskbar: true,
  hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000', ...
});
win.setIgnoreMouseEvents(!active, { forward: true });          // 穿透
win.setAlwaysOnTop(true, 'floating');                           // 置顶
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });  // 跨屏
```

**它怎么启动**（`src/bridge.ts:58-64`）：宿主侧插件 `spawn` 一个 Electron 子进程 + IPC。

**关键：它的架构与我当初设想的是同一类。** `src/bridge.ts:33` 的注释：

> *"Owns a separate Electron window; no changes or private IPC in the Harness desktop shell are needed."*

它的 `cordis.patch.yml` 只有 4 行（注册自己），**没有改 DSH 本体**。
`electron: 44.7.0` 是正式 `dependencies`，npm 安装时自动拉运行时。

**它的工程量**（实测统计）：

| 部分 | 量 |
| --- | --- |
| `src/` + `desktop/`（宿主侧 + Electron 侧） | **3,129 行** |
| `web/`（独立界面） | **4,135 行**（443 文件，含搬来的渲染内核） |
| Electron 侧全部（`desktop/`） | **仅 188K / 12 文件**（`main.cjs` 278 行） |
| 测试 | **71 个文件** |
| 仓库（不含 .git） | 43M |

---

## 三、决定性的实测：我的客户端能不能脱离 DSH `[已验证]`

我起了一个**完全没有 DSH** 的极小静态服务（只 serve 插件的 `assets/`），
用浏览器打开——**她挂起来了**：

```
=== 独立壳（无 DSH）实测 ===
URL: http://127.0.0.1:18899/preview
{
 "hasPetApi": true,      ← window.__dshCoopanionPet 存在
 "hasLayer": true,
 "hasCanvas": true,
 "opaque": 6050,         ← 真的渲染出来了
 "layout": { "x": 936, "mode": "sit" },   ← 她在动
 "toolBtns": 6           ← 按钮条也在
}
```

**这正是 `standalone-research.md` 里「前置验证第 4 条」的正面回答。**

**为什么能成**：我在 v1.7 做的**独立预览页**已经铺好了路——`assets/preview-client.js`
里有一个 `__ModuleLoader__` 桩，专为「脱离 DSH 的加载契约」而写。**那个适配层已经存在。**

**而通道本来就是普通 HTTP**（实测确认）：`EventSource` + `fetch`，
端点是 `/api/dsh-coopanion-pet/{events,report,speech,tts}`，**不是 DSH 的私有 RPC**。

---

## 四、重新算代价（基于实测，不是估算）

### 好消息：可复用的比当初想的多

| 部分 | 状态 | 说明 |
| --- | --- | --- |
| 渲染内核 + 形象（`kit/`、`whale/`、`coo/`） | **100% 复用** | 68K + 12M + 56K，与界面无关 |
| 客户端逻辑（气泡/装扮/音效/足迹/状态/对话栈/i18n） | **100% 复用** | 3,432 行，实测能脱离 DSH 跑 |
| 宿主侧（12 个工具、通道、CUA 审批） | **100% 复用** | 2,086 行，与界面无关 |
| `ModuleLoader` 适配层 | **已存在** | `assets/preview-client.js`（77 行） |
| HTTP 通道 | **已存在** | 普通 SSE + POST，不需改造 |

### 要新写的

| 部分 | 量 | 参照 |
| --- | --- | --- |
| Electron 主进程（窗口 + 托盘 + 穿透判定） | **~280 行** | takboo `desktop/main.cjs` 278 行 |
| 宿主侧桥接（spawn + IPC + 生命周期 + 恢复） | **~170 行** | takboo `src/bridge.ts` 172 行 |
| 静态服务（serve assets） | **~60 行** | 我这次探针 40 行就够 |
| 与 DSH 的共存（避免「两个她」） | **~80 行** | 我的设想：DSH 页面连上就收起独立窗口 |
| 设置项（窗口位置、自启、透明开关） | **~100 行** | 复用现有 `settings.section` |
| **合计** | **约 690 行** | 比我当初估的 300–500 行**多**，但比 takboo 的 7,264 行**少得多** |

**为什么比 takboo 少**：它从零做了**独立界面**（聊天面板、收件箱、通知中心，`web/` 4,135 行）。
我只需要**复用已有的客户端**——它们本来就是自包含的。

### 真正的代价

| 项 | 量 / 说明 |
| --- | --- |
| **Electron 运行时** | `electron@44.7.0` 的 npm 包只有 1.17MB，但**postinstall 要下载完整二进制**。**我没能量到确切体积**（网络受限），按公开资料量级是 **~100–150MB**——**这一条请你当作「未实测」** |
| 首启联网 | 装完第一次启动要联网下载 + 校验运行时（takboo 的 README 明说） |
| 进程管理 | 要处理「DSH 没开/开了/关了」三种状态、异常退出恢复、单例 |
| 打包分发 | npm 包从「纯资源」变成「带原生依赖」；卸载要清运行时 |
| **与 takboo 重合** | 它已经把这件做完了，且更完整（独立聊天、通知、收件箱） |

---

## 五、结论与建议

**技术上：成立，且比当初评估的容易。** 核心假设已实测（客户端能脱离 DSH 跑），
通道已实测是普通 HTTP，适配层已存在。**我当初说「做不到」是错的。**

**但我的建议仍然是「先不做」——理由换了：**

1. **takboo 已经做完了，而且更完整**。它有独立聊天面板、通知收件箱、71 个测试文件。
   我再做一遍，最好的结果也只是「另一个 takboo」
2. **代价里有一条不可忽视**：引入 ~100–150MB 的 Electron 运行时（**未实测**）。
   对「一个桌宠插件」来说，这个量级不小
3. **两者定位不同，但重叠区很大**：takboo 更像「桌面伴侣 + 消息中心」，
   我的插件更像「DSH 界面里的陪伴 + 12 个工具」。**共存比取代更合理**

**如果你确实想要，三条路：**

| 路 | 说明 | 工作量 |
| --- | --- | --- |
| **A. 用 takboo** | 它就是你要的东西，AGPL-3.0 | 0 |
| **B. 给我的插件加独立壳** | 复用现有客户端（已实测可行），补 ~690 行 | 2–3 天 |
| **C. 只补「透明/穿透/置顶」的一部分** | 例如只做「开机自启 + 独立窗口显示她的本体」，不做聊天与通知 | 1 天 |

**我倾向 A 或 C。** A 是因为它已经做完了；C 是因为如果你只想要「她在 DSH 之外也在」，
那不需要重做界面——**而我实测过客户端能独立跑，C 是风险最低的那条**。

---

## 六、如果要做 C，第一步该验什么

1. **Electron 二进制的确切体积与下载耗时**（我没量到，这是最大的未知数）
2. **Electron 的 `spawn` 在 DSH 的插件沙箱里能否执行**——DSH 有工具审批与沙箱策略，
   插件 spawn 一个原生进程是否被允许，**我没验过**
3. **「两个她」的收敛**：DSH 页面连上后收起独立窗口，切换要无缝
4. **穿透的判定**：takboo 用 `setIgnoreMouseEvents(!active)`，`active` 由页面报的
   命中判定决定——我的 `hits` 圆已经有了，接缝是现成的

**第 2 条最关键**：如果 DSH 不允许插件 spawn 原生进程，那这条路对我就不成立
（takboo 能跑，说明大概率允许，但**它的运行环境与我的插件不一定相同**）。
