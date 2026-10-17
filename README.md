# Coopanion 桌宠（DSH 插件）

把 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的桌面宠物搬进 DeepSeek Harness 的 Web 界面，
作为零侵入的 UI 插件运行。当前版本实现 **P0 桌宠本体 + P1 表现层 + P2 接入 DSH**——

**桌宠本体**

- **鲸鱼娘（DeepSeek Chan）** 站在界面下沿，可自由走动
- 待机动画：呼吸、眨眼、视线跟随鼠标、头发与裙摆的弹簧摆动
- **鼠标拖拽**：抓住她拖到任意位置，松手后落下，甩得快会晕
- **不挡界面**：只有光标落在她本体或她自己的界面元素上时才接管指针，其余区域完全放行

**说话与互动**

- **气泡说话**：文字逐字出现，标点处自然停顿，说完自动收起
- **表情与动作标记**：`【happy, jump】` 先播再说话，`<happy>` 打到那个字时播
- **提问气泡**：最多 3 个选项 + 自填框，按 `1`–`3` 可直接选，`Esc` 放弃
- **悬停按钮条**：靠近她时出现，可让她说话、换表情、做动作、走两步、装扮、睡觉
- **右键菜单**：装扮、状态气泡开关、音效、体型、漫游倾向、回到原位、隐藏
- **音效**：全部由 Web Audio 合成，不带任何音频素材，不增加额外体积

**状态气泡**

- 她头顶会显示**你正在做什么**：`正在看文件` / `正在写文件` / `正在查找` / `正在跑命令` / `等待回答` / 思考中的三个点
- **细到具体对象**：`正在看文件 · config.ts`、`正在跑命令 · pnpm test`——从工具参数里取文件名或命令，只留 basename 免得把完整路径摊在屏幕上
- 数据来自宿主侧的 `agent/status` 与 `tools/execute`，经 SSE 推给页面
- **对话永远优先**：她说话或提问时，状态气泡自动让位

**装扮**

- **8 套配色**：DeepSeek / Harness / ChatGPT / Claude / Gemini / Qwen / Kimi / MiniMax
- **2 套服装**：女仆装、冬装
- 面板可拖动，位置会记住

**Agent 能指挥她（P2）**

装了本插件后，Agent 多了 6 个工具，可以在对话中直接让她做事：

| 工具 | 做什么 |
| --- | --- |
| `pet_say` | 让她在气泡里说话，支持 `【表情, 动作】` 与 `<表情>` 标记 |
| `pet_ask` | 让她问用户一个问题（最多 3 个选项 + 自填框），用户的回答会作为新消息回到会话 |
| `pet_walk` | 走到屏幕某个横向位置，可让她跑 |
| `pet_act` | 做一个表情或动作（19 种表情、14 个动作） |
| `pet_dress` | 换配色或服装 |
| `pet_status` | 查她现在在不在、在哪、在做什么 |
| `pet_quiet` | 让她安静 N 分钟：关音效、不走动、状态气泡让位，到时自动恢复。不动用户的偏好 |
| `pet_set` | 改她自己的体型、漫游倾向、音效、状态气泡开关 |

她不在（没有页面打开）时，工具会如实回报 `offline` 而不是假装成功。

**她记得自己站哪儿**

刷新或重开页面后回到上次的位置（存的是占窗口宽度的比例，换窗口大小也不会跑出屏幕）。

**设置面板与提示词（P2）**

- 设置页多出一栏「桌宠」：显示开关、状态气泡、音效、体型、漫游——改完立刻生效，不必重载
- 系统提示词里多一段，告诉模型她存在、有哪些工具、**什么时候不该用**
  （不要为了让她说话而每轮都调用一次工具，她是背景陪伴不是旁白）

形象、动画与渲染内核 **原样取自 Coopanion**，未作修改。

## 安装

需要一个带 Web UI 的 profile（`dsh web`、DSH 桌面端，或任何含 `@deepseek-ai/dsh-web-app` 的组合）。

**从 npm 装**（推荐）：

```powershell
dsh plugin --profile <你的profile> add dsh-coopanion-pet
```

指定版本：`dsh plugin --profile <你的profile> add dsh-coopanion-pet@1.0.0`

**从 GitHub 装**（跟仓库 main 分支）：

```powershell
dsh plugin --profile <你的profile> add "github:wangquanqing/dsh-coopanion-pet"
```

**从本地目录装**：

```powershell
dsh plugin --profile <你的profile> add "file:D:\path\to\dsh-coopanion-pet"
```

装完**重启宿主**（浏览器刷新不够，客户端模块需要重新装配）。桌面端由 Electron 独占管理其 profile，
请在桌面端的插件管理界面安装，不要直接对 `desktop` profile 执行上面的命令。

卸载：`dsh plugin --profile <profile> remove dsh-coopanion-pet`。

## 它做了什么

单包双面，两个半边各司其职，都不修改任何内置包文件：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js` | 静态路由；采集运行状态经 SSE 下发；注册 `pet_*` 工具；收页面回传 |
| 宿主 | `lib/channel.js` | 双向通道：命令编号、下发、等回执、超时兜底、离线判定 |
| 宿主 | `lib/tools.js` | 六个 `pet_*` 工具的定义与执行 |
| 宿主 | `lib/define-tool.js` | 把属性级 `required: true` 转成标准 JSON Schema（见下） |
| 客户端 | `client.js` | `shell.overlay` 插槽里的桌宠，跑 WebGL 循环，收命令、发回执 |

路由用 `prefix` 而非 `exact`，因为形象包内部有相对路径导入（`whale/figure.js` → `../kit/rig.js`、
纹理 `tex/*.png`），只有路径形式的 URL 才能让浏览器按相对关系解析成功。

### 三个 HTTP 端点

| 端点 | 方向 | 用途 |
| --- | --- | --- |
| `/api/dsh-coopanion-pet/assets/*` | 宿主 → 浏览器 | 渲染内核、形象包、纹理 |
| `/api/dsh-coopanion-pet/events` | 宿主 → 浏览器（SSE） | 运行状态；Agent 下发的命令 |
| `/api/dsh-coopanion-pet/report` | 浏览器 → 宿主（POST） | 命令回执、用户回答、桌面侧状态 |

不用 DSH 的 RPC 做上下行：本插件只需要「推一件事、回一件事」，自己的路由更直接，
也不依赖宿主内部接口的稳定性。

### 状态为什么要绕宿主一圈

探针实测（dsh 0.2.0-rc.2）显示，浏览器端的插件 `apply` 运行时**只有 `slots`、`connection`、
`loader`、`modules` 四个服务可用**，`sessions`、`conversation`、`theme`、`locale` 都取不到；
而 `shell.overlay` 是 root 作用域插槽，框架注入的标准 props（`GlobalStandardProps`）是空接口，
也没有会话信息。所以状态气泡不能由客户端自己取数。

宿主侧则拿得到：`agent/status` 事件（一轮对话的开始与结束）与 `tools/execute` 钩子（每次工具调用）。
因此状态由宿主采集、经 SSE 下发，客户端只负责显示。同一条通道也让 `pet_*` 工具能反向驱动页面。

### 工具定义为什么要自己转 schema

DSH 官方的工具都用 `defineTool()` 造，它把「属性上写 `required: true`」的写法提成对象级的
`required: [...]` 数组。直接调 `tools.register()` 绕过这一步，注册会报
`required is not supported on type "boolean"`。

`lib/define-tool.js` 做同一件事，但不依赖 `@deepseek-ai/dsh-tools`——那是宿主内部包，
版本一变就可能对不上。转换只有两条规则：标了 `required: true` 的属性名进 `required` 数组，
属性自己的那个标记去掉。

## 资源构成

```
assets/
├── kit/            Coopanion 的渲染内核（约 1.2k 行，自包含，原样复制）
│   ├── rig.js        Live2D 式 WebGL sprite rig：网格蒙皮 + 形变器树，零依赖
│   └── body.js       身体仿真：走路、跳跃、拖拽、19 种表情、18 个动作、粒子、物理
├── whale/          DeepSeek 鲸鱼娘形象包（原样复制）
│   ├── figure.js     把每帧转成 rig 参数，为头发/裙摆/尾巴跑弹簧，绘制表情
│   ├── model.json    骨架、部件、形变器、配色方案定义
│   ├── tex/          25 张身体部件纹理（deepseek 配色）
│   ├── feat/         25 张表情贴图（眼、嘴、腮红、皮肤）
│   ├── outfits/cape/ 20 张冬装纹理
│   └── schemes/      其余 7 套配色，每套 50 张纹理，共约 9.6 MB
├── sfx.js          音效：Web Audio 合成，无音频素材（移植自 web/sound.js）
├── bubble.js       气泡：打字机、标记、提问与选项（移植自 pet-app.js 的 say/ask 分支）
├── bubble.css.js   气泡样式，配色对接 DSH 主题令牌
├── status.js       状态气泡：接 SSE，让位于对话（移植自 pet-app.js 的 stepStatus）
├── dress.js        装扮面板：配色与服装切换（新写）
├── ui.js           悬停按钮条与右键菜单（新写，上游这些由 World 协议驱动）
└── ../lib/         宿主半边（通道、工具定义）
```

合计约 15 MB，其中 9.6 MB 是 7 套可选配色；只用默认配色的话实际加载约 2.5 MB
（纹理按需拉取，切换配色时才加载那一套）。全部本地加载，无外部请求、无遥测。

### 渲染内核为什么能直接搬

`kit/rig.js` 零 import，`kit/body.js` 只依赖 `rig.js`，形象包通过 `opts.kit` 注入渲染器。
这套内核不依赖 Coopanion 的 World 协议、socket 或 Electron，是干净的可移植单元。

## 已做的适配

移植时改动集中在这几处，其余照搬：

1. **指针改为坐标命中判定。** Coopanion 里桌宠跑在 Electron 透明窗口里，靠窗口级
   `setInteractive` 切换鼠标穿透。浏览器没有这个概念。本插件让覆盖层与其中所有元素始终
   `pointer-events:none`，把指针处理挂在 `window` 捕获阶段，用渲染内核每帧回报的命中圆
   按坐标判定：命中她本体、或命中她自己弹出的按钮条与气泡时才拦事件，否则原样放行。

   这样处理还避开了一个陷阱：`pointer-events` 从 `none` 切到 `auto` 时，浏览器不会把已在
   该位置的指针重定向过去，因此「悬停时才激活热区」的写法在真实点击下并不生效。

2. **不调用 `set({ theme })`。** 渲染内核的该方法会写 `document.documentElement.dataset.theme`，
   与 DSH 自己的主题机制（`body[data-ds-dark-theme]`）冲突。配色改由内核 CSS 的
   `prefers-color-scheme` 与气泡 CSS 的 DSH 令牌各自判断。

3. **帧循环加了 `dt` 上限。** 标签页切回或系统休眠后 `dt` 会非常大，不限制的话她会一帧冲过整个屏幕。

4. **音效去掉音频文件支路。** 上游会加载形象包自带的音频，本插件只用合成音，
   因此 `sfx.js` 去掉了 `usePack` 与解码逻辑，`play` 直接进合成器。

5. **气泡按需创建、随桌宠卸载。** 上游的气泡是页面固定元素，这里由插件创建并
   在卸载时移除，不留残余。

6. **状态来自宿主而非页面。** 见上文「状态为什么要绕宿主一圈」。

7. **装扮面板重写为插件内面板。** 上游是独立页面（`dress.html` + `dress.js`），
   本插件把它做成跟随桌宠的浮层，只保留配色与服装两条轴。

8. **状态上报不用 `keepalive`，且在途只留一条。** 她走动时位置每帧都在变，状态上报是高频的；
   浏览器在同一个 `keepalive` 请求还没落地时再次发起会把前一个取消掉（表现为 `ERR_ABORTED`），
   于是每次上报都变成「一次成功 + 一次被取消」。因此改为普通 fetch，并把位置量化到 10px 粒度，
   只有跨过一格或模式/装扮变了才发。用户的回答与命令回执走另一条必达路径（不受在途限制）。

## 验证状态

在真实浏览器（Edge headless + SwiftShader）里对 DSH Web UI 做过端到端验证：

| 项 | 结果 |
| --- | --- |
| 桌宠渲染 | 通过 —— 覆盖层与画布存在，WebGL 上下文存活，逐像素采样确认约 5.5k 个不透明像素 |
| 画面在动 | 通过 —— 相隔 900ms 的两次采样像素值不同 |
| 拖拽 | 通过 —— 抓取本体左拖 300px，实际位移 300+px |
| 界面穿透 | 通过 —— 点她本体：界面收到 0 次事件；点界面中央：收到 1 次 |
| 气泡打字机 | 通过 —— 连续采样文字长度递增（`1,3,4,…,8,10`），标点处有停顿，说完自动收起 |
| 表情动作标记 | 通过 —— `【happy, jump】` 触发新模式序列 `crouch,air,land` |
| 提问气泡 | 通过 —— 3 个选项 + 自填框，点击后回调触发并收起 |
| 悬停按钮条 | 通过 —— 靠近她时出现 6 个按钮，点击生效 |
| 右键菜单 | 通过 —— 8 个菜单项，`Esc` 可关闭 |
| 装扮面板 | 通过 —— 8 套配色 + 2 套服装，切换后纹理真的换了且画面仍在动 |
| 状态气泡样式 | 通过 —— 状态类样式与思考动画规则已注入 |
| 状态链路 | 通过 —— 宿主 `emit('agent/status','running')` 后，SSE 依次推出 `none → think → none` |
| 音效模块 | 通过 —— 6 类声音，`AudioContext` 可用 |
| 主题未被污染 | 通过 —— `html` 上无 `data-theme` |
| 控制台错误 / 失败请求 | 均无 |

**P2 工具闭环**（用一个会回执的客户端扮演页面，让探针调真实工具）：

| 项 | 结果 |
| --- | --- |
| 工具注册 | 通过 —— 6 个 `pet_*` 全部注册，`disposer` 都是函数 |
| 命令下发 | 通过 —— SSE 依次推出 5 条命令帧，编号 `c1`–`c5`、参数完整 |
| 回执闭环 | 通过 —— 扮演页面对 5 条命令全部回执 204，工具拿到 `ok:true` |
| 离线如实回报 | 通过 —— 没有页面连上时返回 `offline` 与原因，不假装成功 |
| 端点校验 | 通过 —— `/report` 只收 POST（GET 返回 405），坏 JSON 与未知 kind 返回 400 |

**P2 设置面板与提示词**：

| 项 | 结果 |
| --- | --- |
| 设置面板出现 | 通过 —— 设置页导航多了「桌宠」一栏，面板含 3 个开关 + 2 组选择 |
| 面板改设置生效 | 通过 —— 体型改到「大」后，她的画布从 107px 变成 135px |
| 提示词注入 | 通过 —— `systemPrompt.assemble()` 渲染出 7914 字符，里面含完整的桌宠段落 |

**v1.0 收尾三项**：

| 项 | 结果 |
| --- | --- |
| `pet_quiet` | 通过 —— `minutes: 1` 返回「安静约 1 分钟」，安静期间位置 `0 → 0` 不动，`minutes: 0` 立刻恢复 |
| `pet_set` | 通过 —— 依次改成 small / large / medium + roaming quiet，均返回 `ok:true` |
| 参数校验 | 通过 —— 空 `pet_set` 报 `empty`，`size: 9` 报 `bad-size`，`roam: -1` 报 `bad-roam` |
| 位置记忆 | 通过 —— 存下比例、重载后回到原处 |

**v1.1 改进**：

| 项 | 结果 |
| --- | --- |
| 状态气泡显示具体对象 | 通过 —— `正在看文件 · config.ts`；`a.ts → b.ts` 切换会重绘 |
| 静止降帧省电 | 通过 —— 静止 48 次画布变化/2s（≈24fps），活动时 123 次/1.5s（≈82fps） |

**未验到的部分（如实说明）**：工具的端到端验证用的是「扮演页面的客户端」而非真实浏览器标签页——
因为探针在服务启动后几秒就开始轮询，而浏览器要十几秒才把桌宠加载完并连上 SSE，两者的时序在这个
验证环境里总是错开。因此「SSE 命令帧真的会让浏览器里的她说话/走路」这一段，是由以下两点合并支撑的：
（1）命令帧格式与 `runCommand` 的处理分支已逐条核对；（2）页面自身的执行能力（`api.say`、
装扮切换等）已在浏览器里单独验证通过。**真机上两者是同一个页面，链路是通的**，但没有一次
「真实浏览器 + 真实工具调用」的合并验证，建议首次使用时留意。

## 配置

偏好写在 `localStorage` 的 `dsh-coopanion-pet:prefs`（JSON）。右键菜单与装扮面板改的设置即时生效并落盘：

```json
{ "enabled": true, "sizeIndex": 1, "roamIndex": 0, "sound": true,
  "startShare": 0.78, "scheme": "deepseek-maid", "statusBubble": true }
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 是否显示桌宠（右键「隐藏桌宠」会置为 `false`，改回需手动编辑） |
| `sizeIndex` | 体型档位：`0` 小 / `1` 中 / `2` 大 |
| `roamIndex` | 漫游倾向：`0` 安静 / `1` 随意 / `2` 活跃 |
| `sound` | 音效开关 |
| `startShare` | 初始横向位置，占窗口宽度的比例 |
| `scheme` | 装扮，`配色-服装`，如 `claude-maid`、`deepseek-cape` |
| `statusBubble` | 是否显示状态气泡 |
| `dressPos` | 装扮面板的位置（拖动后记下） |

### 从页面里驱动她

客户端暴露了 `window.__dshCoopanionPet`，供验证脚本与将来的 Agent 接线使用：

```js
__dshCoopanionPet.say('【happy】你好呀。');   // 说话，可带标记
__dshCoopanionPet.ask('选一个？', ['甲', '乙', '丙']);  // 提问
__dshCoopanionPet.do('jump');                // 表情或动作
__dshCoopanionPet.walk(400, true);           // 走到横向 400px，true 为跑
__dshCoopanionPet.setScheme('claude-cape');  // 换装扮
__dshCoopanionPet.openDress(true);           // 开关装扮面板
__dshCoopanionPet.layout;                    // 当前布局快照
```

## 后续

P2 及以上（注册 `pet_*` 工具让 Agent 直接指挥她、设置面板、语音、电脑操作等）
见 [ROADMAP.md](./ROADMAP.md)，其中按移植难度与依赖做了分级。

## 许可

形象、动画与渲染内核来自 Coopanion，版权归 Pal AI Lab，**AGPL-3.0-or-later**。
本插件作为衍生作品同样以 AGPL-3.0-or-later 发布，详见 [LICENSE](./LICENSE)。
