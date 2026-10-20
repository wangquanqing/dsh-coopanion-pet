/**
 * 测试驱动：在预览页里执行指令队列里的动作。
 *
 * 它走**页内**而不是 CDP，因此不需要远程调试端口；
 * 指令由 test 服务器排队，驱动每 100ms 取一条。
 */

const post = (body) => fetch('/test/result', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).catch(() => {});

/** 报告页面自身状态，供断言用。 */
async function snapshot() {
  const bubble = document.querySelector('.cpn-b-ask, .cpn-bubble');
  const opts = [...document.querySelectorAll('.cpn-b-opt')].map((b) => b.textContent);
  const question = document.querySelector('.cpn-b-q')?.textContent ?? '';
  let prefs = null;
  try { prefs = JSON.parse(localStorage.getItem('dsh-coopanion-pet:prefs') ?? 'null'); } catch (e) { prefs = null; }
  return { opts, question: String(question).slice(0, 120), prefs, hasBubble: !!bubble };
}

async function tick() {
  let action = null;
  try {
    const res = await fetch('/test/poll');
    action = await res.json();
  } catch (e) { action = null; }
  if (!action) return;
  const { kind, index, selector, name } = action;
  try {
    if (kind === 'click') {
      const list = [...document.querySelectorAll(selector)];
      const el = list[index ?? 0];
      if (!el) throw new Error(`没有第 ${index} 个 ${selector}（共 ${list.length} 个）`);
      el.click();
      await post({ kind: 'clicked', name, index: index ?? 0, total: list.length });
    } else if (kind === 'snapshot') {
      await post({ kind: 'snapshot', name, data: await snapshot() });
    } else if (kind === 'eval') {
      // eslint-disable-next-line no-eval
      const value = await (0, eval)(action.code);
      await post({ kind: 'eval', name, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
    } else if (kind === 'ready') {
      await post({ kind: 'ready', name });
    }
  } catch (error) {
    await post({ kind: 'error', name, message: String(error?.message ?? error) });
  }
}

setInterval(tick, 100);
await post({ kind: 'driver-up' });
