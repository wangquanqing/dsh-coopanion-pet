/**
 * 独立桌宠的 Electron 主进程。
 *
 * 起一个**透明、无边框、置顶、可穿透**的窗口，把插件现有的桌宠加载进去，
 * 并让鼠标在「她身上」与「她之外」之间正确切换穿透。
 *
 * ## 为什么自己起一个本地服务
 *
 * 桌宠的客户端代码（`client.js`）按「页面里的绝对路径」写：
 * `/api/dsh-coopanion-pet/assets/…`、`…/events`、`…/report`。
 * 这里起一个**镜像同样路径形状**的本地服务，于是：
 *
 * - `client.js` **一个字都不用改**（不改路径、不改加载方式）
 * - 资源从**本地文件**读，因此 **DSH 没开的时候她也能出现**（这是独立壳的意义）
 * - `events`/`report` 先给「空 SSE + 204」；第 2 步改成**代理到 DSH 插件**，
 *   她的完整能力（工具、状态气泡、语音、审批）就接上了
 *
 * ## 穿透怎么工作
 *
 * 窗口默认 `setIgnoreMouseEvents(true, { forward: true })`——鼠标穿透到桌面，
 * 但**页面仍收得到 mousemove**（forward 的作用）。页面据此判断光标是否落在她身上，
 * 经 IPC 告诉主进程；落在身上就关掉穿透，点击才会给她。
 * 上游 Coopanion 与 takboo 用的都是这一套。
 */

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, globalShortcut, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- 启动参数（由宿主侧插件传入） ---------- */

/** 取 `--name=value` 形式的参数。 */
function argOf(name) {
  const prefix = '--' + name + '=';
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** 插件根目录：资源与客户端代码都在这里。 */
const PLUGIN_DIR = argOf('plugin-dir') || path.join(__dirname, '..');
const ASSETS_DIR = path.join(PLUGIN_DIR, 'assets');
/** 状态文件：验证脚本与宿主用它看主进程状态。 */
const STATUS_FILE = argOf('status-file');
/** 本地服务端口；0 = 自动挑一个。 */
const WANT_PORT = Number(argOf('port') || 0);
/**
 * 宿主侧桥接服务的端口（由插件传入）。
 *
 * 有它时：窗口的控制通道**代理到 DSH 插件**，于是 `pet_*` 工具、状态气泡、
 * 语音、审批全部照旧生效。
 * 没有它时（DSH 没开、或独立运行）：用自己的空 SSE，她只有本体能力。
 */
const BRIDGE_PORT = Number(argOf('bridge-port') || 0);
/** 唤出/收起她的全局快捷键（由偏好决定，默认与 Trae 一致）。 */
const HOTKEY = argOf('hotkey') || 'Alt+Space';
/** 自检模式：开窗口、等一会儿、写状态、退出。 */
const SELF_TEST = argOf('self-test') === '1';

/** 写一行状态（不往 stdout 写，免得污染宿主的输出）。 */
function status(line) {
  if (!STATUS_FILE) return;
  try { fs.appendFileSync(STATUS_FILE, new Date().toISOString() + ' ' + line + '\n'); } catch (error) { /* 写不了就算了 */ }
}

/* ---------- 本地静态服务（镜像 DSH 的路由形状） ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
};

/** 与宿主侧 `index.js` 里的路由保持一致。 */
const ROUTE = '/api/dsh-coopanion-pet/assets';
const EVENTS = '/api/dsh-coopanion-pet/events';
const REPORT = '/api/dsh-coopanion-pet/report';
const DESKTOP = '/api/dsh-coopanion-pet/desktop';

/**
 * 把请求原样转发到宿主桥接。
 *
 * 只转控制通道的两个端点（events / report）——静态资源仍走本地文件，
 * 因此 **DSH 没开的时候她也能出现**（这是独立壳的意义）。
 */
function proxy(req, res, targetPath) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = { ...req.headers, host: '127.0.0.1:' + BRIDGE_PORT };
    delete headers['accept-encoding'];   // 免得上游压缩后要自己解
    const up = http.request({
      host: '127.0.0.1', port: BRIDGE_PORT, path: targetPath,
      method: req.method, headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (error) => {
      status('proxy 失败 ' + targetPath + ': ' + error.message);
      try { res.writeHead(502); res.end('bridge unavailable'); } catch (e) { /* 已断 */ }
    });
    if (body) up.write(body);
    up.end();
  });
}

/** URL 路径 → 本地文件；越界或不存在返回 null。 */
function resolveFile(pathname) {
  let base = null;
  let sub = null;
  if (pathname === DESKTOP || pathname === '/') {
    base = __dirname; sub = 'pet.html';
  } else if (pathname === '/api/dsh-coopanion-pet/chat-panel') {
    base = __dirname; sub = 'chat.html';
  } else if (pathname === ROUTE + '/client.js') {
    // 与宿主路由同规则：client.js 在插件根目录，不在 assets/ 下
    base = PLUGIN_DIR; sub = 'client.js';
  } else if (pathname.startsWith(ROUTE + '/')) {
    base = ASSETS_DIR; sub = pathname.slice(ROUTE.length + 1);
  }
  if (base === null) return null;
  const target = path.normalize(path.join(base, decodeURIComponent(sub)));
  // 越界防护：必须仍在 base 之内
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  } catch (error) { return null; }
  return target;
}

/** 起本地服务，resolve 出它监听的端口。 */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = decodeURIComponent(url.pathname);

      /**
       * 控制通道的两个端点。
       *
       * 第 1 步给「空 SSE + 204」：`client.js` 会连它们，连上了就正常渲染。
       * 第 2 步这里改成**代理到 DSH 插件**，能力就接上了。
       */
      /**
       * 控制通道：**有宿主桥接时转发过去**，没有时给空实现。
       *
       * 转发这一步是关键——转发之后她连上的是**与 DSH 页面同一条 channel**，
       * 因此 `pet_*` 工具能指挥她、状态气泡能显示、语音与审批照旧。
       */
      if (p === EVENTS) {
        if (BRIDGE_PORT) { proxy(req, res, '/dsh-coopanion-pet/desktop/events'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': desktop-standalone\n\n');
        req.on('close', () => { try { res.end(); } catch (error) { /* 已断 */ } });
        return;
      }
      /**
       * 聊天端点也代理到宿主：面板因此操作的是**同一批会话**。
       */
      if (p.startsWith('/api/dsh-coopanion-pet/chat/')) {
        // 转到 bridge 自己的路径（bridge 直接实现这些端点，不再走 DSH 的 /api）
        if (BRIDGE_PORT) { proxy(req, res, p.replace('/api/dsh-coopanion-pet/', '/dsh-coopanion-pet/')); return; }
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, reason: 'offline', message: '宿主没连上，聊天面板暂不可用。' }));
        return;
      }
      if (p === REPORT) {
        if (BRIDGE_PORT) { proxy(req, res, '/dsh-coopanion-pet/desktop/report'); return; }
        req.resume();
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }

      const file = resolveFile(p);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(file)
        .on('error', () => { try { res.destroy(); } catch (e) { /* 已断 */ } })
        .pipe(res);
    });
    server.on('error', reject);
    server.listen(WANT_PORT, '127.0.0.1', () => {
      const port = server.address().port;
      status('local server on ' + port);
      resolve({ server, port });
    });
  });
}

/* ---------- 窗口 ---------- */

/** 本地服务的端口（面板与宠物页都从这里取）。 */
let localPort = 0;
let win = null;
/** 当前是否「可交互」（光标在她身上）。 */
let interactive = false;
/** 用户从右键菜单勾了「永远穿透」——她变成纯装饰，不再接任何点击。 */
let alwaysIgnoreMouse = false;
/** 独立聊天面板的窗口（点开才创建）。 */
let chatWin = null;

/**
 * 切换「可交互」。**这就是「点空白穿透到桌面、点她能交互」的实现。**
 */
function setInteractive(on) {
  if (!win || win.isDestroyed()) return;
  const next = on === true;
  if (next === interactive) return;
  interactive = next;
  // 用户勾了「永远穿透」时，自动判定不再改变穿透状态
  win.setIgnoreMouseEvents(alwaysIgnoreMouse ? true : !next, { forward: true });
  status('interactive=' + next);
}

async function createWindow(port) {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height,
    // 透明 + 无边框 + 置顶 + 不进任务栏：上游与 takboo 都用这套
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
    backgroundColor: '#00000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      // 她在窗口不聚焦时也要继续动（呼吸、走路）
      backgroundThrottling: false,
    },
  });
  // 'floating' 层级：浮在普通窗口之上，但不盖住系统弹窗
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 初始不接点击：鼠标穿透到桌面（但页面仍收 mousemove）
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once('ready-to-show', () => {
    win.show();
    status('window shown visible=' + win.isVisible() + ' alwaysOnTop=' + win.isAlwaysOnTop()
      + ' bounds=' + JSON.stringify(win.getBounds()));
  });
  win.webContents.on('did-finish-load', () => status('page loaded'));
  // 窗口失焦时也保持置顶与穿透判定正确
  win.on('blur', () => status('window blur'));
  win.on('focus', () => status('window focus'));
  win.webContents.on('render-process-gone', (e, details) => status('render gone: ' + JSON.stringify(details)));
  win.on('closed', () => { status('window closed'); win = null; });

  await win.loadURL('http://127.0.0.1:' + port + DESKTOP);
  return win;
}

/* ---------- 右键菜单（参照 Trae 的 5 项，按桌宠语境调整） ---------- */

/**
 * 在她身上右键时弹出的菜单。
 *
 * 参照 Trae 悬浮球的菜单（打开主窗口 / 打开对话浮窗 / 隐藏直到下次重启 /
 * 停用 / 悬浮球设置），但按桌宠的语境重排：
 * **她的形象就是常驻形态**（不需要悬浮球那种「点开才出现」），
 * 因此菜单的重点是「让她做什么」与「她怎么表现」。
 */
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '打开 DSH 主窗口',
      click: () => { try { shell.openExternal(bridgeOrigin() ?? 'http://127.0.0.1'); } catch (e) { /* 打不开就算了 */ } },
    },
    {
      label: '打开对话面板',
      click: () => openChat(),
    },
    { type: 'separator' },
    {
      label: '让她说话',
      click: () => sendToPage('say'),
    },
    {
      label: '隐藏直到下次启动',
      click: () => { if (win && !win.isDestroyed()) { win.hide(); status('hidden by menu'); } },
    },
    { type: 'separator' },
    {
      label: '穿透模式（鼠标穿过她）',
      type: 'checkbox',
      checked: false,
      click: (item) => {
        // 勾上 = 永远穿透（她变成纯装饰）；取消 = 恢复自动判定
        alwaysIgnoreMouse = item.checked;
        if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(alwaysIgnoreMouse ? true : !interactive, { forward: true });
        status('alwaysIgnoreMouse=' + alwaysIgnoreMouse);
      },
    },
    {
      label: '置顶',
      type: 'checkbox',
      checked: true,
      click: (item) => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(item.checked, 'floating'); },
    },
    { type: 'separator' },
    {
      label: '退出桌宠',
      click: () => { status('quit by menu'); app.quit(); },
    },
  ]);
}

/* ---------- 全局快捷键 ---------- */

/**
 * 注册全局快捷键（默认 Alt+Space，与 Trae 一致）。
 *
 * **它必须在窗口失焦时也生效**——这正是独立窗口相比「页内热键」的优势。
 * 注册失败（被别的程序占用）时如实记状态，不静默。
 */
function registerShortcuts() {
  const wanted = HOTKEY;
  try {
    const ok = globalShortcut.register(wanted, () => {
      status('hotkey fired: ' + wanted);
      // 快捷键 = 唤出/收起她
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) { win.hide(); status('hidden by hotkey'); }
      else { win.show(); status('shown by hotkey'); }
    });
    status('hotkey ' + wanted + ' = ' + (ok ? 'registered' : 'FAILED (可能被占用)'));
  } catch (error) {
    status('hotkey 注册抛错: ' + String(error && error.message ? error.message : error));
  }
}

/* ---------- 托盘 ---------- */

/** 建托盘图标（点它也能唤出/收起）。 */
function createTray() {
  try {
    // 用她自己的图标；拿不到就退化成空图标（托盘仍可用）
    const iconPath = path.join(PLUGIN_DIR, 'icon.svg');
    const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('桌宠');
    tray.setContextMenu(buildMenu());
    tray.on('click', () => { if (win && !win.isDestroyed()) { win.isVisible() ? win.hide() : win.show(); } });
    status('tray created');
  } catch (error) {
    status('tray 失败: ' + String(error && error.message ? error.message : error));
  }
}

/* ---------- 与她通信（主进程 → 页面） ---------- */

/** 宿主桥接的地址（用于「打开主窗口」）。 */
function bridgeOrigin() {
  return BRIDGE_PORT ? 'http://127.0.0.1:' + BRIDGE_PORT : null;
}

/** 让页面做一件事（经 webContents 发一个自定义事件）。 */
function sendToPage(kind) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('pet:command', { kind }); } catch (error) { /* 页面没准备好 */ }
}

/**
 * 打开独立聊天面板。
 *
 * 它是一个**单独的窗口**（不是宠物窗口里的一块）：宠物窗口是全屏透明的，
 * 不适合承载一个要滚动的对话界面。两者共用同一个本地服务（因此共用
 * `chat/*` 端点），**面板里发的消息与 DSH 主面板操作的是同一批会话**。
 */
function openChat() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show();
    chatWin.focus();
    status('chat window focused');
    return;
  }
  chatWin = new BrowserWindow({
    width: 720, height: 520,
    minWidth: 520, minHeight: 360,
    title: '桌宠 · 对话',
    backgroundColor: '#1B1626',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  chatWin.once('ready-to-show', () => { chatWin.show(); status('chat window shown'); });
  chatWin.on('closed', () => { chatWin = null; status('chat window closed'); });
  chatWin.loadURL('http://127.0.0.1:' + localPort + '/api/dsh-coopanion-pet/chat-panel');
  status('chat window opening');
}

/* ---------- IPC（渲染侧 → 主进程） ---------- */

ipcMain.on('pet:interactive', (event, on) => setInteractive(on));
/**
 * 页面请求弹右键菜单。
 *
 * 为什么由页面发起：**只有页面知道光标是否在她身上**（命中判定在渲染侧）。
 * 她在身上右键 → 弹菜单；在空白处右键 → 穿透到桌面，不该弹。
 */
/** 打开 DSH 主窗口（面板上的「在 DSH 中打开」）。 */
ipcMain.on('pet:open-main', () => {
  const origin = bridgeOrigin();
  if (origin) { try { shell.openExternal(origin); } catch (e) { /* 打不开就算了 */ } }
  status('open-main requested');
});

ipcMain.on('pet:menu', () => {
  const menu = buildMenu();
  const win2 = BrowserWindow.getFocusedWindow() ?? win;
  if (win2 && !win2.isDestroyed()) menu.popup({ window: win2 });
});
/** 页面问「我该显示哪些入口」（独立窗口 vs DSH 页面）。 */
ipcMain.handle('pet:context', () => ({
  standalone: true,
  bridge: BRIDGE_PORT || 0,
  hotkey: HOTKEY,
}));
ipcMain.handle('pet:info', () => ({
  platform: process.platform,
  pluginDir: PLUGIN_DIR,
  electron: process.versions.electron,
}));

/* ---------- 启动 ---------- */

// GPU 在这类环境里可能起不来；软件渲染下窗口照常显示（实测确认）
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  status('app ready bridge-port=' + (BRIDGE_PORT || 'none'));
  try {
    const { port } = await startLocalServer();
    localPort = port;
    await createWindow(port);
    createTray();
    registerShortcuts();
    if (SELF_TEST) {
      setTimeout(() => {
        status('self-test 结束 visible=' + (win ? win.isVisible() : 'n/a'));
        app.quit();
      }, 5000);
    }
  } catch (error) {
    status('启动失败: ' + (error && error.stack ? error.stack : String(error)));
    app.quit();
  }
});

app.on('will-quit', () => {
    // 全局快捷键必须显式注销，否则会留在系统里
    try { globalShortcut.unregisterAll(); } catch (error) { /* 忽略 */ }
    status('will-quit, shortcuts unregistered');
  });

app.on('window-all-closed', () => { status('all windows closed'); app.quit(); });
process.on('uncaughtException', (error) => status('uncaught: ' + (error && error.stack ? error.stack : String(error))));
