/**
 * 窗口页与主进程之间的桥。
 *
 * 只暴露**必要的能力**，不把 Node 交出去：
 * - `setInteractive(on)`：光标是否在她身上 → 主进程据此切换鼠标穿透
 * - `openMenu()`：在她身上右键 → 主进程弹出菜单
 * - `onCommand(fn)`：主进程让她做事（说话、打开对话面板）
 * - `info()` / `context()`：环境信息
 *
 * 用 `contextBridge` + `sandbox: true` + `contextIsolation: true`：
 * 页面拿不到 `require`，也摸不到主进程的对象。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPetDesktop', {
  /** 光标是否落在她身上；主进程据此开关鼠标穿透。 */
  setInteractive: (on) => ipcRenderer.send('pet:interactive', on === true),
  /** 弹右键菜单（她在身上被右键时调）。 */
  openMenu: () => ipcRenderer.send('pet:menu'),
  /** 打开 DSH 主窗口（聊天面板上的「在 DSH 中打开」）。 */
  openMainWindow: () => ipcRenderer.send('pet:open-main'),
  /** 环境信息。 */
  info: () => ipcRenderer.invoke('pet:info'),
  /** 独立窗口的上下文（是否独立、桥接端口、快捷键）。 */
  context: () => ipcRenderer.invoke('pet:context'),
  /** 主进程让她做的事。返回取消订阅的函数。 */
  onCommand: (fn) => {
    const listener = (_event, payload) => { try { fn(payload); } catch (error) { /* 页面自己的问题 */ } };
    ipcRenderer.on('pet:command', listener);
    return () => { try { ipcRenderer.removeListener('pet:command', listener); } catch (error) { /* 忽略 */ } };
  },
  /** 这是独立窗口（页面据此显示「切回 DSH」之类的入口）。 */
  standalone: true,
});
