// dsh-coopanion-pet —— Coopanion 桌宠插件（宿主半边，零侵入）。
//
// 只做一件事：把包内 assets 目录以只读静态路由提供给浏览器
// （kit/ 渲染内核、whale/ 形象与纹理 PNG），供 client.js 在页面里加载桌宠。
// 不修改任何内置包文件，不读业务 DOM，无外部请求。
//
// 路由用 prefix 而非 exact+query，是刻意的：形象包内部有相对路径导入
// （kit/body.js 里的 './rig.js'、whale/figure.js 里的 '../kit/rig.js'、
// 以及纹理 'tex/xxx.png'），只有路径形式的 URL 才能让浏览器按相对关系解析成功。
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-coopanion-pet';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, 'assets');

/** 路由前缀；client.js 里的 BASE 必须与此保持一致（含结尾斜杠）。 */
export const ROUTE = '/api/dsh-coopanion-pet/assets';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** 把请求路径解析为 assets 目录内的安全路径；越界返回 null。 */
function safeResolve(rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + path.sep)) return null;
  return target;
}

export async function apply(ctx) {
  // 必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建。
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          // 路由前缀之后的部分就是 assets 内的相对路径
          const rel = decodeURIComponent(url.pathname.slice(ROUTE.length)).replace(/^\/+/, '');
          const file = safeResolve(rel);
          if (file === null || rel === '' || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'public, max-age=3600',
          });
          createReadStream(file).pipe(res);
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => dispose, 'dsh-coopanion-pet: 静态资源路由');
  });

  ctx.logger?.info?.(`dsh-coopanion-pet: 已挂载（资源路由 ${ROUTE}/）`);
}
