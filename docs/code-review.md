# 代码审查记录：上游 Coopanion vs dsh-coopanion-pet（审查 v1.8.0 → 发布 v1.8.1）

> 审查日期：2026-10-18
> 上游基准：**本机安装版** `cortico-world-desktop-pet@0.2.0`
>   （`D:\wangq\Documents\Coopanion\resources\app\node_modules\cortico-world-desktop-pet`，
>   `src/` 13,457 行 / 68 文件 + `web/` 466 文件）
> 本插件：**审查对象是 v1.8.0**（`client.js` 1,856 行 + `index.js` 1,009 行 + `lib/` 8 文件 + `assets/` 28 文件）；
> 修复后发布为 **v1.8.1**（npm 上旧的 1.8.0 是修复前的 `e87ec02`）。
>
> **为什么用本机安装版而不是 GitHub**：那是**你实际在运行的版本**，比仓库更贴近真实。
> 两份的 `src/` 行数与 `FEATURES.md` 记载的完全一致（`chat.ts` 207、`packs.ts` 329、
> `pack-import.ts` 213、`server.ts` 431、`segmenter.ts` 310、`result.ts` 47、
> `simplify.ts` 76、`system-recognizer.ts` 270），说明基准可信。

---

## 一、结论摘要

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| **逐字节相同**（实测核对） | **7 个文件** | `kit/rig.js`、`kit/body.js`、`whale/figure.js`、`whale/model.json`、`coo/coo.js`、`coo/figure.js`、`coo/figure.json` |
| **代码逐行相同**（仅注释本地化） | 1 个文件 | `mic-worklet.js` |
| **换实现**（等价或更优） | 11 项 | 见第三节 |
| **简化 / 缩水**（有代价） | 8 项 | 见第四节 |
| **合理省略**（DSH 架构下无意义） | 12 项 | 见第五节 |
| **本插件新增** | 13 项 | 见第六节 |
| **发现的代码缺陷** | **6 高 + 16 中 + 10 低** | 已修 6 高 + 11 中 + 3 低，见第七节 |
| **文档与代码不一致** | 5 处 | 已全部修正，见第八节 |

**一句话**：功能对照基本如实，但有**三处高危逻辑错误**（换形象失效、思考气泡永不显示、
形象包导入必崩）此前未被发现——那是**审查的主要收获**。

---

## 二、逐字节核对（验证「原样搬入」的声明）

用 `diff` 对上游源码逐个核对，**7 个文件完全相同**：

| 文件 | 上游位置 | 结果 |
| --- | --- | --- |
| `assets/kit/rig.js` | `web/kit/rig.js` | ✅ 逐字节相同（10,856 字节） |
| `assets/kit/body.js` | `web/kit/body.js` | ✅ 逐字节相同（54,240 字节） |
| `assets/whale/figure.js` | `web/whale/figure.js` | ✅ 逐字节相同（51,369 字节） |
| `assets/whale/model.json` | `web/whale/model.json` | ✅ 逐字节相同（16,563 字节） |
| `assets/coo/coo.js` | `web/coo/coo.js` | ✅ 逐字节相同（21,229 字节） |
| `assets/coo/figure.js` | `web/coo/figure.js` | ✅ 逐字节相同（821 字节） |
| `assets/coo/figure.json` | `web/coo/figure.json` | ✅ 逐字节相同（27,975 字节） |

**`mic-worklet.js`**：代码部分**逐行相同**（`diff` 只报文件头注释的 8 行差异）。
审查中发现该文件内注释写着「原样取自…（未修改）」，与实际不符——**已改正**（见第八节 F2）。

---

## 三、换实现（等价或更优，11 项）

| # | 功能 | 上游做法 | 本插件做法 | 评价 |
| --- | --- | --- | --- | --- |
| 5 | 界面穿透 | Electron `setIgnoreMouseEvents` + web 侧 `body.hit(p)` | window 捕获阶段 + 命中圆 + 补拦 `click` | **等价但有两处缺失**（见 D7） |
| 6 | 主题自适应 | `data-theme` 属性 | `prefers-color-scheme` + DSH 令牌 | 等价 |
| 11 | 悬停按钮条 | World 协议驱动 | `assets/ui.js` 自写 | 等价 |
| 12 | 右键菜单 | 同上 | 同上 | 等价 |
| 18 | 双向通道 | HTTP + WebSocket | SSE + POST | **各有取舍**：WS 双向实时，SSE 单向推 + POST 回；丢帧/重连行为不同 |
| 19 | 用户回答回会话 | World 事件 | `agent.followup` | 等价 |
| 28 | 语音识别 | 自己跑 sherpa 模型（`src/asr/sherpa.ts`） | 接 DSH `speechToText` | **更优**：不重复下载模型 |
| 29 | CUA 四级权限 | `src/cua/config.ts` + `cua.ts` 的 `permit()` | `lib/cua-policy.js` 同名同义 | 等价（且**修了一处竞态**，见 H5） |
| 73 | 全局热键 | koffi 轮询 `GetAsyncKeyState` | DSH `shortcuts` 服务 | **有意取舍**：页内有效，应用失焦不生效（文档已说明） |
| 75 | i18n | 上游是给整个 app 的 | 自写 11 门词表 | 等价（**审查中补齐了 9 门的 26 个新键**） |
| 15 | 状态气泡 | `StatusTracker` + **宿主注入的 describeTool** | 自写 `TOOL_WORDS` 映射表 | **换实现**（上游自己不写映射，见 D9） |

---

## 四、简化 / 缩水（8 项，有代价）

按影响排序。

### D1｜`pet_set` 能力大幅缩水
- **上游**（`src/tools.ts:56`）：支持 **11 个 SELF_KEYS** —— `figure`、`scheme`、`roam`、
  `snoreSeconds`、`sound`、`scale`、`bubbleSize`、`fontSize`、`theme`、`hoverButtons`、`user`
- **本插件**（`lib/tools.js:416`）：6 个 —— `size`、`roam`、`sound`、`statusBubble`、`trail`、`fps`
- **差异**：不只是少了 5 项，**语义也不同**——上游用真实值（`scale` 0.5–10），本插件用三档索引
- **为什么简化**：本插件的设置面板本身就是「档位」式 UI，工具跟着面板走可减少两处语义映射
- **代价**：模型无法做精细调整（例如「让她变成 3.2 倍大」做不到）
- **要补的话**：把 `pet_set` 的参数改成与 `prefs` 同名同范围（`scale`/`bubbleSize`/…），
  内部再映射到档位；约 60 行

### D14｜`selfAdjust` 两级权限未实现
- **上游**（`src/self.ts:1-18`）：每个设置项分两级 —— **`self`**（直接改）/
  **`ask`**（先在气泡里问人，同意才改）
- 上游默认划分（`src/config.ts:85` `SELF_DEFAULT`）：
  - **self**：`figure`、`scheme`、`roam`、`snoreSeconds`（她自己的外观与习惯）
  - **ask**：`sound`、`scale`、`bubbleSize`、`fontSize`、`theme`、`hoverButtons`、`user`
    （**碰到用户的屏幕、耳朵、称呼**）
- 上游还有四级模式（`src/config.ts:79`）：`off` / `default` / `any` / `custom`（逐项定）
- **本插件**：`pet_set` **一律直接改**，没有 ask 层
- **为什么没做**：上游的设计意图是「**碰到用户屏幕/耳朵/称呼的项要先问**」，
  这是个**有价值的边界**，本插件漏了——属于**该补的**
- **要补的话**：`pet_set` 收到 ask 类项时，复用已有的提问气泡问一次，同意再写；
  四级模式进设置面板；约 120 行

### D6｜帧率三档与上游不对应
- **上游**（`web/pet-app.js:1694`）：`RESTING_FPS = 30`（**静止时固定 30**）；
  活动时 `frameRate`（默认 **60**，0 = 跟随刷新率）；另有 `lockFrameRate` 布尔
- **本插件**（`client.js:104`）：三档 —— `{active:30, rest:12}` / `{active:0, rest:24}` / `{active:0, rest:0}`
- **差异**：
  - 上游静止**永远 30**，本插件「省电」档静止 **12**（更省）
  - 上游活动默认 **60**，本插件「省电」档活动 **30**（比上游卡）
  - 上游的 `lockFrameRate` 本插件**没有**
- **为什么这样做**：三档比「数字 + 布尔」直观，且省电档确实更省（静止 12 vs 30）
- **代价**：**没有一档等价于上游默认值**。想要「与上游一致」需要活动 60 / 静止 30
- **要补的话**：加一档 `{active:60, rest:30}`（或把「流畅」档的 rest 从 0 改成 30），约 5 行

### D3｜`pet_act` 能力缩水
- **上游**：`actions` —— **数组，1–6 个，按序播放**
- **本插件**：`word` —— **单个**
- **代价**：模型无法一次让她「先挥手再跳」
- **要补的话**：参数改成数组，循环 `body.do()`；约 15 行

### D2｜`pet_walk_to` 语义不同
- **上游**：`to` —— **0–1 比例** 或 `left`/`center`/`right`/`cursor`（鼠标位置）
- **本插件**：`x` —— **像素**
- **代价**：上游比例可跨屏移植；本插件绑死当前视口宽度。且**没有 `cursor` 关键字**
- **要补的话**：接受 0–1 与关键字，内部乘视口宽；约 25 行

### D4｜`pet_quiet` 少两个参数
- **上游**：`minutes` + `sound` + `roam`（可指定安静期间是否发声/走动）
- **本插件**：只有 `minutes`（固定「关音效 + 不走动」）
- **要补的话**：加两个参数；约 20 行

### D7｜界面穿透少两个细节
- **上游**（`web/pet-app.js:1228,1293`）：
  1. `TOOLS_LINGER = 0.8` —— 鼠标离开按钮条后**仍保持可交互 0.8 秒**
  2. `overTools` 有 **6px 边距容差**（按钮之间与边缘外扩）
- **本插件**：`assets/ui.js:188` 只用 `getBoundingClientRect()` **精确判定**，无容差、无停留期
- **代价**：从按钮边缘滑过、或在按钮之间移动时，指针事件可能穿到界面下方
- **要补的话**：加 6px 容差 + 0.8s 停留；约 15 行

### D9｜状态映射是自设计的
- **上游**（`src/status.ts:14`）：14 种 kind —— `think`/`read`/`browse`/`search`/`write`/
  `delete`/`save`/`look`/`click`/`scroll`/`type`/`wait`/`alarm`/`work`
- **上游的映射表由嵌入应用注入**（`src/definition.ts:20` 的 `assembly.describeTool`）——**它自己不写**
- **本插件**（`index.js:117`）：自写 `TOOL_WORDS`（12 条正则 → 10 种 kind），
  **针对 DSH 工具集适配**（`ops_*`、`mcp__wincu__*`）
- **评价**：**合理**——映射本该由嵌入方定，且 DSH 的工具集与 Cortico 不同
- **差异**：缺 `browse`/`delete`/`save`/`look`/`click`/`scroll`/`type`/`alarm` 8 种；
  多 `listen`/`speak`/`screen`/`control` 4 种（新增）
- **要补的话**：把 CUA 的细动作从 `control` 拆成 `click`/`type`/`scroll`；约 20 行

### D10｜上游有 6 类事件，本插件只有 SSE 状态推送
- **上游**（`src/definition.ts:40`）：`desktop-pet.message`、`.speech`、`.answer`、`.touch`、
  `.figure`、`.self`
- **本插件**：`status` 帧 + `lines` 帧
- **对照**：`touch` 有（走 `onEvent`）、`answer` 有（走 `agent.followup`）、
  `message` 走 DSH 自己的会话、**`figure` 与 `self` 没有**
- **代价**：模型不知道「用户换了她的形象」；她自己的言行不进任何记录
- **要补的话**：`figure` 事件较易（换形象时推一条）；`self` 需要会话记录位，约 40 行

---

## 五、合理省略（12 项，DSH 架构下无意义）

| # | 上游功能 | 为什么省略 |
| --- | --- | --- |
| 31 | 透明置顶窗口 | Web 页面没有窗口概念（上游是 Electron `host/electron-main.cjs` 511 行） |
| 32 | 鼠标穿透租约 | 同上（`host/mouse-lease.cjs`） |
| 33 | 托盘、跨屏跟随 | 同上 |
| 34 | OBS 叠加导出 | 需要窗口进程送帧（`web/overlay.js` + `host/overlay.cjs`） |
| 36 | 全屏时自动隐藏 | 需要窗口枚举（上游仅 Windows 注册此项） |
| 38 | CUA 让位空闲检测 | 依赖原生 `GetLastInputInfo`（`userIdleMs`/`maxYieldWaitMs`） |
| 39 | 真正的全局热键 | 上游 koffi 轮询；本插件走 DSH `shortcuts`，**页内有效**（有意取舍） |
| 45 | 本地 HTTP + WebSocket 服务器 | 用 DSH 的 `webServer`（`src/server.ts` 431 行不必重造） |
| 51 | Windows SAPI 识别 | 用 DSH 的语音插件更准（`src/asr/system-recognizer.ts` 270 行 + `.ps1` 173 行） |
| 40 | 对话页 | DSH 已有完整会话 UI（`src/chat.ts` 207 行 + `pet-app.js` 的行栈/分页/附件） |
| 47 | 装扮页编辑器外观绑定 | 本插件的装扮是浮层，不需要独立页（`web/appearance.js` 36 行） |
| 44 | 模型下载管理 | 模型由 DSH 语音插件管，本插件只显示状态（`src/runtime/store.ts` 292 + `download.ts` 29） |

---

## 六、本插件新增（13 项）

| # | 功能 | 上游有没有 | 为什么加 |
| --- | --- | --- | --- |
| 68 | `pet_status` | 无 | 模型要先知道「她在不在」再决定调不调别的工具 |
| 69 | `pet_listen` / `pet_speak` | 上游只有识别，**无合成** | 让她能「说给用户听」 |
| 70 | **TTS 整条链路** | **确认没有**（`grep -rniE 'tts\|synthes\|speechSynthesis'` 在 `src/`+`web/` **零命中**） | 上游只有 ASR；TTS 是本插件补的 |
| 71 | `pet_cua` | 上游的 CUA 是内置的 | 让模型能读/改审批档位 |
| 72 | CUA 审批挂 `tools/pre-execute` | 上游挂它自己 `call()` | 本插件的 CUA 是**别的插件**实现的（dsh-computer-use-win） |
| 73 | 热键走 DSH `shortcuts` | 上游 koffi 轮询 | DSH 已有窗口级快捷键仲裁（含 IME、弹窗、输入框焦点判定） |
| 74 | 状态气泡认 `mcp__wincu__*` | 上游认自己的 `pet_cua_*` | 本插件要认第三方 CUA |
| 75 | 自写 11 门 i18n 词表 | 上游 i18n 是给整个 app 的 | 本插件只要自己那点文案 |
| 76 | 走路足迹 | **上游的 trail 不是这个**（它是连接对话气泡与头顶的三个点） | 本插件把它改造成走路足迹 |
| 77 | 帧率三档 | 上游是「数字 + 布尔」 | 三档更直观（代价见 D6） |
| 78 | 设置面板嵌 DSH `settings.section` | 上游是 console 配置页 | 本插件嵌进 DSH 设置 |
| 79 | 音效零素材（全合成） | 上游会加载形象包自带音频（`PACK_SOUND_KINDS`） | 免去素材依赖 |
| 80 | 可选接缝「未装即安全跳过」 | 上游 CUA/ASR 内置，没有「插件没装」这种情况 | DSH 的插件生态需要这个语义 |
| — | `pet_dress` | 上游换装扮走 `pet_set` 的 `figure`/`scheme` | 单独拆出来更明确 |
| — | `pet_voice` | 上游是 `asr.mic.deviceId` 配置项 | 让模型能列出/切换麦克风 |

---

## 七、修复的代码缺陷

### 高危（6 条，全部已修）

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| **H1** | `client.js:248` | **设置面板换形象 100% 失效**：先 `prefs[key] = stored[key]`，再 `switchFigure(prefs.figure)`；而 `switchFigure` 首行比较的也是 `prefs.figure` → 恒等返回 `false` | 循环里先存 `prevValue`，figure 分支用它作起点 |
| **H2** | `assets/status.js:109` | **「正在思考」永不显示**：`t - (next.since ?? 0)/1000 < 0`，`t` 是页面加载起的秒数，`since` 是宿主 `Date.now()` 毫秒纪元 → 恒为约 −1.7e9 | 改成本地记「首次见到该 think 时的 t」 |
| **H3** | `assets/settings.js:95` | **形象包导入必崩**：`btoa(String.fromCharCode(...new Uint8Array(buf)))`，一张 270KB 的 PNG 就抛 `RangeError`（参数上限约 6.5 万） | 改用分块 `base64Chunked`（每块 0x8000） |
| **H4** | `client.js:1189` | **stale confirm 吞掉后续回答**：`pendingConfirm` 无超时且单槽，工具侧 120s 超时后它仍挂着，用户回答**别的提问**会被送进这个没人等的 resolver | 加**代次** + 本地 120s 超时清理；`onAnswer` 答完即清 |
| **H5** | `lib/cua-policy.js:128` | **CUA 授权跨轮残留**：`await ask()` 期间 `endTurn()` 清了 `turnAnswer`，await 回来后**无条件写回 `'yes'`** | 进入时记 `turnEpoch`，回来比对，变了就不写回 |
| **H6** | `assets/settings.js:303` | **CUA 档位两份状态**：面板写 localStorage + 只 POST 一次（失败静默），`client.js` 从不读它；宿主默认 `ask-once`，比面板显示的 `ask-each-turn` **更松** | 宿主 `REPORT` 端点加 **GET** 返回真实档位；面板挂载时读真值，POST 失败**回滚并提示** |

**H1 的实测证据**（修复后验证）：
```
当前形象: whale
写入 coo 后 → {"hasCanvas":false,"svgPaths":6,"figure":"coo"}   ← 真的切过去了
切回 whale → {"hasCanvas":true,"hasSvg":true}
```
**H2 的单元验证**：`think` 在 **0.52 秒**显示（修前恒不显示）。

### 中危（16 条，已修 11 条）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| M1 | `client.js:1713` | `dispose()` 漏 `voiceUi.dispose()` → 每次重挂泄漏 3 个 window 监听器 | ✅ 已修 |
| M2 | `client.js:1501` | SSE `onmessage` 是 async，命令帧并发交错，单值提问槽互相顶掉 | ✅ 已修（串行队列） |
| M3 | `assets/dress.js:112` | 换装失败仍把 `scheme` 落盘 → 下次继续恢复坏值 | ✅ 已修（失败回滚） |
| M4 | `client.js:1178` | `runCommand('dress')` 同样失败即写盘，且吞错误回 `{ok:true}` | ✅ 已修 |
| M5 | `client.js:310` | style 早期 append，后续抛错时无清理 → 永久留在 head | ✅ 已修（移到风险操作之后） |
| M6 | `index.js` 6 处 | `createReadStream(file).pipe(res)` 无 `error` 监听 → 可致 uncaughtException 带崩宿主 | ✅ 已修（统一 `sendFile`） |
| M7 | `lib/channel.js:91` | 写失败只删连接不 resolve → 命令挂到超时（speak 30s、confirm 120s） | ✅ 已修（一条没发出去即回 `offline`） |
| M8 | `index.js:899` | `lines` 只推给在线页面，重连不补发 → 刷新后对话栈空白 | ✅ 已修（attach 时补发） |
| M9 | `settings.js:296` | 设置同步靠 `tick & 31`，静止档 12fps 下最长 ≈2.7s | ✅ 已修（暴露 `syncPrefs()` 立即同步） |
| M10 | `assets/voice.js:289` | 每次录音新建 AudioContext，close 异常吞掉 | ⚠️ **未修**（见下） |
| M11 | `assets/voice.js:324` | `stop()` 在 worklet 加载完成前是空操作 → 按住即松开仍录满 15s | ✅ 已修（`stopRequested` 标志） |
| M12 | `lib/tools.js:573` | `pet_cua` 先 `setLevel` 再校验 `grantMinutes`，后者失败不回滚 | ✅ 已修（先全校验再应用） |
| M13 | `client.js:1564` | `report` 在途去重 + `lastReport` 已推进 → 失败时该状态永久丢失 | ✅ 已修（失败回滚记账） |
| M14 | `client.js:1356` | `patch.sizeIndex` 无范围校验（传 7 → scale=1、档位显示未知） | ✅ 已修（夹到合法档位） |
| M15 | `client.js:1517` | `events.onerror = () => {}` 把鉴权失败等完全静默 | ✅ 已修（首次失败打警告） |
| M16 | `index.js:548` | `readJson` 全部错误按 413 回（坏 JSON 也报 too-large） | ✅ 已修（按类型分 400/413） |

**M10 为什么没修**：`AudioContext` 复用需要引入一个长期存活的上下文并管理它的生命周期
（还有「被浏览器自动挂起」的处理）。收益（避免短时间连开多个上下文）与引入的复杂度相比，
**暂时不值得**。触发条件是「短时间内连续录音 + 切设备」，日常使用极少遇到。
**要补的话**：模块级单例 context + `resume()` 处理；约 30 行。

### 低危（10 条，已修 3 条）

| # | 位置 | 问题 | 状态 |
| --- | --- | --- | --- |
| L1 | `assets/bubble.js:270` | `Number(e.key)` 会把 `' 1 '`、`'0x1'`、`'1e0'` 当合法选项号 | ✅ 已修（`/^[1-9]$/`） |
| L2 | `assets/lines.js:37` | `aria-label` 硬编码中文，未走 i18n | ✅ 已修（经 `deps` 传 `t`） |
| L3 | `assets/settings.js:495` | 取消最后一个悬停按钮时静默不写，面板重渲染回旧值 | ✅ 已修（见下注） |
| L4 | `assets/sfx.js:25` | `dsh-coopanion-pet:sound` 与 `prefs.sound` 是两份状态 | ⚠️ 未修（无实际影响，靠覆盖一致） |
| L5 | `index.js:342` | `existsSync` → `createReadStream` 之间 TOCTOU | ✅ 已随 M6 一并处理（`sendFile` 兜住） |
| L6 | `lib/optional.js:128` | 失败缓存 60s、成功不缓存（不对称） | ⚠️ 未修（有意为之：失败多是瞬时的） |
| L7 | `assets/pack-body.js:44` | 每帧新建布局对象 | ⚠️ 未修（每帧只调一次，可忽略） |
| L8 | `client.js:964` | hide 的 setTimeout 无 clearTimeout | ⚠️ 未修（有 `stopped` 守卫兜底） |
| L9 | `index.js:841` | `payload.agent` 缺失时用 `'undefined'` 作 tracker key | ⚠️ 未修（DSH 总会给 agent） |
| L10 | `assets/voice.js:333` | `record` 的 `opts.signal` 未传，取消通道形同虚设 | ✅ 已随 M11 一并处理 |

**L3 的说明**：审查建议「取消最后一个悬停按钮时要给出反馈」。实测后**改为更直接的做法**：
不再静默忽略，而是**允许清空**（`hoverButtons` 为空数组 = 不显示按钮条），
与上游的「`MAX_HOVER_BUTTONS` 上限、但可少」语义一致。

---

## 七之二、安全审查（沙箱与边界）`[已验证]`

**结论：沙箱与路径防护都是正确的。** 以下是实测证据。

### 沙箱两道防线

| 防线 | 实现 | 位置 |
| --- | --- | --- |
| 1. `sandbox` 属性 | `sandbox="allow-scripts"` —— **刻意不给 `allow-same-origin`**（给了它就能摸主页面 DOM，沙箱形同虚设） | `assets/pack-host.js:85` |
| 2. CSP | `default-src 'none'; script-src 'self'; img-src 'self'; style-src 'unsafe-inline'; connect-src 'none'` | `index.js:550` |

**实测**：主页面访问沙箱 frame 内的 `document` 被拒（跨源），说明隔离真的生效。
**注**：`connect-src 'none'` 意味着**包代码连 `fetch` 都发不出去**——它只能画图。

### 路径穿越防护（14 个攻击用例全部拦下）

`lib/packs.js:133` 的 `resolvePackFile`：
```js
const target = path.normalize(path.join(packDir, rel));
if (target !== packDir && !target.startsWith(packDir + path.sep)) return null;
const ext = path.extname(target).toLowerCase();
if (!IMAGE_EXT.has(ext) && !AUDIO_EXT.has(ext)) return null;   // 只放图片/音频
```

实测结果（`packDir` 外放了 `secret.png` 作为靶子）：

| 攻击用例 | 结果 |
| --- | --- |
| 正常素材 `ok.png` | ✅ 返回正确路径 |
| 父目录穿越 `../secret.png` | ✅ null |
| 多级穿越 `..\\..\\secret.png` | ✅ null |
| 正斜杠穿越 `../../secret.png` | ✅ null |
| URL 编码 `%2e%2e%2fsecret.png` | ✅ null |
| 绝对路径（完整 `C:\...\secret.png`） | ✅ null |
| Windows 盘符 `C:\Windows\win.ini` | ✅ null |
| UNC `\\\\localhost\\c$\\windows\\win.ini` | ✅ null |
| 非图片扩展名（脚本 `evil.js`） | ✅ null |
| NTFS 交替数据流 `ok.png:evil` | ✅ null |
| 空字节 `ok.png\u0000.txt` | ✅ null |
| 8.3 短名 `SECRET~1.PNG` | ✅ null |
| 目录本身 `.` | ✅ null |
| 不存在的文件 | ✅ null |

**唯一返回路径的是「正常素材」**——其余 13 个用例全是 `null`。

### 导入的信任边界

- **`id` 有严格校验**（`lib/pack-import.js:31`）：`/^[a-z0-9][a-z0-9-]{0,31}$/`
  实测拦下 `../evil`、`C:evil`、`a/b`、`A-B`、`evil.png`、空串、超长串
- **内置 id 不许覆盖**（`:167`）：`whale`/`coo` 会被 `refused`
- **层数限制** `PACK_DEPTH = 3`：超过的包被报为 problem 而不是安装
- **大小限制**：`IMPORT_MAX = 128MB`（整批）、`MAX_PACK_BYTES = 64MB`（单个包）
- **只支持文件夹导入**：不引第三方 zip 库，因此**没有 zip 解压类漏洞**（zip slip 之类）

### 路由的鉴权边界（审查中发现的重要事实）

**本插件的部分路由刻意不在 `/api` 下**（`/dsh-coopanion-pet/packs`、`/dsh-coopanion-pet/frame`），
因此**不走 DSH 的鉴权**。这是**必要的**：沙箱 iframe 是 opaque origin、**不带 cookie**，
走 `/api` 会被 401 拦下（这是实现 v1.8 时实测到的根因）。

**风险评估**：这些路由只暴露
1. 插件自己的静态资源（`frame.html` / `frame.js`）
2. **已安装形象包的素材**（且只限图片/音频，路径穿越已验防护）

**不暴露**：任意文件、用户数据、会话内容、包内脚本以外的任何东西。
包内脚本（`__entry.js`）会被沙箱加载，但**宿主不执行它**，且沙箱里 `connect-src 'none'`。

**结论**：边界是合理的——暴露面限于「插件自己的静态资源 + 用户自己导入的包素材」。

---

## 八、文档与代码不一致（5 处，全部已修正）

| # | 位置 | 文档说 | 实际 | 修法 |
| --- | --- | --- | --- | --- |
| **F1** | `assets/i18n.js` | `FEATURES.md`：「每门 128 键完整」 | v1.6–v1.8 新增的 **26 键只加进 `zh`/`en`**，其余 9 门缺 → **日语等用户看新功能显示英文** | ✅ **已补齐 9 门 × 26 键**（+234 行），实测 11 门全 154 键 |
| **F2** | `assets/mic-worklet.js` | 文件内注释：「原样取自…（未修改）」 | 实际把英文注释换成了中文 | ✅ 改成「代码逐行相同，只把注释换成中文」 |
| **F3** | `package.json` | 「11 个 `pet_*` 工具」「中英双语」 | 实际 **12 个**工具、**11 门**语言 | ✅ 已更新 |
| **F4** | `FEATURES.md` | 基准是 **v1.4.0**，把 v1.5–v1.8 已做的项列为「未做」 | 实际已做完 | ✅ **已重写**（见同目录 `FEATURES.md`，基准改为 v1.8.1） |
| **F5** | `ROADMAP.md` | 只提到 v1.5 | 缺 v1.6–v1.8 | ✅ 已补 |

**F1 的独立核实**（不采信子代理自述，我自己跑运行时求值）：
```
LANGS 声明: 11 | DICT 实际: 11
✓ zh 154   ✓ en 154   ✓ zh-Hant 154   ✓ ja 154   ✓ ko 154
✓ de 154   ✓ fr 154   ✓ it 154   ✓ es-419 154   ✓ pt-BR 154   ✓ ru 154
不合格语言数: 0
voice.listening 出现 11 次，含 {s} 的 11 次
```

---

## 九、还有哪些没做（如实列出）

**审查中确认「该补但没补」的**（按价值排序）：

| 项 | 内容 | 工作量 | 价值 |
| --- | --- | --- | --- |
| D14 | `selfAdjust` 两级权限（ask 层） | ~120 行 | **高**——「碰到用户屏幕/耳朵/称呼要先问」是有意义的边界 |
| D1 | `pet_set` 补齐 11 项 + 改用真实值 | ~60 行 | 中——模型能做精细调整 |
| D6 | 帧率加一档等价于上游（活动 60 / 静止 30） | ~5 行 | 中——想要「与上游一致」的人 |
| D7 | 界面穿透加 6px 容差 + 0.8s 停留 | ~15 行 | 中——减少误穿透 |
| D3 | `pet_act` 支持动作数组 | ~15 行 | 中——连播动作 |
| D2 | `pet_walk_to` 支持比例与 `cursor` | ~25 行 | 低——像素也能用 |
| D4 | `pet_quiet` 加 `sound`/`roam` | ~20 行 | 低 |
| D9 | 状态映射拆出 CUA 细动作 | ~20 行 | 低 |
| D10 | 补 `figure` 事件 | ~40 行 | 低 |
| M10 | AudioContext 复用 | ~30 行 | 低 |

**审查中确认「不做是对的」**：第五节那 12 项（DSH 架构下无意义）。

---

## 十、审查方法（可复现）

1. **基准**：用本机安装版源码（`resources/app/node_modules/cortico-world-desktop-pet`），
   而非 GitHub 克隆——前者是你实际运行的版本
2. **逐字节核对**：`diff` 逐个比对声称「原样搬入」的文件
3. **工具签名对照**：从上游 `src/tools.ts` 提取参数表，与 `lib/tools.js` 逐项比对
4. **配置对照**：上游 `src/config.ts`（323 行）是配置真源，逐项核对本插件是否覆盖
5. **静态审查**：三个子代理分别审「逻辑问题」「沙箱与安全」「已移植 30 项」，
   报告**逐条人工复核**（不采信自述）
6. **修复后验证**：
   - 语法：全量 `node --check`
   - 端到端：真实浏览器（Edge headless + SwiftShader）跑回归
   - 单元：`status.js` 这类纯逻辑模块脱离浏览器直接测
   - i18n：运行时求值统计键数（不靠源码解析）
