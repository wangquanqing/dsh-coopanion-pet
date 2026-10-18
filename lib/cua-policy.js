/**
 * CUA 权限政策层：让桌宠当 CUA 的**审批人**。
 *
 * 设计来源是 Coopanion 的 `src/cua/config.ts` 与 `cua.ts` 的 `permit()`——
 * 那套四级权限 + 让位空闲检测是通用的，浏览器里也能用（只有「有没有空闲」
 * 要靠原生 `GetLastInputInfo`，浏览器只能近似）。
 *
 * **本插件不实现 CUA 本身。** Windows 上的电脑操作由
 * [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)
 * 经官方 MCP 桥接提供（工具名 `mcp__wincu__*`）。本插件做的是它缺的那一环：
 * 当它要动用户的电脑时，**由桌宠当面问一句**，而不是把审批交给一个看不见的对话框。
 *
 * 四级权限（从最严到最松，与上游同名同义）：
 *
 * - `ask-each-turn`：每一轮、在第一次看屏幕或第一次输入之前都问；
 * - `ask-before-acting`：看屏幕（截图/窗口列表/查询）不问，**输入之前**每轮问一次；
 * - `ask-once`：看屏幕不问；输入之前问一次，答「可以」后 `grantMinutes` 内不再问；
 * - `never-ask`：从不问。
 *
 * 三条硬边界：
 * - **失败即拒绝。** 没有页面、超时、用户没答——一律按「不许」处理（fail closed），
 *   不是「默认允许」。
 * - **一次授权只算一次。** `ask-once` 的授权有有效期，到期重新问；
 *   `allowed-once` 的语义本来也只对当前这次调用有效。
 * - **她不在就不拦路。** 没有页面时不去抢审批（返回 `unavailable`），
 *   让 DSH 自己的审批通道处理，免得把用户的 CUA 卡死。
 */

/** 四级权限，从最严到最松。 */
export const PERMISSION_LEVELS = ['ask-each-turn', 'ask-before-acting', 'ask-once', 'never-ask'];

export const DEFAULT_POLICY = {
  level: 'ask-once',
  grantMinutes: 30,
};

/**
 * 一个 CUA 工具是「看」还是「动」。
 *
 * 判据取自 dsh-computer-use-win 的工具表：读类的都归 `see`（不问或只在最严档问），
 * 其余一律归 `act`（改状态，按档位问）。**默认归 `act`**——不认识的名字当作要动手，
 * 宁可多问一句，也不要漏问。
 */
const SEE_TOOLS = [
  'health', 'snapshot', 'accessibility_tree', 'list_windows', 'find',
  'element_info', 'screenshot', 'ocr', 'wait', 'wait_for',
];

/** 一个工具名（`mcp__wincu__find`）是看还是动。 */
export function classifyCuaTool(name) {
  const bare = String(name ?? '').split('__').pop() ?? '';
  return SEE_TOOLS.includes(bare) ? 'see' : 'act';
}

/** 只有 wincu 命名空间下的工具才归本闸门管。 */
export const CUA_TOOL_PATTERN = /^mcp__wincu__/;

/**
 * 把闸门判定做成一个**可以单独测的纯函数**。
 *
 * 为什么不直接写在 index.js 的 `ctx.on('tools/pre-execute', ...)` 里：
 * 那段代码要跑起来得先有 webserver、tools、channel 一整套服务，没法单独验证。
 * 判定逻辑抽出来之后，喂一个假 `next` 就能把每种情况钉死——
 * 而这段逻辑正是最不能出错的地方（它决定模型能不能动用户的电脑）。
 *
 * @param exec - 工具调用（只读 `name`）。
 * @param next - 放行回调。
 * @param deps - `{ policy, isOnline }`。`isOnline()` 表示桌宠页面在不在。
 * @returns 放行时返回 `next()` 的结果；拦下时返回 `{ kind: 'deny', reason }`。
 */
export async function cuaGate(exec, next, deps) {
  const { policy, isOnline } = deps;
  const toolName = typeof exec?.name === 'string' ? exec.name : '';
  // 只管 wincu 的命名空间；其余工具一律原样放行，本插件不做通用审批
  if (!CUA_TOOL_PATTERN.test(toolName)) return next();
  // 她不在时不抢审批：交给 DSH 自己的通道，免得把用户的 CUA 卡死
  if (!isOnline()) return next();
  try {
    const verdict = await policy.permit(toolName);
    if (verdict !== true) return { kind: 'deny', reason: verdict };
  } catch (error) {
    // 政策层自己出错时按「不许」处理（fail closed）
    return { kind: 'deny', reason: '桌宠的权限判定出错，按「不可以」处理。' };
  }
  return next();
}

/**
 * 建一个权限政策层。
 *
 * `deps`：`{ ask(question, choices) → Promise<'yes'|'no'|'timeout'> }`。
 *   `ask` 负责把问题显示给用户并等回答；**她不在或等不到时必须返回 timeout**，
 *   不能返回 'yes'。
 */
export function createCuaPolicy(deps) {
  const { ask } = deps;

  /** 本轮已经问过的答案（上游语义：一次问，管一轮）。 */
  let turnAnswer = null;
  /** ask-once：这个时间戳之前不再问（毫秒）。 */
  let grantedUntil = 0;
  /** 当前档位与授权时长，由偏好或 pet_cua 工具改。 */
  let level = DEFAULT_POLICY.level;
  let grantMinutes = DEFAULT_POLICY.grantMinutes;

  /** 一轮结束：清掉本轮的答案。ask-once 的授权不受影响（它有独立的到期时间）。 */
  function endTurn() {
    turnAnswer = null;
  }

  /**
   * 一个 CUA 调用该不该放行。
   *
   * @param toolName - 模型调用的工具名，如 `mcp__wincu__click`。
   * @returns `true` 放行；否则返回一句人话原因（给模型看）。
   */
  async function permit(toolName) {
    const kind = classifyCuaTool(toolName);
    if (level === 'never-ask') return true;
    // 看屏幕：除最严档外都不问
    if (kind === 'see' && level !== 'ask-each-turn') return true;
    // ask-once 且还在授权期内
    if (level === 'ask-once' && Date.now() < grantedUntil) return true;
    // 本轮已经问过了
    if (turnAnswer === 'yes') return true;
    if (turnAnswer === 'no') return denyReason(level, false);

    const answer = await ask(questionFor(level), ['可以', '不要']);
    if (answer === 'yes') {
      if (level === 'ask-once') {
        grantedUntil = Date.now() + grantMinutes * 60_000;
        turnAnswer = null;
      } else {
        turnAnswer = 'yes';
      }
      return true;
    }
    if (answer === 'timeout') return denyReason(level, true);
    turnAnswer = 'no';
    return denyReason(level, false);
  }

  function questionFor(lv) {
    if (lv === 'ask-each-turn') return '我这就要看你的屏幕了，可以吗？';
    if (lv === 'ask-once') return `我这就要动你的电脑了，可以吗？答应后 ${grantMinutes} 分钟内不再问。`;
    return '我这就要动你的电脑（点鼠标、敲键盘），可以吗？';
  }

  function denyReason(lv, timedOut) {
    if (timedOut) return '用户没有在时限内回答，按「不可以」处理。不要重复追问。';
    return lv === 'ask-each-turn'
      ? '用户这一轮没有允许桌宠看屏幕。不要重试，先问清楚再动。'
      : '用户没有允许桌宠操作电脑。不要重试，先问清楚再动。';
  }

  return {
    permit,
    endTurn,
    /** 当前档位与授权状态，供设置面板与 pet_cua 查询。 */
    get state() {
      return {
        level,
        grantMinutes,
        granted: Date.now() < grantedUntil,
        grantedUntil,
      };
    },
    /** 改档位。返回是否接受（非法档位不改）。 */
    setLevel(next) {
      if (!PERMISSION_LEVELS.includes(next)) return false;
      level = next;
      turnAnswer = null;
      if (next !== 'ask-once') grantedUntil = 0;
      return true;
    },
    setGrantMinutes(next) {
      const n = Number(next);
      if (!Number.isFinite(n) || n < 1 || n > 1440) return false;
      grantMinutes = Math.round(n);
      return true;
    },
    /** 撤销当前授权（用户改主意时用）。 */
    revoke() {
      grantedUntil = 0;
      turnAnswer = null;
    },
  };
}
