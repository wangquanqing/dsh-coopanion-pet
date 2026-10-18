# 移植路线图

Coopanion 全部功能按「移植到 DSH Web UI 插件」的难度分级。每项都注明依赖什么、
对应 Coopanion 的哪个源文件、以及在本插件里怎么落地。

**图例**：✅ 已完成 ｜ 🟢 简单（纯前端，可直接搬）｜ 🟡 中等（要接 DSH 服务或改接缝）｜ 🔴 困难（要宿主能力）｜ ⛔ 不可行（DSH 插件拿不到）

难度判定的前提：DSH 插件能拿到的是——一个只读静态资源路由（宿主侧）+
`window.__ModuleLoader__.load()` 注入的浏览器端 cordis 插件（`slots` 等服务、React）。

---

## P0 ✅ 桌宠本体

| 功能 | 来源 | 状态 |
| --- | --- | --- |
| 鲸鱼娘形象渲染（WebGL sprite rig） | `web/kit/rig.js`、`web/whale/figure.js` | ✅ |
| 身体仿真：走路、跳跃、拖拽、摔晕 | `web/kit/body.js`（960 行） | ✅ |
| 待机动画：呼吸、眨眼、视线跟随、头发/裙摆/尾巴弹簧 | `web/whale/figure.js` | ✅ |
| 站立与漫游 | `web/kit/body.js` 的 `roam` | ✅ |
| 界面穿透（坐标命中判定） | 新增（替换 Electron 窗口穿透） | ✅ |
| 主题自适应 | 内核 CSS 的 `prefers-color-scheme` | ✅ |

---

## P1 ✅ 表现层（已完成）

| 功能 | 来源 | 状态 |
| --- | --- | --- |
| **气泡说话 + 打字机效果** | `web/pet-app.js` 的 say 分支 | ✅ `assets/bubble.js` |
| **表情与动作标记** | `web/kit/body.js` 词表 + `pet-app.js` 的 anchors | ✅ `【…】` 与 `<…>` |
| **提问气泡（带选项）** | `web/pet-app.js` 的 ask 分支 | ✅ 3 选项 + 自填框 + `1`–`3` 键 |
| **声音** | `web/sound.js` | ✅ `assets/sfx.js`，全部 WebAudio 合成，零素材 |
| **悬停按钮与右键菜单** | 上游由 World 协议驱动 | ✅ `assets/ui.js`，本插件新写 |
| **气泡样式与主题对接** | `web/pet.css` 气泡段落 | ✅ `assets/bubble.css.js`，接 DSH 主题令牌 |
| **状态气泡** | `web/pet-app.js` 的 stepStatus | ✅ `assets/status.js`；状态由宿主采集、经 SSE 下发（见下） |
| **装扮面板** | `web/dress.js`、`dress.css` | ✅ `assets/dress.js`，做成跟随桌宠的浮层 |
| **其余 7 套配色** | `web/whale/schemes/*` | ✅ 已全部带上，共 8 套 |
| **冬装（cape）** | `web/whale/outfits/cape/` | ✅ 面板内可切换 |

**状态气泡为什么要绕宿主一圈**：探针实测（dsh 0.2.0-rc.2）显示浏览器端插件 `apply` 运行时
只有 `slots`/`connection`/`loader`/`modules` 可用，`sessions`/`conversation`/`theme` 都取不到；
`shell.overlay` 是 root 作用域插槽，框架注入的标准 props 是空接口。而宿主侧有 `agent/status`
事件与 `tools/execute` 钩子，因此状态改由宿主采集、经 SSE（`/api/dsh-coopanion-pet/events`）下发。
这条通道同时也为 P2 的「注册工具」铺好了路——反向通道现成。

**仍未做的**：

| 功能 | 状态 |
| --- | --- |
| i18n | ✅ 已做（v1.2 中英 / **v1.5 补齐 11 门**）：界面文案与上游一致的 11 门，每门 128 键完整；缺键时按语言回退（繁中→中文，其余→英文）。默认跟随浏览器语言，设置面板可指定，改完即时重挂 |
| 装扮页的高级项 | 仍未做。上游还支持导入第三方形象包（zip/文件夹），需要文件选择与沙箱加载 |

---

## P2 ✅ 接入 DSH（已完成）

| 功能 | 依赖 | 状态 |
| --- | --- | --- |
| **注册 `pet_*` 工具** | cordis `tools` 服务 | ✅ 6 个：`say`/`ask`/`walk`/`act`/`dress`/`status`（`lib/tools.js`） |
| **宿主↔浏览器双向通道** | `webServer.register` + SSE + POST | ✅ `lib/channel.js`：命令编号、下发、等回执、超时兜底、离线判定 |
| **用户回答回到会话** | `agent.followup` | ✅ 页面 POST 回答 → 宿主作为新消息送回会话 |
| **桌面侧状态上报** | 同一条 POST 通道 | ✅ 位置、模式、装扮定期上报，`pet_status` 据此回答 |
| **工具定义 schema 转换** | 无（自实现） | ✅ `lib/define-tool.js`，不依赖宿主内部包 |
| **设置面板** | `slots.register('settings.section')` | ✅ `assets/settings.js`，设置页「桌宠」一栏 |
| **环境提示词注入** | `systemPrompt.section` | ✅ `lib/prompt.js`，写了「什么时候不该用」 |

**P2 踩过的两个坑**（记下来省得重踩）：

1. **工具注册必须走 `defineTool` 那一步。** DSH 官方的工具都用 `defineTool()` 造，它把「属性上写
   `required: true`」提成对象级的 `required: [...]` 数组。直接调 `tools.register()` 会报
   `required is not supported on type "boolean"`——**六个工具全部注册失败**，而且失败信息只在
   注册时抛出，不看返回值容易漏。本插件自实现同样的转换（`lib/define-tool.js`），
   不硬依赖 `@deepseek-ai/dsh-tools`。

2. **状态上报别用 `keepalive`。** 她走动时位置每帧都变，上报是高频的；浏览器在同一个 `keepalive`
   请求还没落地时再次发起会取消前一个（`ERR_ABORTED`），于是每次上报都变成「一次成功 + 一次被取消」。
   改为普通 fetch + 在途只留一条 + 位置量化到 10px。

**仍未做的**：

| 功能 | 为什么 |
| --- | --- |
| 状态映射细化 | ✅ 已补（v1.3）：「听 / 朗读 / 看屏幕 / 操作电脑」四类，覆盖语音与 CUA 工具；仍可再细 |

**实测注意**：验证 profile 里没有活跃会话时 `tools` 注册表为空（`tools.get('read')` 返回空、
`schemas()` 为 0 个），但 `ctx.inject(['tools'])` 仍会触发，注册也能成功——工具是全局的，
只是「当前没有 agent 能调用」。因此注册要走 `ctx.inject(['tools'])`，不要假设 `apply` 时刻就能拿到。

另外两条实测结论：

- `systemPrompt` 的读取方法是 `assemble()`，不是 `render()`；`layers` 是个对象
  （`createLayer`/`onChange`/`global`/`scoped`），不是数组。
- 设置面板与桌宠各持一份偏好（面板写 `localStorage`，桌宠读内存副本），因此桌宠每 32 帧
  比对一次 `localStorage` 并同步面板能改的那几项，否则面板改了要重载才生效。

---

## P3 🟡 借宿主能力（部分已完成）

| 功能 | 状态 | 做法 |
| --- | --- | --- |
| **麦克风采集** | ✅ v1.3 | `getUserMedia` + AudioWorklet（`assets/mic-worklet.js`，原样取自上游），录成 16kHz 单声道 PCM16 并封成 WAV |
| **语音识别（ASR）** | ✅ v1.3 | **不自己搬**。接 DSH 的 `speechToText` 宿主服务（`dsh-experimental-voice-input-bundle`），页面只把 WAV 交给 `pet_listen` 的宿主端点。未装时安全跳过 |
| **语音合成（TTS）** | ✅ v1.3 | **不自己搬**。宿主代理到 [dsh-xiaomi-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) 注册的同源路由 `/plugins/xiaomi-mimo-tts/synthesize`，页面只负责播。未装时安全跳过 |
| **切句器（segmenter）** | 未搬 | 上游 `src/asr/segmenter.ts`（310 行「两级都是纯逻辑」）。**当前不需要**：DSH 的识别接口收的是**整段 WAV**，切句由录音时长与调用方决定，不在插件里做流式切分。若将来要做「边听边识别」再搬 |
| **说话热键** | ✅ v1.4 | 不搬 `koffi` FFI。改走 **DSH 自己的 `shortcuts` 服务**（`registerFixed` + `observeFixedInput`）：它已经处理了输入框焦点、终端区域、弹窗、IME 组合与「正在录快捷键」，自己挂 window keydown 会误触发也会抢键。默认 `Ctrl+Shift+.`，登记进快捷键速查、可改；服务不存在时静默跳过。**真正的「全局」热键（应用失焦也生效）仍交给 Electron 宿主** |
| **对话页** | 不搬 | `src/chat.ts` 依赖事件库游标分页、附件存储、pending 提升/撤回；DSH 已有完整会话 UI |

**可选性的实现方式（重要）**：语音这两条**都不写进 cordis 的 `inject`**。
`inject` 是必需依赖，缺一个整插件就加载不了；语音是锦上添花，装不装都不该挡住桌宠。
因此用**运行期探测**：宿主侧 `ctx.get('speechToText')` 在就给函数、不在就返回 `null`；
TTS 只看它注册的同源路由在不在（路由是公开契约，也是真正要用的东西）。
两者在不可用时都回 `501` 与一句「装什么」，页面据此安全跳过。

---

## P4 ⛔ DSH 插件拿不到

这些要么绑死 Electron 主进程，要么需要原生输入注入。DSH 插件跑在浏览器里，够不着。

| 功能 | 为什么不行 |
| --- | --- |
| **电脑操作（CUA，10 个工具）** | 需要子进程 + `koffi` + 三平台原生输入（`src/cua/`）。**但 DSH 侧已经有人做了**：见下节 |
| **透明置顶窗口、鼠标穿透租约** | `host/electron-main.cjs`（511 行）。Web 页面没有窗口概念 |
| **托盘、跨屏跟随、OBS 叠加** | 同上 |
| **屏幕采样光晕** | GDI 屏幕采样，Electron 专属 |

**有价值的部分**：`src/cua/cua.ts` 的权限政策层（四级权限 + 让位空闲检测）设计是通用的，
如果将来 DSH 侧要做 CUA，这套政策可以直接照搬；只有「空闲检测」依赖原生
`GetLastInputInfo`，浏览器里只能近似。

### CUA：接入已有的 DSH 插件，不自己实现 `[已验证]`

**结论：接 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)，本插件只做「认得它在干什么」这一层。**

核对过它的实现（本机桌面 profile 里装的是 `dsh-computer-use-win@0.4.1`）：

| 事实 | 证据 |
| --- | --- |
| 它是 MCP 服务，经官方桥接挂进 DSH | `cordis.patch.yml` 里是 `name: 'dsh-computer-use-win/mcp/dsh-plugin.mjs'`，内部 `await import('@deepseek-ai/dsh-mcp-client')` |
| 模型看到的工具名是 `mcp__wincu__<tool>` | 桥接的命名规则是 `mcp__<serverName>__<rawName>`，它配的 `serverName: 'wincu'` |
| 能力覆盖 23 个工具 | `server.mjs` 里 `windows_computer_use_` 前缀的定义：snapshot / accessibility_tree / find / click / type_text / ocr / screenshot / wait_for … |
| 已有精简模式 | `mode: lite`（9 个常用工具 + 1 个发现入口，9,046 字符）与 `full`（23 个，20,259 字符） |
| 权限与生命周期归官方桥接 | 它的 `apply` 只做配置与模式切换，连接所有权「保持在官方桥接上，不自己再写一个 MCP 客户端」 |

**因此不自己实现，理由三条**：

1. **它是宿主能力，插件拿不到。** 上游 Coopanion 的 `src/cua/` 要子进程 + `koffi` + 三平台原生输入；
   浏览器插件没有子进程。dsh-computer-use-win 走的是 MCP + PowerShell UIA，天然在宿主侧。
2. **重做一遍没有增量。** 上游那套 CUA 的价值在**权限政策层**（四级权限 + 让位空闲检测），
   而「有没有空闲」靠原生 `GetLastInputInfo`，浏览器只能近似。DSH 侧要做也该在宿主侧做。
3. **本插件能贡献的正是它缺的那一环：表现层。** 它没有桌面形象，用户在它跑的时候看不见「它在干什么」。

**本插件实际做的事（v1.3）**：状态气泡认得 `mcp__wincu__*`，归成两类并给出图标与文案——

- `snapshot / accessibility_tree / find / element_info / screenshot / ocr / list_windows` → **正在看屏幕**
- `click / double_click / move / drag / scroll / type_text / keypress / focus / invoke / set_value` → **正在操作电脑**

并且从参数里取具体对象（`title` / `window` / `text` / `name`），气泡显示成「正在操作电脑 · 记事本」。
**没有新增任何工具、没有改它的配置**——它装不装、开不开，桌宠都照常工作。

### CUA 审批：把上游那套权限政策层搬过来（v1.4）`[已验证]`

上游 `src/cua/config.ts` 的四级权限是这套设计里最通用的部分，v1.4 把它做进了
`lib/cua-policy.js`，但**换了个落点**：

| | 上游 Coopanion | 本插件 v1.4 |
| --- | --- | --- |
| 闸门挂在 | 它自己的 `call()` 里（因为 CUA 是它自己实现的） | DSH 的 `tools/pre-execute` 策略接缝（因为 CUA 是别的插件实现的） |
| 谁问 | 桌宠气泡，退到系统对话框 | 桌宠气泡（`confirm` 命令 → 气泡两选项） |
| 档位 | `ask-each-turn` / `ask-before-acting` / `ask-once` / `never-ask` | 同名同义，逐档对齐 |
| 授权时长 | `grantMinutes`（默认 30） | 同 |
| 一轮一答 | 是（`onTurnEnded` 清掉） | 是（`agent/status` 非 running 时 `endTurn()`） |
| 失败语义 | 超时/拒绝 → `NotPermitted` | 超时/拒绝/抛错 → 返回 `deny` 与原因（fail closed） |
| **她不在时** | 不适用（同进程） | **放行**，交给 DSH 自己的审批通道，免得把用户的 CUA 卡死 |

**没有搬的**：`userIdleMs`（输入前先等用户离开鼠标键盘）依赖原生 `GetLastInputInfo`，
浏览器只能近似；上游的 `screenshot.maxWidth/quality/settleMs` 等截图参数属于 CUA 引擎，
归 dsh-computer-use-win 自己管。这两块本插件都不碰。

**判定抽成了纯函数** `cuaGate(exec, next, deps)`：挂在 `ctx.on('tools/pre-execute')` 里的
那段代码要跑起来得有 webserver/tools/channel 一整套服务，没法单独验；抽出来之后喂一个假
`next` 就能把每种情况钉死（15 条集成断言 + 30 条政策层断言全过）。

---

## 一句话建议

**P1 全做**（纯前端，一周内能让桌宠「活起来」），**P2 挑工具注册与设置面板做**
（这是它能帮上忙的关键），**P3/P4 不要自己搬**——那些能力该由 DSH 宿主提供，
插件只管表现层与政策层。
