/**
 * 42：形象包导入（宿主侧）。
 *
 * **上游的设计**（`src/pack-import.ts`）：装扮页把 zip 或「文件夹里读到的文件」
 * 发到 `POST /api/figures/import`，宿主解包到暂存目录、逐个读成「已安装的包」那样，
 * 让人挑要装哪个；再 `POST .../import/install` 真正拷进去。
 *
 * 一个包是「带 `figure.json` 的目录」，**最多在所选位置下 `PACK_DEPTH` 层**找到
 * （zip 来自 GitHub 时会多套一层 `<repo>-<branch>/`，仓库也可能把包放在自己的子目录里）。
 * 找到包之后**不再往里找**。
 *
 * **本插件的实现**：不引第三方 zip 库（本插件零运行时依赖），因此
 * - **只支持「文件夹」那条路**：页面用 `webkitdirectory` 选一个文件夹，
 *   把文件列表发过来，宿主按路径写进暂存目录；
 * - zip 那条路**如实说明不支持**，并给出替代（解压后再用文件夹导入）。
 *
 * 这样做的理由：解压 zip 需要实现或引入 inflate（约 200 行 + 边界情况），
 * 而「解压后再选文件夹」对用户只多一步，却省掉一整个依赖。
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, MANIFEST_VERSION } from './packs.js';

/** 一个包最多在所选位置下几层。与上游一致。 */
export const PACK_DEPTH = 3;
/** 一次导入最多多少字节。 */
export const IMPORT_MAX = 128 * 1024 * 1024;
/** 一个包的 id 合法形式。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 写文件时要拒掉的路径特征（绝对路径、上跳、盘符）。 */
const UNSAFE = /(^[\/\\])|(^[a-zA-Z]:)|(\.\.)/;

/**
 * 从一份「文件清单」里挑出形象包。
 *
 * @param files - `[{ path, data }]`；`path` 是相对路径（含文件夹名），`data` 是 Buffer。
 * @returns `{ packs, dirs, problems }`：找到的包、它们各自的根路径、读不了的原因。
 */
export function pickPacks(files) {
  const packs = [];
  const problems = [];
  const seen = new Set();

  for (const f of files) {
    const p = String(f?.path ?? '').replace(/\\/g, '/');
    if (!p) continue;
    // 只关心清单文件本身
    if (!p.endsWith('/' + MANIFEST_FILE) && p !== MANIFEST_FILE) continue;
    const dir = p === MANIFEST_FILE ? '' : p.slice(0, -(MANIFEST_FILE.length + 1));
    // 层数：包本身所在目录相对所选根有几层
    const depth = dir === '' ? 0 : dir.split('/').length;
    if (depth > PACK_DEPTH) {
      problems.push({ path: p, reason: `层数超过 ${PACK_DEPTH}` });
      continue;
    }
    if (seen.has(dir)) continue;
    seen.add(dir);

    let manifest;
    try {
      manifest = JSON.parse(String(f.data ?? ''));
    } catch (error) {
      problems.push({ path: p, reason: '清单不是合法 JSON' });
      continue;
    }
    if (!manifest || typeof manifest !== 'object') {
      problems.push({ path: p, reason: '清单不是对象' });
      continue;
    }
    if (Number(manifest.manifest ?? 0) !== MANIFEST_VERSION) {
      problems.push({ path: p, reason: `清单版本 ${manifest.manifest} 与本插件（${MANIFEST_VERSION}）不符` });
      continue;
    }
    if (!ID_RE.test(String(manifest.id ?? ''))) {
      problems.push({ path: p, reason: 'id 不合法（小写字母数字与连字符，最长 32）' });
      continue;
    }
    if (!manifest.entry || !manifest.export) {
      problems.push({ path: p, reason: '缺 entry 或 export' });
      continue;
    }
    packs.push({
      dir,
      id: String(manifest.id),
      version: String(manifest.version ?? ''),
      name: manifest.name && typeof manifest.name === 'object' ? manifest.name : { zh: manifest.id, en: manifest.id },
      author: typeof manifest.author === 'string' ? manifest.author : '',
    });
  }
  // 找到包之后不再往里找：把嵌套在别的包里的丢掉
  const roots = packs.map((p) => p.dir);
  const top = packs.filter((p) => !roots.some((r) => r !== p.dir && r !== '' && p.dir.startsWith(r + '/')));
  return { packs: top, problems };
}

/**
 * 建一个导入器。
 *
 * @param opts - `{ packDir, builtins }`：包安装目录、内置包 id（不许覆盖）。
 */
export function createImporter(opts) {
  const { packDir, builtins = [] } = opts;

  /** 一次暂存：`{ id, staging, packs }`。同一时刻只允许一次。 */
  let pending = null;

  return {
    /** 现在有没有未完成的导入。 */
    get pending() { return pending ? { token: pending.id, packs: pending.packs } : null; },

    /**
     * 收一份文件清单，解到暂存目录并挑出包。
     *
     * @param files - `[{ path, data }]`。
     * @returns `{ token, packs, problems }`；失败时抛错。
     */
    async stage(files) {
      if (pending) throw new Error('上一次导入还没结束，请先安装或取消');
      let total = 0;
      for (const f of files) total += (f?.data?.length ?? 0);
      if (total > IMPORT_MAX) throw new Error(`文件太大（${Math.round(total / 1048576)}MB，上限 ${IMPORT_MAX / 1048576}MB）`);

      const staging = await mkdtemp(path.join(packDir, '.import-'));
      try {
        // 1. 写进暂存目录（拒掉不安全的路径）
        for (const f of files) {
          const rel = String(f?.path ?? '').replace(/\\/g, '/');
          if (!rel || UNSAFE.test(rel)) throw new Error(`不安全的路径：${rel}`);
          const target = path.join(staging, rel);
          if (!target.startsWith(staging + path.sep)) throw new Error(`路径越界：${rel}`);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, f.data);
        }
        // 2. 挑出包
        const picked = pickPacks(files.map((f) => ({ path: String(f?.path ?? '').replace(/\\/g, '/'), data: f.data })));
        if (!picked.packs.length) {
          await rm(staging, { recursive: true, force: true });
          throw new Error(picked.problems.length
            ? `没有找到可用的形象包：${picked.problems.map((p) => p.reason).join('；')}`
            : '没有找到形象包（一个包是带 figure.json 的目录）');
        }
        const id = `imp${Date.now().toString(36)}`;
        pending = { id, staging, packs: picked.packs };
        return { token: id, packs: picked.packs, problems: picked.problems };
      } catch (error) {
        try { await rm(staging, { recursive: true, force: true }); } catch (e) { /* 删不掉就算了 */ }
        throw error;
      }
    },

    /**
     * 把选中的包装进去。
     *
     * @param token - `stage` 给的令牌。
     * @param ids - 要装哪些（`pack.id`）。空数组表示全部。
     * @returns `{ installed, refused }`。
     */
    async install(token, ids) {
      if (!pending || pending.id !== token) throw new Error('没有这个导入（可能已过期）');
      const want = Array.isArray(ids) && ids.length ? pending.packs.filter((p) => ids.includes(p.id)) : pending.packs;
      const installed = [];
      const refused = [];
      for (const p of want) {
        // 内置 id 不许覆盖（与上游一致）
        if (builtins.includes(p.id)) { refused.push({ id: p.id, reason: '是内置形象，不能覆盖' }); continue; }
        const src = path.join(pending.staging, p.dir);
        const dst = path.join(packDir, p.id);
        try {
          if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
          await cp(src, dst, { recursive: true });
          installed.push({ id: p.id, name: p.name });
        } catch (error) {
          refused.push({ id: p.id, reason: String(error?.message ?? error) });
        }
      }
      await rm(pending.staging, { recursive: true, force: true });
      pending = null;
      return { installed, refused };
    },

    /** 放弃这次导入，清掉暂存。 */
    async cancel() {
      if (!pending) return;
      const s = pending.staging;
      pending = null;
      try { await rm(s, { recursive: true, force: true }); } catch (error) { /* 删不掉就算了 */ }
    },
  };
}
