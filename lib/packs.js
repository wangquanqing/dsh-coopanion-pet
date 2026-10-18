/**
 * 41：形象包系统（宿主侧）。
 *
 * **上游的设计**（`src/packs.ts`）：一个形象包是一个带 `figure.json` 清单的目录；
 * 包的代码只在**沙箱 frame** 里跑（opaque origin，只能 `postMessage` 通信）。
 * 清单里放的是「不跑代码就能知道的东西」：名字、装扮轴与预设、词表、音效、会不会走。
 *
 * **本插件的实现**：
 * - 宿主侧扫目录、读清单、把包的文件挂在资源路由下；
 * - 客户端侧用沙箱 iframe 跑包代码（见 assets/figure-frame.js）；
 * - 沙箱形态已实测可行：opaque origin 里 `new Image()` 能加载纹理（图片不受 CORS 限制），
 *   `fetch` 需要 CORS 头——已给资源路由放开（见 docs/risk-verification.md）。
 *
 * **安全边界**（照搬上游的立场）：包代码不可信，因此
 * - 沙箱**不给 `allow-same-origin`**（否则沙箱形同虚设，浏览器自己都会警告）；
 * - 包拿不到主页面任何东西，只能 postMessage；
 * - 宿主侧只读清单、只提供文件，**不执行包的任何代码**。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** 清单文件名，与上游一致。 */
export const MANIFEST_FILE = 'figure.json';
/** 本插件读的清单版本（与上游当前版本一致）。 */
export const MANIFEST_VERSION = 2;
/** 形象包 id 的合法形式。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 图片扩展名（浏览器都能解码）。 */
const IMAGE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg']);
/** 音频扩展名。 */
const AUDIO_EXT = new Set(['.ogg', '.mp3', '.wav']);
/** 一个包最多多大（防止有人塞个几百 MB 的目录）。 */
const MAX_PACK_BYTES = 64 * 1024 * 1024;

/**
 * 一个形象包的清单（只取本插件用得到的字段，未知字段原样保留）。
 *
 * @returns 清单对象；读不出来或不合规时返回 `null`。
 */
function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) return null;
  // 入口与导出名必须存在，否则沙箱里没法调它
  const entry = String(raw.entry ?? '');
  const exportName = String(raw.export ?? '');
  if (!entry || !exportName) return null;
  // 清单版本：只读认识的（更高的版本按不认识处理，如实回报）
  const manifest = Number(raw.manifest ?? 0);
  if (manifest !== MANIFEST_VERSION) return null;
  return {
    id,
    version: String(raw.version ?? ''),
    name: raw.name && typeof raw.name === 'object' ? raw.name : { zh: id, en: id },
    about: raw.about && typeof raw.about === 'object' ? raw.about : {},
    author: typeof raw.author === 'string' ? raw.author : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    entry,
    export: exportName,
    axes: Array.isArray(raw.axes) ? raw.axes : [],
    presets: Array.isArray(raw.presets) ? raw.presets : [],
    vocab: Array.isArray(raw.vocab) ? raw.vocab : [],
    sounds: raw.sounds && typeof raw.sounds === 'object' ? raw.sounds : {},
    can: raw.can && typeof raw.can === 'object' ? raw.can : {},
  };
}

/**
 * 扫一个根目录下的形象包（每个子目录一个包）。
 *
 * @param rootDir - 要扫的目录。不存在时返回空。
 * @returns `{ packs, problems }`：读成功的与读失败的原因。
 */
export function scanPacks(rootDir) {
  const packs = [];
  const problems = [];
  if (!rootDir || !existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    return { packs, problems };
  }
  let names;
  try {
    names = readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    return { packs, problems: [{ dir: rootDir, reason: String(error?.message ?? error) }] };
  }
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const dir = path.join(rootDir, d.name);
    const manifest = readManifest(dir);
    if (!manifest) {
      // 有 figure.json 但读不出来 = 有问题；没有 figure.json = 不是包，不报
      if (existsSync(path.join(dir, MANIFEST_FILE))) {
        problems.push({ dir, reason: '清单读不出来或不合规（id/entry/export/manifest 版本）' });
      }
      continue;
    }
    // 体积上限：算一下目录总大小
    let bytes = 0;
    try {
      const walk = (p) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const full = path.join(p, e.name);
          if (e.isDirectory()) walk(full);
          else bytes += statSync(full).size;
        }
      };
      walk(dir);
    } catch (error) { /* 算不出来就不管 */ }
    if (bytes > MAX_PACK_BYTES) {
      problems.push({ dir, reason: `目录太大（${Math.round(bytes / 1048576)}MB，上限 ${MAX_PACK_BYTES / 1048576}MB）` });
      continue;
    }
    packs.push({ ...manifest, dir, bytes });
  }
  return { packs, problems };
}

/**
 * 把请求路径解析成某个包内的文件；越界或非法扩展名返回 `null`。
 *
 * **只允许图片与音频**：包代码是通过沙箱 frame 加载的，它的脚本走另一条路
 * （见 index.js 的路由），这里只放素材，免得任意文件被读出去。
 */
export function resolvePackFile(packDir, rel) {
  if (!packDir || typeof rel !== 'string' || !rel) return null;
  const target = path.normalize(path.join(packDir, rel));
  if (target !== packDir && !target.startsWith(packDir + path.sep)) return null;
  const ext = path.extname(target).toLowerCase();
  if (!IMAGE_EXT.has(ext) && !AUDIO_EXT.has(ext)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return target;
}
