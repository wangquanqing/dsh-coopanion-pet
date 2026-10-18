/**
 * 桌面宠物的设置面板（客户端半边）。
 *
 * 注册到 DSH 设置页的 `settings.section` 槽位，把桌宠的偏好放在那里。
 *
 * 与右键菜单共用同一份偏好：`localStorage` 的 `dsh-coopanion-pet:prefs`。
 * 面板改完立刻生效——桌宠每帧读偏好，不必重载页面。
 *
 * 面板不依赖 DSH 的 locale / theme 服务（实测客户端插件的 apply 运行时
 * 拿不到它们），文案走本插件的 i18n.js，配色用 CSS 变量跟随宿主主题。
 *
 * 改「语言」或「显示桌宠」会重挂桌宠（见 client.js 的 readMountKey）。
 */

import { t, LANGS } from './i18n.js';

/** 语言选项：自动 + 各语言的自身名（语言名不跟着界面语言变）。 */
const LANG_NAMES = { zh: '中文', en: 'English', de: 'Deutsch', 'es-419': 'Español (LatAm)',
  fr: 'Français', it: 'Italiano', ja: '日本語', ko: '한국어', 'pt-BR': 'Português (BR)',
  ru: 'Русский', 'zh-Hant': '繁體中文' };
const LANG_OPTIONS = ['auto', ...LANGS];
/** 语言选项的显示名。每次渲染时取，免得改完语言后面板还挂着旧标签。 */
const langLabels = () => LANG_OPTIONS.map((id) => (id === 'auto' ? t('lang.auto') : LANG_NAMES[id] ?? id));

/** CUA 审批档位（与宿主侧 lib/cua-policy.js 的四级一致）。 */
const CUA_LEVELS = ['ask-each-turn', 'ask-before-acting', 'ask-once', 'never-ask'];
const cuaLabels = () => CUA_LEVELS.map((lv) => t(`cua.${lv}`));

/** 61：主题三档。 */
const THEMES = ['auto', 'light', 'dark'];
/** 66：她自己能改什么（上游 selfAdjust 四级）。 */
const SELF_MODES = ['off', 'default', 'any', 'custom'];
/** 57：六类声音。 */
const SOUND_KINDS = ['move', 'touch', 'face', 'snore', 'talk', 'ui'];
/** 62：悬停按钮可选的动作（与 ui.js 的 BUTTONS 对应）。 */
const HOVER_IDS = ['say', 'face', 'act', 'walk', 'dress', 'sleep'];
/** 64：四种触摸。 */
const TOUCH_KINDS = ['poke', 'pet', 'throw', 'drop'];

/** 行容器的样式，几处共用。 */
const ROW = {
  alignItems: 'center',
  borderBottom: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
  display: 'flex',
  gap: '12px',
  justifyContent: 'space-between',
  padding: '10px 0',
};

/** 小字的样式（提示语）。 */
const HINT = { color: 'var(--dsw-alias-label-secondary, #6A6577)', fontSize: '12px' };

/**
 * 一段字节 → base64。
 *
 * **不能写成 `btoa(String.fromCharCode(...bytes))`**：展开成函数参数有上限
 * （约 6.5 万～12.5 万个），而形象包里一张纹理 PNG 动辄 200KB 以上，
 * 会抛 `RangeError: Maximum call stack size exceeded`，导入直接失败
 * （实测确认过的 bug）。分块转换，每块 0x8000 个字节。
 *
 * client.js 里的 `base64Of` 是同一份实现——两处都要用，因此各自留一份
 * （客户端模块之间不共享工具函数，它们各自独立加载）。
 */
function base64Chunked(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * 43 + 41：形象选择行（内置 + 第三方包）+ 导入入口。
 *
 * 形象列表要**问宿主**（`GET /dsh-coopanion-pet/packs`）——第三方包是装在
 * DSH home 下的，页面自己看不到。
 *
 * 导入走「选文件夹」那条路（`webkitdirectory`）：本插件**不引第三方 zip 库**，
 * 因此 zip 那条路没做，面板上如实说明并给出替代（解压后再选文件夹）。
 */
function FigureRow({ React: R, current, set }) {
  const h = R.createElement;
  const [state, setState] = R.useState({ loading: true, list: [], problems: [], zipSupported: true, busy: '', msg: '' });

  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch('/dsh-coopanion-pet/packs');
      const body = await res.json();
      setState((s) => ({
        ...s,
        loading: false,
        list: Array.isArray(body?.installed) ? body.installed : [],
        problems: Array.isArray(body?.problems) ? body.problems : [],
        zipSupported: body?.zipSupported !== false,
      }));
    } catch (error) {
      setState((s) => ({ ...s, loading: false, msg: String(error?.message ?? error) }));
    }
  };
  R.useEffect(() => { load(); }, []);

  /** 选文件夹 → 逐个读成 base64 → 发给宿主 stage。 */
  const onPick = async (event) => {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setState((s) => ({ ...s, busy: 'stage', msg: '' }));
    try {
      const payload = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        // 只发小文件（图片/脚本/清单），大的跳过并说明
        if (buf.byteLength > 8 * 1024 * 1024) continue;
        payload.push({ path: f.webkitRelativePath || f.name, base64: base64Chunked(new Uint8Array(buf)) });
      }
      const res = await fetch('/api/dsh-coopanion-pet/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stage', files: payload }),
      });
      const body = await res.json();
      if (!body?.ok) throw new Error(body?.message ?? '导入失败');
      setState((s) => ({ ...s, busy: 'install', msg: `找到 ${body.packs.length} 个包，正在安装…` }));
      const ins = await fetch('/api/dsh-coopanion-pet/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'install', token: body.token }),
      });
      const insBody = await ins.json();
      if (!insBody?.ok) throw new Error(insBody?.message ?? '安装失败');
      const n = insBody.installed?.length ?? 0;
      setState((s) => ({ ...s, busy: '', msg: n ? `装好了 ${n} 个形象` : '没有装成（可能 id 与内置冲突）' }));
      await load();
    } catch (error) {
      setState((s) => ({ ...s, busy: '', msg: String(error?.message ?? error) }));
    } finally {
      event.target.value = '';
    }
  };

  const ids = ['whale', 'coo', ...state.list.map((p) => p.id)];
  const labels = ['whale', 'coo'].map((id) => t(`figure.${id}`)).concat(
    state.list.map((p) => (p.name?.zh || p.name?.en || p.id)),
  );
  const at = Math.max(0, ids.indexOf(current.figure ?? 'whale'));

  return h('div', { style: { ...ROW, flexWrap: 'wrap' } }, [
    h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 150px' } }, [
      h('span', { key: 'n' }, t('settings.figure')),
      h('span', { key: 'h', style: HINT }, state.loading ? t('settings.figureLoading') : t('settings.figureHint')),
    ]),
    h('span', { key: 'g', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' } }, [
      ...ids.map((id, i) => h('button', {
        key: id, type: 'button',
        'aria-pressed': i === at,
        style: {
          background: i === at ? 'var(--dsw-static-accent, #4da3ff)' : 'transparent',
          border: `1px solid ${i === at ? 'transparent' : 'var(--dsw-alias-border-l2, #E2DFE8)'}`,
          borderRadius: '8px', color: i === at ? '#fff' : 'inherit', cursor: 'pointer',
          font: 'inherit', fontSize: '12.5px', padding: '4px 10px',
        },
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); set({ figure: id }); },
      }, labels[i])),
      // 导入：一个隐藏的文件夹选择器 + 触发它的按钮
      h('label', {
        key: 'imp',
        title: state.zipSupported ? t('settings.figureImportTitle') : t('settings.figureImportNoZip'),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          border: '1px dashed var(--dsw-alias-border-l2, #E2DFE8)', borderRadius: '8px',
          cursor: state.busy ? 'wait' : 'pointer', fontSize: '12.5px', padding: '4px 10px',
        },
      }, [
        state.busy ? t('settings.figureImporting') : t('settings.figureImport'),
        h('input', {
          key: 'i', type: 'file', multiple: true,
          // @ts-ignore - 非标准属性，但 Chromium 支持选文件夹
          webkitdirectory: 'true', directory: 'true',
          style: { display: 'none' },
          onChange: onPick,
        }),
      ]),
    ]),
    state.msg ? h('span', { key: 'm', style: { ...HINT, width: '100%', textAlign: 'right' } }, state.msg) : null,
    state.problems.length
      ? h('span', { key: 'p', style: { ...HINT, width: '100%', textAlign: 'right' } },
          `${state.problems.length} 个包没读出来：${state.problems.map((x) => x.reason).join('；')}`)
      : null,
  ]);
}

/**
 * 44：语音识别状态行。
 *
 * 显示「识别器可不可用、模型就绪没有」。**不自己管理模型下载**——
 * 模型由 DSH 的语音输入插件管（上游 `src/runtime/store.ts` 那套本插件没搬），
 * 这里只如实显示它报出来的状态。
 *
 * 做成独立子组件：它要用 `useState`（Hooks 只能在组件顶层）。
 */
function SpeechRow({ React: R }) {
  const h = R.createElement;
  const [state, setState] = R.useState({ loading: false, info: null, error: '' });
  const load = async () => {
    setState({ loading: true, info: null, error: '' });
    try {
      const res = await fetch('/api/dsh-coopanion-pet/speech', { method: 'GET' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { setState({ loading: false, info: null, error: t('settings.speechFailed') }); return; }
      setState({ loading: false, info: body, error: '' });
    } catch (error) {
      setState({ loading: false, info: null, error: String(error?.message ?? error) });
    }
  };
  const info = state.info;
  const summary = info
    ? (info.available
        ? (Array.isArray(info.providers) && info.providers.length
            ? info.providers.map((p) => `${p.label || p.id}${p.ready ? '（已就绪）' : ''}`).join('、')
            : t('settings.speechReady'))
        : t('settings.speechMissing'))
    : '';
  return h('div', { style: { ...ROW, flexWrap: 'wrap' } }, [
    h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 150px' } }, [
      h('span', { key: 'n' }, t('settings.speech')),
      h('span', { key: 'h', style: HINT }, t('settings.speechHint')),
    ]),
    h('span', { key: 'g', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' } }, [
      h('span', { key: 's', style: { ...HINT, maxWidth: '220px', textAlign: 'right' } }, state.loading ? t('settings.speechLoading') : (state.error || summary)),
      h('button', {
        key: 'b', type: 'button',
        style: {
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
          borderRadius: '8px', color: 'inherit', cursor: 'pointer', font: 'inherit',
          fontSize: '12.5px', padding: '4px 10px',
        },
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); load(); },
      }, t('settings.speechCheck')),
    ]),
  ]);
}

/**
 * 53：麦克风选择行。
 *
 * **做成独立子组件而不是面板里的一个函数**：它要用 `useState`，
 * 而 Hooks 只能在组件顶层调用——写在面板的渲染函数里会被当成条件调用。
 *
 * 设备列表要**问页面里的桌宠**（它有 `enumerateDevices` 与已选的设备）。
 * 如实说明一个浏览器限制：**没有授权之前拿不到设备名**，
 * 因此未录过音时只能显示「麦克风 1 / 2 / …」。
 */
function MicRow({ current, set, React: R }) {
  const h = R.createElement;
  const [state, setState] = R.useState({ loading: false, list: null, error: '' });
  const pet = typeof window !== 'undefined' ? window.__dshCoopanionPet : null;
  const load = async () => {
    setState({ loading: true, list: null, error: '' });
    try {
      const res = await pet?.listDevices?.();
      if (!res || !res.ok) {
        setState({ loading: false, list: [], error: t('settings.micUnavailable') });
        return;
      }
      setState({ loading: false, list: res.devices ?? [], error: '' });
    } catch (error) {
      setState({ loading: false, list: [], error: String(error?.message ?? error) });
    }
  };
  const chosen = current.micDevice ?? '';
  return h('div', { style: { ...ROW, flexWrap: 'wrap' } }, [
    h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 150px' } }, [
      h('span', { key: 'n' }, t('settings.mic')),
      h('span', { key: 'h', style: HINT }, t('settings.micHint')),
    ]),
    h('span', { key: 'g', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } }, [
      h('select', {
        key: 's',
        value: chosen,
        'aria-label': t('settings.mic'),
        style: {
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
          borderRadius: '8px', color: 'inherit', font: 'inherit', fontSize: '12.5px',
          padding: '4px 6px', maxWidth: '190px',
        },
        onChange: (event) => set({ micDevice: event.target.value }),
      }, [
        h('option', { key: 'd', value: '' }, t('settings.micDefault')),
        ...(state.list ?? []).map((d) => h('option', { key: d.deviceId, value: d.deviceId }, d.label)),
      ]),
      h('button', {
        key: 'b', type: 'button',
        style: {
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
          borderRadius: '8px', color: 'inherit', cursor: 'pointer', font: 'inherit',
          fontSize: '12.5px', padding: '4px 10px',
        },
        onClick: (event) => { event.preventDefault(); event.stopPropagation(); load(); },
      }, state.loading ? t('settings.micLoading') : t('settings.micScan')),
      state.error ? h('span', { key: 'e', style: HINT }, state.error) : null,
    ]),
  ]);
}

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
    /** CUA 档位与宿主不同步时的提示；空串 = 没问题。 */
    const [cuaError, setCuaError] = React.useState('');
    /**
     * 挂载时**从宿主读一次真实档位**：宿主才是政策层的持有者，
     * localStorage 里那份可能过时（例如宿主重启后回到默认值）。
     */
    React.useEffect(() => { refreshCua(); }, []);

    const set = (patch) => {
      prefs.write(patch);
      bump();
      /**
       * **立刻通知页面**，不等它下一次 32 帧节流的轮询。
       *
       * 帧循环每 32 帧拉一次偏好；静止档 12fps 时那是 2.7 秒，改完滑块
       * 要等两秒多才有反应（实测确认过的延迟）。这里直接调它的入口。
       */
      try { window.__dshCoopanionPet?.syncPrefs?.(); } catch (error) { /* 页面没开就算了 */ }
      /**
       * CUA 审批档位真正生效的是宿主侧的政策层（它挂在 tools/pre-execute 上），
       * 因此这里把新值报给宿主，而不是只写进 localStorage。
       *
       * **失败要说出来**：原来 `.catch(() => {})` 把失败吞掉，面板显示
       * 「每一轮」而宿主可能还是旧的更松档位。现在失败会回滚本地显示并提示。
       */
      if (typeof patch.cuaLevel === 'string') {
        setCuaError('');
        fetch('/api/dsh-coopanion-pet/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'cua-level', level: patch.cuaLevel }),
        }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
          .then(() => refreshCua())
          .catch((error) => {
            // 回滚：宿主没接受这个档位，面板就不该显示它
            prefs.write({ cuaLevel: prevCuaLevel });
            bump();
            setCuaError(`档位没能交给宿主（${String(error?.message ?? error)}），已回退。`);
          });
      }
    };

    /** 上一次从宿主读到的 CUA 档位，用来在写入失败时回滚。 */
    let prevCuaLevel = current.cuaLevel;

    /**
     * 从宿主读**真实生效**的 CUA 档位，覆盖本地那份。
     *
     * 宿主才是政策层的持有者；本地 localStorage 只是显示缓存。
     * 读不到时保留本地值，并提示一次。
     */
    async function refreshCua() {
      try {
        const res = await fetch('/api/dsh-coopanion-pet/report');
        const body = await res.json();
        if (body?.cua?.level) {
          prevCuaLevel = body.cua.level;
          if (current.cuaLevel !== body.cua.level) {
            prefs.write({ cuaLevel: body.cua.level });
            bump();
          }
          setCuaError('');
        }
      } catch (error) {
        setCuaError(`读不到宿主的档位（${String(error?.message ?? error)}），下面显示的是本地缓存。`);
      }
    }
    const on = (key) => current[key] !== false;

    /** 一行开关。 */
    const toggle = (key, label, hint) => {
      const value = on(key);
      return h('label', { key, style: ROW }, [
        h('span', { key: 't', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
          h('span', { key: 'l' }, label),
          hint ? h('span', { key: 'h', style: HINT }, hint) : null,
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

    /** 一行分段选择。`values` 是各档位存进偏好的值；不给时按 0..n-1 存。 */
    const choice = (key, label, options, values, hint) => {
      const list = values ?? options.map((_, i) => i);
      const at = list.indexOf(current[key]);
      return h('div', { key, style: ROW }, [
        h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
          h('span', { key: 'n' }, label),
          hint ? h('span', { key: 'h', style: HINT }, hint) : null,
        ]),
        h('span', { key: 'g', style: { display: 'flex', flex: 'none', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
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
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); set({ [key]: list[i] }); },
          }, name))),
      ]);
    };

    /** 一行滑块（数值项）。 */
    const slider = (key, label, min, max, step, hint) => {
      const value = Number.isFinite(current[key]) ? current[key] : (min + max) / 2;
      return h('div', { key, style: { ...ROW, flexWrap: 'wrap' } }, [
        h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 140px' } }, [
          h('span', { key: 'n' }, `${label} · ${value}`),
          hint ? h('span', { key: 'h', style: HINT }, hint) : null,
        ]),
        h('input', {
          key: 'i',
          type: 'range',
          min, max, step, value,
          'aria-label': label,
          style: { flex: '1 1 120px', accentColor: 'var(--dsw-static-accent, #4da3ff)' },
          onChange: (event) => set({ [key]: Number(event.target.value) }),
        }),
      ]);
    };

    /** 一行文本输入。 */
    const text = (key, label, hint, placeholder) => h('div', { key, style: ROW }, [
      h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
        h('span', { key: 'n' }, label),
        hint ? h('span', { key: 'h', style: HINT }, hint) : null,
      ]),
      h('input', {
        key: 'i',
        type: 'text',
        maxLength: 40,
        value: current[key] ?? '',
        placeholder: placeholder ?? '',
        'aria-label': label,
        style: {
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #E2DFE8)',
          borderRadius: '8px', color: 'inherit', font: 'inherit', fontSize: '12.5px',
          padding: '4px 8px', width: '150px',
        },
        onChange: (event) => set({ [key]: event.target.value }),
      }),
    ]);

    /** 一行多选（62 悬停按钮、57 声音分类）。 */
    const checks = (label, hint, ids, currentIds, onToggle) => h('div', {
      key: label, style: { ...ROW, flexWrap: 'wrap' },
    }, [
      h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 140px' } }, [
        h('span', { key: 'n' }, label),
        hint ? h('span', { key: 'h', style: HINT }, hint) : null,
      ]),
      h('span', { key: 'g', style: { display: 'flex', flex: '1 1 200px', flexWrap: 'wrap', gap: '4px', justifyContent: 'flex-end' } },
        ids.map((id) => {
          const on = currentIds.includes(id);
          return h('button', {
            key: id,
            type: 'button',
            'aria-pressed': on,
            style: {
              background: on ? 'var(--dsw-static-accent, #4da3ff)' : 'transparent',
              border: `1px solid ${on ? 'transparent' : 'var(--dsw-alias-border-l2, #E2DFE8)'}`,
              borderRadius: '8px',
              color: on ? '#fff' : 'inherit',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '12.5px',
              padding: '4px 10px',
            },
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); onToggle(id, on); },
          }, t(`hover.${id}`));
        })),
    ]);

    const sounds = current.sounds ?? {};
    const hover = Array.isArray(current.hoverButtons) ? current.hoverButtons : HOVER_IDS;
    const wake = Array.isArray(current.wakeKinds) ? current.wakeKinds : ['poke'];

    return h('div', {
      style: { display: 'flex', flexDirection: 'column', width: '100%', fontSize: '13.5px' },
    }, [
      h('p', { key: 'intro', style: { ...HINT, fontSize: '12.5px', margin: '0 0 4px' } }, t('settings.intro')),

      // ---- 显示 ----
      toggle('enabled', t('settings.enabled'), t('settings.enabledHint')),
      toggle('statusBubble', t('settings.statusBubble'), t('settings.statusBubbleHint')),
      toggle('trail', t('settings.trail'), t('settings.trailHint')),
      toggle('doubleClickChat', t('settings.doubleClickChat'), t('settings.doubleClickChatHint')),
      toggle('linesBubble', t('settings.linesBubble'), t('settings.linesBubbleHint')),

      // ---- 形象（43 + 41：内置 + 第三方包） ----
      h(FigureRow, { key: 'figure', React, current, set }),

      // ---- 外观 ----
      slider('scale', t('settings.scale'), 0.5, 10, 0.1, t('settings.scaleHint')),
      slider('bubbleSize', t('settings.bubbleSize'), 0.8, 1.6, 0.05, t('settings.bubbleSizeHint')),
      slider('fontSize', t('settings.fontSize'), 0.8, 1.6, 0.05, t('settings.fontSizeHint')),
      slider('glow', t('settings.glow'), 0, 16, 1, t('settings.glowHint')),
      choice('theme', t('settings.theme'), THEMES.map((m) => t(`theme.${m}`)), THEMES),
      text('user', t('settings.user'), t('settings.userHint'), t('settings.userPlaceholder')),

      // ---- 行为 ----
      choice('roamIndex', t('settings.roam'), [0, 1, 2].map((i) => t(`roam.${i}`))),
      choice('fpsIndex', t('settings.fps'), [0, 1, 2].map((i) => t(`fps.${i}`)), undefined, t('settings.fpsHint')),
      choice('touchWake', t('settings.touchWake'), ['poke', 'all', 'none', 'custom'].map((m) => t(`wake.${m}`)),
        ['poke', 'all', 'none', 'custom'], t('settings.touchWakeHint')),
      current.touchWake === 'custom'
        ? checks(t('settings.wakeKinds'), null, TOUCH_KINDS, wake,
            (id, on) => set({ wakeKinds: on ? wake.filter((k) => k !== id) : [...wake, id] }))
        : null,
      checks(t('settings.hoverButtons'), t('settings.hoverButtonsHint'), HOVER_IDS, hover,
        (id, on) => {
          const next = on ? hover.filter((k) => k !== id) : [...hover, id];
          // 最多 6 个；一个都不留会让她没法被点，因此至少留 1 个
          if (next.length && next.length <= 6) set({ hoverButtons: next });
        }),

      // ---- 声音 ----
      toggle('sound', t('settings.sound'), t('settings.soundHint')),
      h(MicRow, { key: 'mic', React, current, set }),
      h(SpeechRow, { key: 'speech', React }),
      checks(t('settings.sounds'), t('settings.soundsHint'), SOUND_KINDS, SOUND_KINDS.filter((k) => sounds[k] !== false),
        (id, on) => set({ sounds: { ...sounds, [id]: !on } })),
      slider('snoreSeconds', t('settings.snoreSeconds'), 0, 60, 1, t('settings.snoreSecondsHint')),

      // ---- 她自己能改什么（66） ----
      choice('selfAdjust', t('settings.selfAdjust'), SELF_MODES.map((m) => t(`self.${m}`)), SELF_MODES,
        t('settings.selfAdjustHint')),

      // ---- 电脑操作审批 ----
      choice('cuaLevel', t('settings.cua'), cuaLabels(), CUA_LEVELS, t('settings.cuaHint')),
      // 与宿主不同步时如实说，而不是让面板显示一个并不生效的档位
      cuaError ? h('div', { key: 'cuaErr', style: { ...HINT, color: 'var(--dsw-alias-text-warning, #B8860B)', width: '100%', textAlign: 'right' } }, cuaError) : null,

      // ---- 界面 ----
      choice('lang', t('settings.lang'), langLabels(), LANG_OPTIONS, t('settings.langHint')),
    ]);
  };
}
