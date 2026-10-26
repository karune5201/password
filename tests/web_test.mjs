#!/usr/bin/env node
/* web_test.mjs —— 用无头 Chrome（CDP 直连，无需 puppeteer）跑前端端到端测试
 *
 *   # 先起本地静态服务
 *   python3 tools/serve.py --port 8080 &
 *   # 再跑本脚本
 *   node tests/web_test.mjs --chrome /path/to/chrome \
 *        --site http://127.0.0.1:8080/ \
 *        --db http://127.0.0.1:8080/passwords_local.json
 *
 * 覆盖：多源加载、本地缓存、单条查询、显示/复制、批量查询、主题切换、
 *       浏览器内 MD5 计算、控制台报错检查。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- 参数
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CHROME = arg('chrome', process.env.CHROME || 'google-chrome');
const SITE = arg('site', 'http://127.0.0.1:8080/');
const DB_URL = arg('db', new URL('passwords_local.json', SITE).href);
const PORT = Number(arg('port', '9333'));

// ---------------------------------------------------------------- 工具
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
  return ok;
}

// ---------------------------------------------------------------- CDP 客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里求值，返回 JSON 可序列化结果 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `页面内异常: ${res.exceptionDetails.text} ${
          (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || ''
        }`
      );
    }
    return res.result.value;
  }

  /** 轮询直到表达式为真 */
  async waitFor(expression, timeout = 8000, label = expression) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const v = await this.eval(expression).catch(() => false);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
      await sleep(120);
    }
  }
}

// ---------------------------------------------------------------- 启动浏览器
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profile-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stderr.on('data', () => {});
  return { proc, profile };
}

async function pageWsUrl(deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('无法连接 Chrome 调试端口');
    await sleep(200);
  }
}

// ---------------------------------------------------------------- 主流程
const { proc, profile } = await launch();
let cdp;
try {
  const wsUrl = await pageWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // 收集页面错误
  const errors = [];
  const origPush = cdp.events.push.bind(cdp.events);
  cdp.events.push = (msg) => {
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text || 'exception');
    }
    return origPush(msg);
  };

  // 取一份真实数据用于断言
  const db = await (await fetch(DB_URL)).json();
  const entries = Object.entries(db).filter(([k]) => /^[0-9a-f]{32}$/.test(k));
  const [sampleMd5, samplePwd] = entries[0];
  const missingMd5 = 'f'.repeat(32);

  console.log('=== 1. 首次加载（默认数据源） ===');
  await cdp.send('Page.navigate', { url: SITE });
  await cdp.waitFor(`document.readyState === 'complete'`, 15000, '页面加载');
  await cdp.waitFor(`document.getElementById('btn-query') !== null`, 8000, 'DOM 就绪');
  check('页面标题', '密码查询 · pwdash', await cdp.eval('document.title'));
  check('三个标签页', 3, await cdp.eval(`document.querySelectorAll('.tab').length`));

  console.log('\n=== 2. 多源加载（注入本地数据源） ===');
  await cdp.eval(`(() => {
    localStorage.setItem('pwdash.sources.v2', JSON.stringify([
      { name: '本地镜像', url: ${JSON.stringify(DB_URL)}, enabled: true }
    ]));
    localStorage.removeItem('pwdash.db.v2');
    localStorage.removeItem('pwdash.meta.v2');
    return true;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor(`document.readyState === 'complete'`, 15000, '重载完成');
  await cdp.waitFor(
    `(JSON.parse(localStorage.getItem('pwdash.db.v2') || '{}') | 0, Object.keys(JSON.parse(localStorage.getItem('pwdash.db.v2') || '{}')).length) > 0`,
    12000,
    '密码库写入缓存'
  );
  const cachedCount = await cdp.eval(
    `Object.keys(JSON.parse(localStorage.getItem('pwdash.db.v2') || '{}')).length`
  );
  check('缓存条目数等于库大小', entries.length, cachedCount);
  check('数据源状态显示 ✓', true, await cdp.eval(`!!document.querySelector('#source-list .ok')`));
  check('#db-meta 有记录数', true, await cdp.eval(`/\\d+ 条记录/.test(document.getElementById('db-meta').textContent)`));

  console.log('\n=== 3. 单条查询 ===');
  await cdp.eval(`(() => {
    const i = document.getElementById('md5-input');
    i.value = ${JSON.stringify(sampleMd5)};
    i.dispatchEvent(new Event('input'));
    document.getElementById('btn-query').click();
    return true;
  })()`);
  await cdp.waitFor(`!!document.querySelector('.hit .pwd')`, 8000, '命中结果渲染');
  check('密码默认打码', true, await cdp.eval(`document.querySelector('.hit .pwd').classList.contains('masked')`));
  await cdp.eval(`document.querySelectorAll('.hit .row button')[0].click()`);
  check('点击“显示”后为明文', samplePwd, await cdp.eval(`document.querySelector('.hit .pwd').textContent`));
  check('结果区显示 MD5', true, await cdp.eval(`document.querySelector('.hit-md5').textContent === ${JSON.stringify(sampleMd5)}`));
  check('来源标注存在', true, await cdp.eval(`/来源：/.test(document.querySelector('.hit-source').textContent)`));

  console.log('\n=== 4. 查询历史 ===');
  check('历史出现一条', true, await cdp.eval(`document.querySelectorAll('#history-list .chip').length >= 1`));

  console.log('\n=== 5. 未命中 ===');
  await cdp.eval(`(() => {
    const i = document.getElementById('md5-input');
    i.value = ${JSON.stringify(missingMd5)};
    i.dispatchEvent(new Event('input'));
    document.getElementById('btn-query').click();
    return true;
  })()`);
  await cdp.waitFor(`!!document.querySelector('.miss .miss-title')`, 8000, '未命中提示');
  check('未命中提示文案', true, await cdp.eval(`/没找到/.test(document.querySelector('.miss-title').textContent)`));

  console.log('\n=== 6. 非法输入 ===');
  await cdp.eval(`(() => {
    const i = document.getElementById('md5-input');
    i.value = 'zzz';
    i.dispatchEvent(new Event('input'));
    document.getElementById('btn-query').click();
    return true;
  })()`);
  await sleep(300);
  check('非法 MD5 给出提示', true, await cdp.eval(`/不像 32 位 MD5/.test(document.querySelector('#result').textContent)`));

  console.log('\n=== 7. 批量查询 ===');
  await cdp.eval(`(() => {
    document.querySelector('.tab[data-mode="batch"]').click();
    const ta = document.getElementById('batch-input');
    ta.value = '${sampleMd5}\\n${missingMd5}\\ninvalid';
    document.getElementById('btn-batch-query').click();
    return true;
  })()`);
  await cdp.waitFor(`document.querySelectorAll('table.batch tbody tr').length === 3`, 10000, '批量结果');
  check('批量渲染 3 行', 3, await cdp.eval(`document.querySelectorAll('table.batch tbody tr').length`));
  check('批量命中行有密码', samplePwd, await cdp.eval(`document.querySelectorAll('table.batch tbody tr')[0].querySelector('.pwd-cell').textContent`));
  check('批量未命中提示', '未找到', await cdp.eval(`document.querySelectorAll('table.batch tbody tr')[1].querySelector('.pwd-cell').textContent`));
  check('批量非法行提示', '格式不正确', await cdp.eval(`document.querySelectorAll('table.batch tbody tr')[2].querySelector('.pwd-cell').textContent`));

  console.log('\n=== 8. 浏览器内 MD5（拖文件路径） ===');
  const rawDb = await (await fetch(DB_URL)).text();
  const expectMd5 = crypto.createHash('md5').update(rawDb, 'utf8').digest('hex');
  const jsMd5 = await cdp.eval(`(async () => {
    const text = ${JSON.stringify(rawDb)};
    const file = new File([text], 'passwords_local.json');
    return await Md5.hashFile(file);
  })()`);
  check('hashFile 结果与 node crypto 一致', expectMd5, jsMd5);

  console.log('\n=== 9. 主题切换 ===');
  const before = await cdp.eval(`document.documentElement.dataset.theme`);
  await cdp.eval(`document.getElementById('btn-theme').click()`);
  await sleep(200);
  const after = await cdp.eval(`document.documentElement.dataset.theme`);
  check('主题被切换', true, before !== after);
  check('主题写入 localStorage', after, await cdp.eval(`JSON.parse(localStorage.getItem('pwdash.theme.v2'))`));

  console.log('\n=== 10. 设置面板 ===');
  check('设置弹窗可打开', true, await cdp.eval(`(() => {
    document.getElementById('btn-settings').click();
    const d = document.getElementById('settings');
    return d.open === true;
  })()`));
  check('数据源编辑器有条目', true, await cdp.eval(`document.querySelectorAll('#source-edit li').length >= 1`));
  check('缓存信息已填充', true, await cdp.eval(`/已缓存 \\d+ 条/.test(document.getElementById('cache-info').textContent)`));
  await cdp.eval(`document.getElementById('settings').close()`);

  console.log('\n=== 11. Service Worker 注册 ===');
  const swState = await cdp.eval(`(async () => {
    if (!navigator.serviceWorker) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  })()`);
  check('SW 已注册', 'registered', swState);

  console.log('\n=== 12. 控制台无错误 ===');
  const realErrors = errors.filter(
    (e) => !/Failed to load resource|net::ERR|ERR_NAME_NOT_RESOLVED|favicon/i.test(e)
  );
  check('无 JS 异常', [], realErrors.slice(0, 3));

  console.log('\n================ 结果 ================');
  console.log(`\x1b[1;32m通过: ${pass}\x1b[0m`);
  if (fail) {
    console.log(`\x1b[1;31m失败: ${fail}\x1b[0m`);
  } else {
    console.log('\x1b[1;32m全部通过 🎉\x1b[0m');
  }
} catch (err) {
  console.error('\x1b[1;31m测试异常:\x1b[0m', err.message);
  fail++;
} finally {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
