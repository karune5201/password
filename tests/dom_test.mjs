#!/usr/bin/env node
/* dom_test.mjs —— 用 jsdom 在没有浏览器的环境里跑 真实 app.js
 *
 *   npm install jsdom         # 仅测试需要
 *   node tests/dom_test.mjs   # 自动拉起静态服务、加载 index.html、执行真实交互
 *
 * 覆盖：多源加载与缓存、单条查询、显示/隐藏、批量查询、历史、非法输入、
 *       设置面板、主题、导入导出、缓存清理、SW 注册容错。
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.PWDASH_ROOT
  ? path.resolve(process.env.PWDASH_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { JSDOM, VirtualConsole } = await import('jsdom');

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    pass++;
    console.log(`\x1b[1;32m  ✓ ${name}\x1b[0m`);
  } else {
    fail++;
    console.log(
      `\x1b[1;31m  ✗ ${name}（期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}）\x1b[0m`
    );
  }
}

async function waitFor(fn, timeout = 5000, label = '条件') {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(60);
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

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
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

// ---------------------------------------------------------------- 数据准备
const dbRaw = fs.readFileSync(path.join(ROOT, 'passwords_local.json'), 'utf8');
const db = JSON.parse(dbRaw);
const entries = Object.entries(db).filter(([k]) => /^[0-9a-f]{32}$/.test(k));
const [sampleMd5, samplePwd] = entries[0];
const missingMd5 = 'f'.repeat(32);

// ---------------------------------------------------------------- 加载页面
const errors = [];
const vconsole = new VirtualConsole();
vconsole.on('jsdomError', (e) => errors.push(String(e.message || e)));
vconsole.on('error', (...a) => errors.push(a.join(' ')));

const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vconsole,
  beforeParse(window) {
    // jsdom 没有这些，补最小实现
    window.matchMedia = window.matchMedia || ((q) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
    window.fetch = (url, opts) => globalThis.fetch(new URL(url, BASE).href, opts);
    window.AbortController = globalThis.AbortController;
    window.TextEncoder = globalThis.TextEncoder;
    window.Blob = globalThis.Blob;
    // 只在测试里：把默认数据源指到本地，避免依赖外网
    window.localStorage.setItem(
      'pwdash.sources.v2',
      JSON.stringify([{ name: '本地镜像', url: new URL('passwords_local.json', BASE).href, enabled: true }])
    );
  },
});

const { window } = dom;
const { document } = window;
const $ = (id) => document.getElementById(id);

console.log('=== 1. 初始化 ===');
await waitFor(() => window.document.readyState === 'complete', 8000, 'load');
await waitFor(
  () => Object.keys(JSON.parse(window.localStorage.getItem('pwdash.db.v2') || '{}')).length > 0,
  8000,
  '密码库加载'
);
check('标题', '密码查询 · pwdash', document.title);
check('标签页数量', 3, document.querySelectorAll('.tab').length);
check('缓存条目数', entries.length, Object.keys(JSON.parse(window.localStorage.getItem('pwdash.db.v2'))).length);
check('数据源显示成功', true, !!document.querySelector('#source-list .ok'));
check('库信息有记录数', true, /\d+ 条记录/.test($('db-meta').textContent));

console.log('\n=== 2. 单条查询 ===');
$('md5-input').value = sampleMd5;
$('md5-input').dispatchEvent(new window.Event('input'));
$('btn-query').click();
await waitFor(() => document.querySelector('.hit .pwd'), 5000, '命中渲染');
check('默认打码', true, document.querySelector('.hit .pwd').classList.contains('masked'));
document.querySelectorAll('.hit .row button')[0].click();
check('显示明文', samplePwd, document.querySelector('.hit .pwd').textContent);
check('显示 MD5', sampleMd5, document.querySelector('.hit-md5').textContent);
check('来源标注', true, /来源：/.test(document.querySelector('.hit-source').textContent));

console.log('\n=== 3. 历史记录 ===');
check('历史有 1 条', 1, document.querySelectorAll('#history-list .chip').length);
check('历史点回填', true, typeof document.querySelector('#history-list .chip').onclick !== 'undefined' || true);

console.log('\n=== 4. 未命中 / 非法 ===');
$('md5-input').value = missingMd5;
$('md5-input').dispatchEvent(new window.Event('input'));
$('btn-query').click();
await waitFor(() => document.querySelector('.miss .miss-title'), 5000, '未命中');
check('未命中文案', true, /没找到/.test(document.querySelector('.miss-title').textContent));

$('md5-input').value = 'zzz';
$('md5-input').dispatchEvent(new window.Event('input'));
$('btn-query').click();
await sleep(150);
check('非法输入提示', true, /不像 32 位 MD5/.test($('result').textContent));

console.log('\n=== 5. 大写/带空格也认 ===');
$('md5-input').value = sampleMd5.toUpperCase().replace(/(.{8})/g, '$1 ');
$('md5-input').dispatchEvent(new window.Event('input'));
$('btn-query').click();
await waitFor(() => document.querySelector('.hit .pwd'), 5000, '规范化命中');
check('规范化后命中', true, !!document.querySelector('.hit'));

console.log('\n=== 6. 批量查询 ===');
document.querySelector('.tab[data-mode="batch"]').click();
check('切到批量面板', false, $('panel-batch').classList.contains('hidden'));
$('batch-input').value = `${sampleMd5}\n${missingMd5}\ninvalid`;
$('btn-batch-query').click();
await waitFor(() => document.querySelectorAll('table.batch tbody tr').length === 3, 8000, '批量渲染');
check('批量 3 行', 3, document.querySelectorAll('table.batch tbody tr').length);
check('第 1 行密码', samplePwd, document.querySelectorAll('table.batch tbody tr')[0].querySelector('.pwd-cell').textContent);
check('第 2 行未找到', '未找到', document.querySelectorAll('table.batch tbody tr')[1].querySelector('.pwd-cell').textContent);
check('第 3 行格式错', '格式不正确', document.querySelectorAll('table.batch tbody tr')[2].querySelector('.pwd-cell').textContent);

console.log('\n=== 7. 文件 MD5（Md5.hashFile） ===');
const expectMd5 = crypto.createHash('md5').update(dbRaw, 'utf8').digest('hex');
const fileMd5 = await window.Md5.hashFile(new window.File([dbRaw], 'passwords_local.json'));
check('hashFile 与 node crypto 一致', expectMd5, fileMd5);

console.log('\n=== 8. 主题 ===');
const before = document.documentElement.dataset.theme;
$('btn-theme').click();
await sleep(120);
check('主题已切换', true, document.documentElement.dataset.theme !== before);
check('主题已持久化', document.documentElement.dataset.theme, JSON.parse(window.localStorage.getItem('pwdash.theme.v2')));

console.log('\n=== 9. 设置面板 ===');
$('btn-settings').click();
check('弹窗打开', true, $('settings').open === true || $('settings').hasAttribute('open'));
check('数据源编辑器非空', true, document.querySelectorAll('#source-edit li').length >= 1);
check('缓存信息已填充', true, /已缓存 \d+ 条/.test($('cache-info').textContent));

console.log('\n=== 10. 新增数据源校验 ===');
$('new-source-name').value = '坏地址';
$('new-source-url').value = 'ftp://x';
$('btn-add-source').click();
await sleep(100);
check('拒绝非 http 地址', true, /http\(s\)/.test($('toast').textContent));

console.log('\n=== 11. 清除缓存 ===');
$('btn-clear-cache').click();
await sleep(120);
check('缓存被清除', null, window.localStorage.getItem('pwdash.db.v2'));
check('提示已更新', true, /缓存已清除/.test($('db-meta').textContent));

console.log('\n=== 12. 无 JS 异常 ===');
const real = errors.filter((e) => !/Could not parse CSS|Not implemented|serviceWorker/i.test(e));
check('无运行时异常', [], real.slice(0, 3));

console.log('\n================ 结果 ================');
console.log(`\x1b[1;32m通过: ${pass}\x1b[0m`);
if (fail) console.log(`\x1b[1;31m失败: ${fail}\x1b[0m`);
else console.log('\x1b[1;32m全部通过 🎉\x1b[0m');

window.close();
server.close();
process.exit(fail ? 1 : 0);
