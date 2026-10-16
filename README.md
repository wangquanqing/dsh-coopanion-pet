# Coopanion 桌宠（DSH 插件）

把 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的桌面宠物搬进 DeepSeek Harness 的 Web 界面，
作为零侵入的 UI 插件运行。当前版本实现 **P0：桌宠本体**——

- **鲸鱼娘（DeepSeek Chan）** 站在界面下沿，可自由走动
- 待机动画：呼吸、眨眼、视线跟随鼠标、头发与裙摆的弹簧摆动
- **鼠标拖拽**：抓住她拖到任意位置，松手后落下，甩得快会晕
- **不挡界面**：只有光标落在她本体上时才接管指针，其余区域完全放行

形象、动画与渲染内核 **原样取自 Coopanion**，未作修改。

## 安装

需要一个带 Web UI 的 profile（`dsh web`、DSH 桌面端，或任何含 `@deepseek-ai/dsh-web-app` 的组合）。

```powershell
dsh plugin --profile <你的profile> add "file:<本目录的绝对路径>"
```

例如：

```powershell
dsh plugin --profile web add "file:D:\path\to\coopanion-dsh-pet"
```

装完**重启宿主**（浏览器刷新不够，客户端模块需要重新装配）。桌面端由 Electron 独占管理其 profile，
请在桌面端的插件管理界面安装，不要直接对 `desktop` profile 执行上面的命令。

卸载：`dsh plugin --profile <profile> remove coopanion-dsh-pet`。

## 它做了什么

单包双面，两个半边各司其职，都不修改任何内置包文件：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js` | 注册只读静态路由 `/api/coopanion-dsh-pet/assets/`，把包内 `assets/` 供给浏览器 |
| 客户端 | `client.js` | 向 `shell.overlay` 插槽注册桌宠组件，在覆盖层里跑 WebGL 渲染循环 |

路由用 `prefix` 而非 `exact`，因为形象包内部有相对路径导入（`whale/figure.js` → `../kit/rig.js`、
纹理 `tex/*.png`），只有路径形式的 URL 才能让浏览器按相对关系解析成功。

## 资源构成

```
assets/
├── kit/            Coopanion 的渲染内核（约 1.2k 行，自包含）
│   ├── rig.js        Live2D 式 WebGL sprite rig：网格蒙皮 + 形变器树，零依赖
│   └── body.js       身体仿真：走路、跳跃、拖拽、27 种表情、粒子、物理
└── whale/          DeepSeek 鲸鱼娘形象包
    ├── figure.js     把每帧转成 rig 参数，为头发/裙摆/尾巴跑弹簧，绘制表情
    ├── model.json    骨架、部件、形变器、配色方案定义
    ├── tex/          25 张身体部件纹理
    ├── feat/         25 张表情贴图（眼、嘴、腮红、皮肤）
    └── outfits/cape/ 20 张冬装纹理
```

合计 2.3 MB，全部本地加载，无外部请求、无遥测。

### 渲染内核为什么能直接搬

`kit/rig.js` 零 import，`kit/body.js` 只依赖 `rig.js`，形象包通过 `opts.kit` 注入渲染器。
这套内核不依赖 Coopanion 的 World 协议、socket 或 Electron，是干净的可移植单元。

## 已做的适配

移植时改动集中在这三处，其余照搬：

1. **指针改为坐标命中判定。** Coopanion 里桌宠跑在 Electron 透明窗口里，靠窗口级
   `setInteractive` 切换鼠标穿透。浏览器没有这个概念。本插件让覆盖层与其中所有元素始终
   `pointer-events:none`，把指针处理挂在 `window` 捕获阶段，用渲染内核每帧回报的命中圆
   按坐标判定：命中才拦事件并拖拽，否则原样放行。

   这样处理还避开了一个陷阱：`pointer-events` 从 `none` 切到 `auto` 时，浏览器不会把已在
   该位置的指针重定向过去，因此「悬停时才激活热区」的写法在真实点击下并不生效。

2. **不调用 `set({ theme })`。** 渲染内核的该方法会写 `document.documentElement.dataset.theme`，
   与 DSH 自己的主题机制（`data-ds-theme-source`）冲突。配色改由内核 CSS 的
   `prefers-color-scheme` 自行判断。

3. **帧循环加了 `dt` 上限。** 标签页切回或系统休眠后 `dt` 会非常大，不限制的话她会一帧冲过整个屏幕。

## 验证状态

在真实浏览器（Edge headless + SwiftShader）里对 DSH Web UI 做过端到端验证：

| 项 | 结果 |
| --- | --- |
| 桌宠渲染 | 通过 —— 覆盖层与画布存在，WebGL 上下文存活，逐像素采样确认 5971 个不透明像素 |
| 画面在动 | 通过 —— 相隔 900ms 的两次采样像素值不同 |
| 拖拽 | 通过 —— 抓取本体左拖 300px，实际位移 308px |
| 界面穿透 | 通过 —— 点她本体：界面收到 0 次事件；点她旁边空白与界面中央：各收到 1 次 |
| 光标反馈 | 通过 —— 悬停在她身上 `grab`，离开后清除 |
| 主题未被污染 | 通过 —— `html` 上无 `data-theme` |
| 控制台错误 / 失败请求 | 均无 |

## 配置

偏好写在 `localStorage` 的 `coopanion-dsh-pet:prefs`（JSON），刷新后生效：

```json
{ "enabled": true, "scale": 0.38, "roam": "calm", "startShare": 0.78 }
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 是否显示桌宠 |
| `scale` | 体型系数（内核标准值 0.42，此处取其约 0.9 倍） |
| `roam` | 漫游倾向：`off` / `calm` / `free` 等内核取值 |
| `startShare` | 初始横向位置，占窗口宽度的比例 |

## 后续

P1 及以上（气泡说话、表情动作、走路指令、接入会话与工具状态、装扮、语音、电脑操作等）
见 [ROADMAP.md](./ROADMAP.md)，其中按移植难度与依赖做了分级。

## 许可

形象、动画与渲染内核来自 Coopanion，版权归 Pal AI Lab，**AGPL-3.0-or-later**。
本插件作为衍生作品同样以 AGPL-3.0-or-later 发布，详见 [LICENSE](./LICENSE)。
