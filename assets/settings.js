/**
 * 桌面宠物的设置面板（客户端半边）。
 *
 * 注册到 DSH 设置页的 `settings.section` 槽位，把桌宠的偏好放在那里，
 * 而不是只靠右键菜单。
 *
 * 与右键菜单共用同一份偏好：`localStorage` 的 `dsh-coopanion-pet:prefs`。
 * 面板改完立刻生效——桌宠每帧读偏好，不必重载页面。
 *
 * 面板不依赖 DSH 的 locale / theme 服务（实测客户端插件的 apply 运行时
 * 拿不到它们），文案直接内联，配色用 CSS 变量跟随宿主主题。
 */

/** 体型与漫游的显示名。 */
const SIZE_LABELS = ['小', '中', '大'];
const ROAM_LABELS = ['安静', '随意', '活跃'];

/** 行容器的样式，几处共用。 */
const ROW = {
  alignItems: 'center',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
  display: 'flex',
  gap: '12px',
  justifyContent: 'space-between',
  padding: '10px 0',
};

/**
 * 建设置面板的 React 组件。
 *
 * `React` 由调用方传入（客户端模块表里就有，不必打包）。
 * `prefs` 是偏好读写：`{ read(), write(patch) }`；`write` 要落盘。
 */
export function createSettingsSection(React, prefs) {
  const h = React.createElement;

  return function PetSettingsSection() {
    // 偏好存在 localStorage 里，不是 React 状态；改完用 tick 强制重画。
    const [tick, bump] = React.useReducer((n) => n + 1, 0);
    const current = React.useMemo(() => prefs.read(), [tick]);

    const set = (patch) => { prefs.write(patch); bump(); };
    const on = (key) => current[key] !== false;

    /** 一行开关。 */
    const toggle = (key, label, hint) => {
      const value = on(key);
      return h('label', { key, style: ROW }, [
        h('span', { key: 't', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
          h('span', { key: 'l' }, label),
          hint ? h('span', {
            key: 'h',
            style: { color: 'var(--dsw-alias-label-secondary, #6A6577)', fontSize: '12px' },
          }, hint) : null,
        ]),
        h('button', {
          key: 'b',
          type: 'button',
          role: 'switch',
          'aria-checked': value,
          'aria-label': label,
          style: {
            alignItems: 'center',
            background: value ? 'var(--dsw-static-accent, #4da3ff)' : 'var(--dsw-alias-border-l3, #c9cdd6)',
            border: 'none',
            borderRadius: '999px',
            cursor: 'pointer',
            display: 'flex',
            flex: 'none',
            height: '24px',
            justifyContent: value ? 'flex-end' : 'flex-start',
            padding: '3px',
            transition: 'background 160ms ease',
            width: '44px',
          },
          onClick: (event) => { event.preventDefault(); event.stopPropagation(); set({ [key]: !value }); },
        }, h('span', {
          key: 'k',
          style: {
            background: '#fff',
            borderRadius: '50%',
            boxShadow: '0 1px 3px rgb(0 0 0 / 25%)',
            height: '18px',
            width: '18px',
          },
        })),
      ]);
    };

    /** 一行分段选择。 */
    const choice = (key, label, options) => {
      const at = Number(current[key] ?? 0);
      return h('div', { key, style: ROW }, [
        h('span', { key: 'l' }, label),
        h('span', { key: 'g', style: { display: 'flex', flex: 'none', gap: '4px' } },
          options.map((name, i) => h('button', {
            key: name,
            type: 'button',
            'aria-pressed': i === at,
            style: {
              background: i === at ? 'var(--dsw-static-accent, #4da3ff)' : 'transparent',
              border: `1px solid ${i === at ? 'transparent' : 'var(--dsw-alias-border-l2, #E2DFE8)'}`,
              borderRadius: '8px',
              color: i === at ? '#fff' : 'inherit',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '12.5px',
              padding: '4px 10px',
            },
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); set({ [key]: i }); },
          }, name))),
      ]);
    };

    return h('div', {
      style: { display: 'flex', flexDirection: 'column', width: '100%', fontSize: '13.5px' },
    }, [
      h('p', {
        key: 'intro',
        style: { color: 'var(--dsw-alias-label-secondary, #6A6577)', fontSize: '12.5px', margin: '0 0 4px' },
      }, '一只住在界面下沿的桌宠。形象与动画来自 Coopanion。'),
      toggle('enabled', '显示桌宠', '关掉后页面里不再出现她'),
      toggle('statusBubble', '状态气泡', '她头顶显示「正在看文件」「正在跑命令」'),
      toggle('sound', '音效', '全部为合成音，不含音频素材'),
      choice('sizeIndex', '体型', SIZE_LABELS),
      choice('roamIndex', '漫游', ROAM_LABELS),
    ]);
  };
}
