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

自包含的前端逻辑，不依赖 DSH 任何服务。

| 功能 | 来源 | 状态 |
| --- | --- | --- |
| **气泡说话 + 打字机效果** | `web/pet-app.js` 的 say 分支 | ✅ `assets/bubble.js` |
| **表情与动作标记** | `web/kit/body.js` 词表 + `pet-app.js` 的 anchors | ✅ `【…】` 与 `<…>` |
| **提问气泡（带选项）** | `web/pet-app.js` 的 ask 分支 | ✅ 3 选项 + 自填框 + `1`–`3` 键 |
| **声音** | `web/sound.js` | ✅ `assets/sfx.js`，全部 WebAudio 合成，零素材 |
| **悬停按钮与右键菜单** | 上游由 World 协议驱动 | ✅ `assets/ui.js`，本插件新写 |
| **气泡样式与主题对接** | `web/pet.css` 气泡段落 | ✅ `assets/bubble.css.js`，接 DSH 主题令牌 |

**从 P1 挪到后面的**：

| 功能 | 为什么往后放 |
| --- | --- |
| 状态气泡（「正在思考 / 正在读」） | 数据源是 DSH 的会话状态，属于 P2 |
| 装扮页 | 上游是独立页面（`dress.html`），需要自己的路由与 UI，工作量接近独立功能 |
| 其余 7 套配色方案 | 素材每套约 1.4MB，按需再加；当前内置 deepseek 一套 |
| 冬装（cape） | 素材已在包内，缺 UI 入口；可与装扮页一起做 |
| i18n | 形象名已带 11 语言；界面文案目前只有中文 |

---

## P2 🟡 接入 DSH（下一步）

| 功能 | 依赖 | 做法 |
| --- | --- | --- |
| **注册 `pet_*` 工具** | cordis `tools` 服务 | 让 Agent 能指挥她说、问、走、做动作。Coopanion 的 6 个工具 handler 在 `src/world.ts` 里可基本原样搬；本插件的 `window.__dshCoopanionPet` 已经是现成的调用面 |
| **桌宠响应会话状态** | 会话事件 + `slots` | 把「正在思考 / 调用工具 / 完成」映射成她的表情与状态气泡 |
| **设置面板** | `slots.register('settings.section')` | 把偏好从 `localStorage` 提到 DSH 设置页，替换当前只能右键改的状态 |
| **环境提示词注入** | `dsh-system-prompt` 段 | 让模型知道桌宠存在与可用工具，来源 `src/ENV_PROMPT.md`（49 行） |
| **宿主↔浏览器实时通道** | `webServer.registerUpgrade` | Agent 要主动驱动桌宠需要一条 WS 或 SSE；DSH 的 `webServer` 提供 `registerUpgrade` |

**关键说明**：P2 的「注册工具」是让桌宠从「装饰」变成「能陪你干活的角色」的分水岭。
Coopanion 原有的通信是 `ws://127.0.0.1:7797/socket?role=pet`，帧格式为带 `t` 字段的 JSON
（下行 18 种、上行 20 种）。移植时不必照搬这套协议，直接用 DSH 的 cordis 事件与服务更自然。

---

## P3 🔴 需要宿主能力

| 功能 | 障碍 | 可能的出路 |
| --- | --- | --- |
| **麦克风采集** | 只是 `getUserMedia` + AudioWorklet（36 行），本身不难 | 但消费端（ASR）是障碍，见下 |
| **语音识别（ASR）** | 依赖 `sherpa-onnx-node` 原生模块 + 240/375MB 模型；或 Windows SAPI 常驻 PowerShell | 接 DSH 已有的语音输入插件（`dsh-experimental-voice-input-bundle`），别自己搬 |
| **全局说话热键** | 用 `koffi` FFI 轮询 `GetAsyncKeyState`，浏览器拿不到 | 改成页内快捷键；全局热键交给 Electron 宿主 |
| **对话页** | `src/chat.ts` 依赖事件库游标分页、附件存储、pending 提升/撤回 | DSH 已有完整会话 UI，没必要搬；改为让桌宠读 DSH 的会话状态 |

**可捡的便宜**：`src/asr/segmenter.ts`（310 行切句器 + 打包器）文件头明确写「两级都是纯逻辑」，
可原样移植，将来接任何 ASR 都用得上。`src/asr/result.ts`（幻觉过滤）同理。

---

## P4 ⛔ DSH 插件拿不到

这些要么绑死 Electron 主进程，要么需要原生输入注入。DSH 插件跑在浏览器里，够不着。

| 功能 | 为什么不行 |
| --- | --- |
| **电脑操作（CUA，10 个工具）** | 需要子进程 + `koffi` + 三平台原生输入（`src/cua/`）。除非改由 DSH 宿主侧提供，插件只留 UI 与权限政策层 |
| **透明置顶窗口、鼠标穿透租约** | `host/electron-main.cjs`（511 行）。Web 页面没有窗口概念 |
| **托盘、跨屏跟随、OBS 叠加** | 同上 |
| **屏幕采样光晕** | GDI 屏幕采样，Electron 专属 |

**有价值的部分**：`src/cua/cua.ts` 的权限政策层（四级权限 + 让位空闲检测）设计是通用的，
如果将来 DSH 侧要做 CUA，这套政策可以直接照搬；只有「空闲检测」依赖原生
`GetLastInputInfo`，浏览器里只能近似。

---

## 一句话建议

**P1 全做**（纯前端，一周内能让桌宠「活起来」），**P2 挑工具注册与设置面板做**
（这是它能帮上忙的关键），**P3/P4 不要自己搬**——那些能力该由 DSH 宿主提供，
插件只管表现层与政策层。
