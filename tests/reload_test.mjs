#!/usr/bin/env node
/* reload_test.mjs —— 验证「每次刷新都自动加载数据源」与「操作记录刷新后仍在」
 *
 *   npm install jsdom
 *   node tests/reload_test.mjs
 *
 * 思路：同一个浏览器域连续「打开页面」三次（三个 JSDOM 共享 localStorage 快照）：
 *   ① 首次打开 → 自动拉库、查一条 → 记录写入 localStorage
 *   ② 再刷新   → **不点任何按钮**也必须自动重新拉库，且操作记录 / 最近查询都还在
 *   ③ 断网刷新 → 回退到本地缓存，仍能显示记录数，不白屏
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.PWDASH_ROOT
  ? path.resolve(process.env.PWDASH_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { JSDOM, VirtualConsole } = await import('jsdom');

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    pass++;
    console.log(`\x1b[1;32m  ✓ ${name}\x1b[0m`);
  } else {
    fail++;
    console.log(`\x1b[1;31m  ✗ ${name}（期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}）\x1b[0m`);
  }
};
async function waitFor(fn, timeout = 8000, label = '条件') {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------- 静态服务
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
let dbHits = 0; // 记录库文件被请求的次数（用来证明「自动加载」）
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  if (/\.json$/.test(p)) dbHits++;
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'passwords_local.json'), 'utf8'));
const [sampleMd5] = Object.entries(db).filter(([k]) => /^[0-9a-f]{32}$/.test(k))[0];

// ---------------------------------------------------------------- 打开页面
// 默认数据源就是仓库根目录的 dbs.json（主库 + 投稿库）

async function openPage(storage, { offline = false } = {}) {
  const vconsole = new VirtualConsole();
  const errors = [];
  vconsole.on('jsdomError', (e) => errors.push(String(e.message || e)));
  const before = dbHits;
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vconsole,
    beforeParse(window) {
      window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
      window.fetch = (url, opts) => {
        const href = new URL(url, BASE).href;
        if (offline) throw new Error('offline（模拟断网）');
        if (!href.startsWith(BASE)) throw new Error('测试禁止访问外部地址: ' + href);
        return globalThis.fetch(href, opts);
      };
      window.AbortController = globalThis.AbortController;
      window.TextEncoder = globalThis.TextEncoder;
      window.Blob = globalThis.Blob;
      for (const [k, v] of Object.entries(storage || {})) window.localStorage.setItem(k, v);
      // 不写 sources：走默认配置（本地 = 同目录 dbs.json 清单），顺带验证清单加载
    },
  });
  await waitFor(() => dom.window.document.readyState === 'complete', 8000, 'load');
  return { dom, window: dom.window, errors, snapshot: () => ({ ...dom.window.localStorage }), hits: () => dbHits - before };
}

const $ = (w, id) => w.document.getElementById(id);

console.log('=== ① 首次打开 ===');
let page = await openPage(null);
const w1 = page.window;
await waitFor(() => /\d+ 条记录/.test($(w1, 'db-meta').textContent), 8000, '首次加载库');
check('首屏自动加载库', true, /2 个库合并/.test($(w1, 'db-meta').textContent));
check('数据源状态已渲染（清单里的 2 个库）', 2, w1.document.querySelectorAll('#source-list .ok').length);
check('库名是仓库名', true, /karune5201\/password/.test($(w1, 'source-list').textContent));
check('确实请求了库文件', true, page.hits() >= 2);

// 查一条 → 产生操作记录
$(w1, 'md5-input').value = sampleMd5;
$(w1, 'btn-query').click();
await waitFor(() => w1.document.querySelector('.hit .pwd'), 5000, '命中');
check('操作记录渲染出「查询」', true, /命中/.test(w1.document.querySelector('#log-list').textContent));
check('最近查询有 1 条', 1, w1.document.querySelectorAll('#history-list .chip').length);
const stored = page.snapshot();
check('操作记录已落 localStorage', true, JSON.parse(stored['pwdash.log.v1'] || '[]').length >= 2);
check('最近查询已落 localStorage', true, JSON.parse(stored['pwdash.history.v2'] || '[]').length === 1);
check('最近查询不存密码明文', true, !JSON.stringify(JSON.parse(stored['pwdash.history.v2'])).includes(JSON.stringify(db[sampleMd5]).slice(1, -1)));
w1.close();

console.log('\n=== ② 再刷新（不点任何按钮） ===');
page = await openPage(stored);
const w2 = page.window;
check('刷新后立刻能看到操作记录', true, w2.document.querySelectorAll('#log-list li').length >= 2);
check('刷新后最近查询还在', 1, w2.document.querySelectorAll('#history-list .chip').length);
check('刷新后没有「尚未加载」', true, !/尚未加载/.test($(w2, 'source-list').textContent));
await waitFor(() => /\d+ 条记录/.test($(w2, 'db-meta').textContent), 8000, '二次自动加载');
check('第二次打开仍然自动拉库（无需手动刷新）', true, page.hits() >= 2);
check('数据源重新加载成功', 2, w2.document.querySelectorAll('#source-list .ok').length);
check('缓存条目数正确', true, Object.keys(JSON.parse(w2.localStorage.getItem('pwdash.db.v3'))).length > 10);
const stored2 = page.snapshot();
check('刷新后操作记录不丢', true, JSON.parse(stored2['pwdash.log.v1']).length >= 2);
w2.close();

console.log('\n=== ③ 断网刷新（回退缓存） ===');
page = await openPage(stored2, { offline: true });
const w3 = page.window;
await waitFor(() => /回退|条记录/.test($(w3, 'db-meta').textContent), 8000, '断网回退');
check('断网仍有记录数（用缓存）', true, /\d+ 条记录/.test($(w3, 'db-meta').textContent));
check('断网提示使用缓存', true, /回退到本地缓存/.test($(w3, 'db-meta').textContent));
check('断网时操作记录照旧显示', true, w3.document.querySelectorAll('#log-list li').length >= 2);
$(w3, 'md5-input').value = sampleMd5;
$(w3, 'btn-query').click();
await waitFor(() => w3.document.querySelector('.hit .pwd'), 5000, '断网命中');
check('断网命中结果', true, !!w3.document.querySelector('.hit'));

console.log('\n=== ④ 清空操作记录 ===');
$(w3, 'btn-clear-log').click();
await sleep(120);
check('记录已清空', 0, w3.document.querySelectorAll('#log-list li').length);
check('空状态提示出现', false, $(w3, 'log-empty').hidden);
check('localStorage 已清', null, w3.localStorage.getItem('pwdash.log.v1'));

const real = page.errors.filter((e) => !/Could not parse CSS|Not implemented|serviceWorker|offline（模拟断网）|Failed to load/i.test(e));
check('无运行时异常', [], real.slice(0, 3));
w3.close();

console.log('\n================ 结果 ================');
console.log(`\x1b[1;32m通过: ${pass}\x1b[0m`);
if (fail) console.log(`\x1b[1;31m失败: ${fail}\x1b[0m`);
else console.log('\x1b[1;32m全部通过 🎉\x1b[0m');

server.close();
process.exit(fail ? 1 : 0);
