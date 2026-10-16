# Coopanion 桌宠（DSH 插件）

把 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的桌面宠物搬进 DeepSeek Harness 的 Web 界面，
作为零侵入的 UI 插件运行。当前版本实现 **P0 桌宠本体 + P1 表现层**——

**桌宠本体**

- **鲸鱼娘（DeepSeek Chan）** 站在界面下沿，可自由走动
- 待机动画：呼吸、眨眼、视线跟随鼠标、头发与裙摆的弹簧摆动
- **鼠标拖拽**：抓住她拖到任意位置，松手后落下，甩得快会晕
- **不挡界面**：只有光标落在她本体或她自己的界面元素上时才接管指针，其余区域完全放行

**说话与互动**

- **气泡说话**：文字逐字出现，标点处自然停顿，说完自动收起
- **表情与动作标记**：`【happy, jump】` 先播再说话，`<happy>` 打到那个字时播
- **提问气泡**：最多 3 个选项 + 自填框，按 `1`–`3` 可直接选，`Esc` 放弃
- **悬停按钮条**：靠近她时出现，可让她说话、换表情、做动作、走两步、睡觉
- **右键菜单**：音效开关、体型、漫游倾向、回到原位、隐藏
- **音效**：全部由 Web Audio 合成，不带任何音频素材，不增加包体积

形象、动画与渲染内核 **原样取自 Coopanion**，未作修改。

## 安装

需要一个带 Web UI 的 profile（`dsh web`、DSH 桌面端，或任何含 `@deepseek-ai/dsh-web-app` 的组合）。

```powershell
dsh plugin --profile <你的profile> add "file:<本目录的绝对路径>"
```

例如：

```powershell
dsh plugin --profile web add "file:D:\path\to\dsh-coopanion-pet"
```

装完**重启宿主**（浏览器刷新不够，客户端模块需要重新装配）。桌面端由 Electron 独占管理其 profile，
请在桌面端的插件管理界面安装，不要直接对 `desktop` profile 执行上面的命令。

卸载：`dsh plugin --profile <profile> remove dsh-coopanion-pet`。

## 它做了什么

单包双面，两个半边各司其职，都不修改任何内置包文件：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js` | 注册只读静态路由 `/api/dsh-coopanion-pet/assets/`，把包内 `assets/` 供给浏览器 |
| 客户端 | `client.js` | 向 `shell.overlay` 插槽注册桌宠组件，在覆盖层里跑 WebGL 渲染循环 |

路由用 `prefix` 而非 `exact`，因为形象包内部有相对路径导入（`whale/figure.js` → `../kit/rig.js`、
纹理 `tex/*.png`），只有路径形式的 URL 才能让浏览器按相对关系解析成功。

## 资源构成

```
assets/
├── kit/            Coopanion 的渲染内核（约 1.2k 行，自包含，原样复制）
│   ├── rig.js        Live2D 式 WebGL sprite rig：网格蒙皮 + 形变器树，零依赖
│   └── body.js       身体仿真：走路、跳跃、拖拽、19 种表情、18 个动作、粒子、物理
├── whale/          DeepSeek 鲸鱼娘形象包（原样复制）
│   ├── figure.js     把每帧转成 rig 参数，为头发/裙摆/尾巴跑弹簧，绘制表情
│   ├── model.json    骨架、部件、形变器、配色方案定义
│   ├── tex/          25 张身体部件纹理
│   ├── feat/         25 张表情贴图（眼、嘴、腮红、皮肤）
│   └── outfits/cape/ 20 张冬装纹理
├── sfx.js          音效：Web Audio 合成，无音频素材（移植自 web/sound.js）
├── bubble.js       气泡：打字机、标记、提问与选项（移植自 pet-app.js 的 say/ask 分支）
├── bubble.css.js   气泡样式，配色对接 DSH 主题令牌
└── ui.js           悬停按钮条与右键菜单（新写，上游这些由 World 协议驱动）
```

合计约 2.4 MB，全部本地加载，无外部请求、无遥测。

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
| 悬停按钮条 | 通过 —— 靠近她时出现 5 个按钮，点击生效 |
| 右键菜单 | 通过 —— 5 个菜单项，`Esc` 可关闭 |
| 音效模块 | 通过 —— 6 类声音，`AudioContext` 可用 |
| 主题未被污染 | 通过 —— `html` 上无 `data-theme` |
| 控制台错误 / 失败请求 | 均无 |

## 配置

偏好写在 `localStorage` 的 `dsh-coopanion-pet:prefs`（JSON）。右键菜单改的设置即时生效并落盘：

```json
{ "enabled": true, "sizeIndex": 1, "roamIndex": 0, "sound": true, "startShare": 0.78 }
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 是否显示桌宠（右键「隐藏桌宠」会置为 `false`，改回需手动编辑） |
| `sizeIndex` | 体型档位：`0` 小 / `1` 中 / `2` 大 |
| `roamIndex` | 漫游倾向：`0` 安静 / `1` 随意 / `2` 活跃 |
| `sound` | 音效开关 |
| `startShare` | 初始横向位置，占窗口宽度的比例 |

### 从页面里驱动她

客户端暴露了 `window.__dshCoopanionPet`，供验证脚本与将来的 Agent 接线使用：

```js
__dshCoopanionPet.say('【happy】你好呀。');   // 说话，可带标记
__dshCoopanionPet.ask('选一个？', ['甲', '乙', '丙']);  // 提问
__dshCoopanionPet.do('jump');                // 表情或动作
__dshCoopanionPet.walk(400, true);           // 走到横向 400px，true 为跑
__dshCoopanionPet.layout;                    // 当前布局快照
```

## 后续

P2 及以上（注册 `pet_*` 工具让 Agent 指挥她、设置面板、会话状态联动、装扮页、
语音、电脑操作等）见 [ROADMAP.md](./ROADMAP.md)，其中按移植难度与依赖做了分级。

## 许可

形象、动画与渲染内核来自 Coopanion，版权归 Pal AI Lab，**AGPL-3.0-or-later**。
本插件作为衍生作品同样以 AGPL-3.0-or-later 发布，详见 [LICENSE](./LICENSE)。
