# 调研：桌宠能否在 dsh-tui（终端）里落脚

> 你的问题：**dsh-tui 是怎么启动的，桌宠能否像它一样不依赖桌面或网页客户端？**
>
> 结论先行：**能。** 我实测跑通了一个最小探针——插件在 dsh-tui 里注册了一个全屏场景，
> 终端里真的渲染出了内容。但**渲染形态受限**（终端 vs 浏览器），下面说清代价。

---

## 一、dsh-tui 是怎么启动的

它不是 DSH 内置的，而是一个**第三方独立 npm 包**：

| 项 | 值 |
| --- | --- |
| 包名 | `@deepseek-harness-tui/dsh-tui` |
| 版本 | 0.15.0（本机） |
| 作者 / 仓库 | chimney / `github.com/ccch1mneyyy/dsh-TUI` |
| 界面技术 | **Ink**（React for CLI）+ 自己的 React 19 渲染器 |
| 入口 | `bin/dsh-tui.js`（也提供 `dst` 别名） |

**它怎么被启动**：它作为一个 **bundle** 挂在 profile 里，和 DSH 的其他 bundle 一样：

```yaml
# ~/.dsh/profiles/dsh-tui/package.json 的 dsh.profile.bundles
- "@deepseek-ai/dsh-base"          # 底座（工具、沙箱、审批、技能…）
- "@deepseek-harness-tui/dsh-tui"  # 终端前门（这个包）
```

启动就是 `dsh --profile dsh-tui`（或它自带的 `dsh-tui` / `dst` 命令）。
**它自带一个 `cordis.patch.yml`**，在 dsh-base 之上覆写若干 row（persona、系统提示词等）。

**关键点：dsh-tui 与 DSH web 是并列的两种「前门」**——同一个 dsh-base，两个不同的界面层。
所以「不依赖桌面或网页客户端」这件事，dsh-tui 已经证明了：**只要有一个 bundle 提供界面层，
DSH 就能在没有浏览器的情况下跑起来。**

---

## 二、桌宠能不能照做：**能，实测通过**

### 我实测的结论

写了个最小探针插件（`ctx.tuiScenes.register(...)` + `open()`），用 `node-pty` 跑真实的
dsh-tui，抓终端输出——**场景真的渲染出来了**：

```
桌宠探针：这个场景渲染成功了
如果能看见这行字，说明插件能在终端里画东西
```

### 扩展点是什么

dsh-tui 提供了 **contribution 协议**（`tui.dsh/v1alpha1`），其中有一个 **Scene（全屏场景）**：

| 项 | 值 |
| --- | --- |
| 服务 | `ctx.tuiScenes`（cordis 服务，来自 `dsh-tui-scenes` row） |
| 注册 | `ctx.tuiScenes.register({ id, title?, component })`，返回 disposer |
| 打开 | `ctx.tuiScenes.open(id)` → boolean；`close()` 退出 |
| 组件契约 | `component(props)`，props 里有 `React`、`ui`、`channel`、`close()` |
| 渲染 | 返回 **React.ReactNode**，由 dsh-tui 自己的 React 19 reconciler 渲染 |

**宿主给的 `ui` kit 里有**：`Box`、`Text`、`Image`、`Ansi`、`ScrollBox`、`AlternateScreen`、
`useInput`、`useAnimationFrame`、`useBlink`、`useTerminalSize`、`ThemeProvider`…

**这足够画一个终端桌宠**：`useAnimationFrame` 做帧循环、`Box`/`Text` 画 ASCII 形象、
`useInput` 收键盘、`Image` 甚至能在支持的终端里显示**真实图片**（Sixel / kitty 协议）。

### 三条硬约束（官方注释里写明的）

1. **必须用宿主注入的 `React`**，不能用插件自己那份
   —— 用插件的 React 会因 hook 调用失效而在首帧就崩；JSX 必须编译到
   `@deepseek-harness-tui/dsh-tui/jsx-runtime`
2. **场景是「全屏」的**：打开后接管整个终端（像 trajectory 场景那样），
   `close()` 才回到之前的界面。因此她**不能像在浏览器里那样「站在界面下沿」**
3. **组件身份由宿主登记**：同一个场景 id 不能重复注册

---

## 三、代价：终端形态与浏览器形态差得很远

这是**必须如实说清**的部分。桌宠在浏览器里有的东西，在终端里大多**拿不到**：

| 能力 | 浏览器（现状） | 终端（可行吗） |
| --- | --- | --- |
| WebGL 形象渲染 | ✅ 25 张纹理 + rig | ❌ 终端没有 WebGL；只能 ASCII/ANSI，或在支持 Sixel/kitty 的终端里用 `Image` |
| 站在界面下沿、自由走动 | ✅ 覆盖层 + 坐标命中 | ❌ 场景是全屏接管，没有「覆盖层」概念 |
| 鼠标拖拽 | ✅ | ⚠️ 终端鼠标支持因终端而异（`useInput` 能收，但多数终端体验差） |
| 气泡说话 | ✅ 气泡 + 打字机 | ✅ 可用 `Box`/`Text` 画对话框 |
| 表情与动作 | ✅ 19 表情 + 14 动作 | ⚠️ 只能靠 ANSI 图形或 ASCII 帧 |
| 音效 | ✅ WebAudio 合成 | ⚠️ 终端可以写 `\x07` 响铃，或调外部命令播放；合成音做不到 |
| 装扮（8 配色 2 服装） | ✅ 纹理切换 | ⚠️ 只能用颜色码近似 |
| 界面穿透 | ✅ | ❌ 终端里没有「穿透」概念 |
| 语音识别 / 合成 | ✅ 已接 | ⚠️ 依赖宿主能力，理论上可接（见下） |
| 状态气泡 | ✅ | ✅ 可用 `Text` 画 |
| `pet_*` 工具 | ✅ 12 个 | ✅ 工具是宿主侧的，**原样可用** |

**一句话**：终端里能做的是**「一个用 ASCII/ANSI 画的她」**，不是浏览器里那个 WebGL 形象。

---

## 四、还有一条更省事的路：什么都不改

**桌宠的 12 个 `pet_*` 工具是宿主侧注册的，与界面无关。**
因此如果你在 dsh-tui profile 里装本插件：

- **工具会全部可用**（`pet_say` 会回 `offline`，因为「页面」不存在——但这是如实回报，不是故障）
- **状态采集也会跑**（`agent/status` 与 `tools/execute` 钩子在宿主侧）
- 只是**没有界面**：她「不在屏幕上」，工具如实说 offline

这已经是一个可用的形态：**Agent 知道她的存在、能调她的工具，只是看不见她。**

---

## 五、我的建议

| 方案 | 工作量 | 说明 |
| --- | --- | --- |
| **A. 不做**（推荐先考虑） | 0 | 现状：装在 web profile 里她在界面上；装在 tui profile 里工具可用、她不在屏幕上。**如实回报 offline，不假装成功**——这已经是正确行为 |
| **B. 做一个终端场景**（`dsh-tui-scenes` 那条路） | 中（约 300–500 行） | 用 ASCII/ANSI 画她 + `useAnimationFrame` 帧循环 + `useInput` 收键盘。**要接受：不能站在界面下沿、没有鼠标拖拽、形象是字符画** |
| **C. 独立进程**（脱离 DSH 跑） | 大（300–500 行 + 打包/自启） | 见 `docs/standalone-research.md`：能让她在 DSH 之外存在，但**做不到透明/穿透/置顶** |

**我不建议现在做 B**，理由：终端里那个「她」与浏览器里的她**几乎是两个不同的产品**，
共用的只有工具与提示词（那部分本来就已经可用）。除非你确实想要一个终端里的字符画桌宠。

---

## 六、如果你要做 B，第一步该验什么

1. **目标终端**：Windows Terminal / cmd / VS Code 终端对 ANSI 图形的支持差别很大；
   要确认你日常用哪个，以及它是否支持 `Image`（Sixel/kitty）——这决定她能否是真图片
2. **场景的交互模型**：全屏接管意味着她**独占终端**，用户看完得按 `close` 回到对话。
   这与「她一直在旁边」的体验完全不同——可能需要一个「侧栏面板」而不是场景
   （dsh-tui 还有 `dsh-tui-panels` row，提供 sidebar Panel + compact row，可能更适合）
3. **帧率与终端重绘**：终端每帧重绘整屏，`useAnimationFrame` 跑 30fps 会刷屏很厉害；
   上游的 `useBlink` 之类是按秒级节奏的

**其中第 2 条最关键**：场景是全屏的，而桌宠的本意是「陪伴」——两者气质不合。
`panels`（侧栏）可能是更合适的落点，值得先探一下。
