# 三个技术风险的验证结果（2026-10-18）

> 按你的要求，第 2/4 批动手前先把三个风险验清楚。**三个都实测了，结论有两个反转。**

---

## 风险 1｜55 语音填输入框 —— ✅ **可行，比预期更好**

### 我原来的判断（写进 pending-decisions.md 的）

> `inputActions` 由 `ctx.uiSession.provide({ props: ['inputActions'] })` 提供，
> **只注入给声明了该 props 的槽**；本插件占的是 `shell.overlay`（root 作用域，标准 props 是空接口），
> **因此拿不到**。要走通必须让桌宠也注册进 `conversation.input.activity` 槽。

### 实测结果

写了一个临时探针注册进 `conversation.input.activity`，在真实页面里 dump 拿到的 props：

```
propKeys: [usePanelInfo, useSessions, useSessionStatus, useWorkspaces, useResource,
           useSessionRetainInfo, sessionId, inputActions, useSession, useConversation,
           useInput, useTrajectory, useChat, useProjection, renderFactorySlot,
           locked, onActiveChange]
hasInputActions: true
inputActions: [captureInsertion, insertText, setDraft, addAttachments,
               removeAttachment, pruneAttachments, submit]
insertTextType: "function"
```

**结论：可行，而且拿到的不止 `insertText`**——

| 方法 | 用途 |
| --- | --- |
| `insertText(text, span)` | **把识别结果填进输入框**（55 要的就是这个） |
| `setDraft` | 直接设置草稿内容 |
| `submit` | **直接提交**（可以做成「说完就发」） |
| `captureInsertion` | 记录插入位置（配合 insertText 用） |
| `addAttachments` 等 | 附件相关，本项目用不到 |

另外还拿到了 `sessionId`、`useSession` 等**会话信息**——这意味着桌宠注册进这个槽之后，
**连「当前是哪个会话」都能读到**，将来做「她引用本会话内容」也有料了。

### 实施要点

- 注册进 `conversation.input.activity` 时 UI 要**极简**：那是输入框旁边的活动区，
  平时应当只占一个几乎不可见的小元素，只在识别中显示一个小指示。
- 探针已删除，未留在代码里。

### ⚠️ 实施时发现的第二个坑（比探针更重要）

**那个槽是 `single` 类型，官方语音输入插件也会注册它——两者只能有一个。**

实测报错：
```
Error: single slot "conversation.input.activity" already has a registration at priority 0
(registered by registerUi) — register at a different priority to shadow it (lowest renders)
```

- 用 `priority` shadow 它确实可行，但那会**顶掉官方语音输入插件的 UI**，不可接受。
- 退而试**直接改输入框 DOM**（它是 `contenteditable`）：
  `document.execCommand('insertText')` 与直改 `textContent` + 派发 `input` 事件
  **都不生效**——DSH 的输入框是 React 受控组件，DOM 改了会被状态覆盖。
- 因此最终走**降级路径**：识别文本作为**一条用户消息**送进会话（宿主侧 `agent.followup`）。
  语义等价于「用户说了这句话」，区别是**会直接触发一轮对话**，
  而不是填进输入框等用户自己按回车。

**结论修正**：55 的**理想形态**（填进输入框）只在「官方语音输入插件没装」时可用；
装了它就走会话降级。两条路都实现，运行时自动选（`inputBridge.mode` 报
`'input'` / `'session'` / `'none'`）。

---

## 风险 2｜54 假流式（分片识别）—— ❌ **收益为负，不建议做**

### 我原来的担心

> 分片送（如每 2 秒）意味着每片都被当**独立音频**识别。SenseVoice 对过短音频（<1 秒）
> 可能识别为空或乱码；拼接结果可能比整段识别差很多。

### 实测结果（同一段 8 秒中文语音，用 Windows SAPI 合成）

| 方式 | 识别结果 | 耗时 |
| --- | --- | --- |
| **整段 8 秒** | `你好，我是卓宠。现在测试分段识别的效果，请听我说完这几句话。` | **935ms** |
| 2 秒 × 4 片 | `你好，我是捉宠。现在测试分段时。别的效果请听我说。说完这几句话。` | 约 1.1s（198+173+408+312） |
| 1 秒 × 7 片 | `你好。我是捉宠。现在测试。只分段时。的效果。请听我说。说完这几句。` | 约 0.85s |

**三条实测结论**：

1. **「<1 秒会识别为空」的担心不成立**——1 秒片全部有输出，没有空/乱码。
2. **真正的损失是断句错位**：整段的「测试分段识别的效果」被 2 秒片切成
   「测试分段时」+「别的效果」——**切片边界会切断词**。字命中率 92%，但可读性明显下降。
3. **关键：假流式不但没更快，反而更慢。** DSH 的识别是**本地 SenseVoice，
   耗时与音频长度几乎无关**（8 秒只要 935ms）。分片反而多付了 3 次固定开销。

### 结论与建议

**不做 54。** 原本设想是「提前看到中间结果」，但在这套识别服务上收益为负：
更慢、更不准，而且要多写一套分片与拼接逻辑。

**替代建议**：把力气花在**录音交互的反馈**上——录的时候显示一个计时/波形指示，
录完一次性识别（935ms 的等待用户感觉不到）。这比假流式的体验更好，代码更少。

**顺带发现的一个真问题**：Windows SAPI 生成的 WAV 的 `fmt ` 块是 **18 字节**（非标准 16），
会让按标准 44 字节偏移解析的代码读错 `data` 块。DSH 的识别服务对**非标准头**报
`Invalid speech WAV`（502）。**这不影响本插件**——我们录的 WAV 用标准 44 字节头，
已验证正常。但记在这里，免得将来接第三方音频时踩。

---

## 风险 3｜41 形象包沙箱 —— ⚠️ **可行，但必须补一个 CORS 头**

### 我原来的判断

> 上游用 `web/figure-frame.html` 在 **opaque origin**（无网络访问）里跑形象包代码。
> 而插件资源路由是**同源**的，形象包要加载纹理就得能访问
> `/api/dsh-coopanion-pet/assets/`——opaque origin 拿不到同源资源。
> **这意味着 41 的沙箱形态需要重新设计。**

### 实测结果（在页面里造三种 iframe，逐一试加载同一张纹理）

| 沙箱形态 | `fetch` 资源 | `new Image()` 纹理 |
| --- | --- | --- |
| 无 sandbox（同源，对照） | ✅ 200 | ✅ |
| **`sandbox="allow-scripts"`（上游那种 opaque origin）** | ❌ **CORS 拦下** | ✅ **能加载** |
| `sandbox="allow-scripts allow-same-origin"` | ✅ 200 | ✅（但已不是真沙箱） |

错误原文：
```
Access to fetch at '.../assets/whale/tex/face.png' from origin 'null'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present.
```

### 结论：**上游的沙箱形态基本可行，我原来的判断过重了**

**关键发现**：渲染内核加载纹理用的是 `new Image()`，而**图片加载不受 CORS 限制**
（`<img>` 是 no-cors 请求）——**因此 opaque origin 沙箱里纹理本来就能加载**。
真正被拦的只有 `fetch`（读 `model.json`、`figure.json` 之类）。

**已做的改动**：给资源路由加了 `Access-Control-Allow-Origin: *`（`index.js` 一行）。
这个只读静态资源本来就是对浏览器公开的，放开 CORS 没有安全代价。

### 实施要点

- 沙箱 iframe 用 `sandbox="allow-scripts"`（**不给 `allow-same-origin`**，否则沙箱形同虚设——
  浏览器自己都警告「can escape its sandboxing」）。
- 形象包的**清单（figure.json）与纹理**都能在沙箱内读到（前者走 CORS 放开的 fetch，后者走 Image）。
- 与主页面通信只能靠 `postMessage`（opaque origin 下 `window.parent` 仍可用）。
- **注意**：形象包代码在沙箱里**拿不到主页面任何东西**（这是设计目标），因此
  「让形象包读 DSH 状态」这类需求做不到，也不该做。

---

## 汇总：对第 2/4 批的建议

| 批次 | 原计划项 | 验证后的建议 |
| --- | --- | --- |
| **第 2 批** | 48 切句器、49 幻觉过滤、50 繁简、52 按住热键、53 设备选择、~~54 假流式~~、55 填输入框 | ✅ **已完成**（v1.6）。54 去掉；55 实现成**双路径**（槽可用时填输入框，被占时送会话）；另加「录音计时+音量条」替代 54 |
| **第 3 批** | 43 Coo、46 预览页、44 模型状态 | 不受影响，照做 |
| **第 4 批** | 40 对话页、**41 形象包系统**、42 导入 | **41 沙箱形态已验证可行**（CORS 已放开），照原计划做；40 与 42 不受影响 |

**三个风险里，一个反转成「可行且更好」（55）、一个反转成「不做」（54）、一个从「需要重新设计」降级为「补一行 CORS 即可」（41）。**
