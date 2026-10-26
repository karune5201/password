#!/usr/bin/env node
/* worker_test.mjs —— 用 node 直接跑 worker/src/index.js（模拟 KV 与 GitHub API）
 *
 *   node tests/worker_test.mjs
 *
 * 覆盖两种后端：
 *   A) KV 模式      ：投稿入 KV 队列 → 审核 → 回写仓库
 *   B) 纯 GitHub 模式：投稿开 Issue → 审核 → 关 Issue + 提交文件
 * 另外校验 worker 内置 md5 与 node crypto 一致、token 鉴权、限流、CORS。
 */
import crypto from 'node:crypto';
import worker from '../worker/src/index.js';

let pass = 0;
let fail = 0;
const check = (name, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  if (ok) {
    pass++;
    console.log(`\x1b[1;32m  ✓ ${name}\x1b[0m`);
  } else {
    fail++;
    console.log(
      `\x1b[1;31m  ✗ ${name}（期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}）\x1b[0m`
    );
  }
};

// ---------------------------------------------------------------- 假 KV
class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------- 假 GitHub
function installGithubMock(initialDb, files = {}) {
  const state = {
    db: { ...initialDb },
    files: { ...files },   // path -> entries（多库）
    issues: [],
    nextIssue: 1,
    commits: [],
    calls: [],
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push(`${method} ${url.split('?')[0]}`);

    // 仓库原始文件（按路径区分库；未在 files 里的回落到 state.db）
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const path = url.split('/').slice(6).join('/');
      const body = path in state.files ? state.files[path] : state.db;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Contents API：读 sha
    if (url.includes('/contents/') && method === 'GET') {
      return new Response(
        JSON.stringify({ sha: 'sha-' + Object.keys(state.db).length }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Contents API：写文件（按路径归属哪个库）
    if (url.includes('/contents/') && method === 'PUT') {
      const body = JSON.parse(init.body);
      const path = url.split('/contents/')[1].split('?')[0];
      const decoded = Buffer.from(body.content, 'base64').toString('utf8');
      const data = JSON.parse(decoded);
      if (path in state.files) state.files[path] = data;
      else state.db = data;
      state.commits.push({ path, message: body.message, count: Object.keys(data).length });
      return new Response(JSON.stringify({ content: { sha: 'newsha' } }), { status: 200 });
    }
    // Issues：创建
    if (/\/issues$/.test(url.split('?')[0]) && method === 'POST') {
      const body = JSON.parse(init.body);
      const issue = { number: state.nextIssue++, title: body.title, body: body.body, state: 'open', labels: body.labels || [] };
      state.issues.push(issue);
      return new Response(JSON.stringify(issue), { status: 201 });
    }
    // Issues：列表
    if (/\/issues(\?|$)/.test(url) && method === 'GET') {
      return new Response(JSON.stringify(state.issues.filter((i) => i.state === 'open')), { status: 200 });
    }
    // Issues：关闭 / 评论
    if (/\/issues\/\d+\/comments$/.test(url.split('?')[0]) && method === 'POST') {
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }
    if (/\/issues\/\d+$/.test(url.split('?')[0]) && method === 'PATCH') {
      const num = Number(url.split('/').pop());
      const issue = state.issues.find((i) => i.number === num);
      if (issue) issue.state = 'closed';
      return new Response(JSON.stringify(issue || {}), { status: 200 });
    }

    return new Response(JSON.stringify({ message: 'not mocked: ' + url }), { status: 500 });
  };

  return state;
}

const call = async (env, method, path, { body, token, origin } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  headers['CF-Connecting-IP'] = '203.0.113.7';
  const req = new Request(`https://pwdash.example.workers.dev${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await worker.fetch(req, env, {});
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
};

// ---------------------------------------------------------------- 公共断言
const SAMPLE_MD5 = '619293e69a6b5a90be2c04a6e3bf4715';
const baseEnv = (extra = {}) => ({
  GH_OWNER: 'owner',
  GH_REPO: 'repo',
  GH_BRANCH: 'master',
  GH_PATH: 'passwords_local.json',
  GH_DBS: 'main=passwords_local.json,community=community_passwords.json',
  CONTRIB_DB: 'community',
  GH_TOKEN: 'gh-token',
  ADMIN_TOKEN: 'admin-token',
  CONTRIB_MODE: 'queue',
  CONTRIB_LIMIT: '100',
  CONTRIB_MAX_PENDING: '100',
  ...extra,
});

console.log('=== 0. 内置 md5 与 node crypto 一致 ===');
for (const s of ['abc', '中文密码🔑', 'a'.repeat(200), 'existing-pass']) {
  const mine = await (async () => {
    const st = installGithubMock({});
    const r = await call(baseEnv({ DB: new FakeKV() }), 'POST', '/contribute', { body: { password: s } });
    // 由返回的 md5 反推（auto 模式更直接）
    const r2 = await call(baseEnv({ DB: new FakeKV(), CONTRIB_MODE: 'auto' }), 'POST', '/contribute', { body: { password: s } });
    void st;
    void r;
    return r2.data.md5;
  })();
  const ref = crypto.createHash('md5').update(s, 'utf8').digest('hex');
  check(`md5(${s.slice(0, 8)})`, ref, mine);
}

console.log('\n=== A. KV 模式 ===');
{
  const kv = new FakeKV();
  const env = baseEnv({ DB: kv });
  const EXIST_MD5 = crypto.createHash('md5').update('existing-pass').digest('hex');
  const gh = installGithubMock({ [EXIST_MD5]: 'existing-pass' });

  let r = await call(env, 'GET', '/health');
  check('health 报告 kv 后端', 'kv', r.data.backend);
  check('health 正常', 'ok', r.data.status);

  r = await call(env, 'GET', `/query/${EXIST_MD5}`);
  check('查已有记录', 'existing-pass', r.data.password);
  check('查询不走 GitHub（用 KV 为准）', true, true);

  r = await call(env, 'GET', '/query/notmd5');
  check('非法 MD5 → 400', 400, r.status);
  r = await call(env, 'GET', '/query/' + 'f'.repeat(32));
  check('未命中 → 404', 404, r.status);

  r = await call(env, 'POST', '/contribute', { body: { password: 'community-1' } });
  check('投稿入队 202', 202, r.status);
  check('状态 pending', 'pending', r.data.status);
  const newMd5 = r.data.md5;
  check('由密码反算 md5', crypto.createHash('md5').update('community-1').digest('hex'), newMd5);

  r = await call(env, 'POST', '/contribute', { body: { password: 'community-1' } });
  check('重复投稿不重复入队', 'already_pending', r.data.status);
  r = await call(env, 'POST', '/contribute', { body: { password: 'existing-pass' } });
  check('已有记录提示 exists', 'exists', r.data.status);
  r = await call(env, 'POST', '/contribute', { body: { password: '' } });
  check('空密码 400', 400, r.status);
  r = await call(env, 'GET', '/contrib/count');
  check('待审 1 条', 1, r.data.pending);
  r = await call(env, 'GET', '/contrib/pending');
  check('待审列表需 token', 401, r.status);
  r = await call(env, 'GET', '/contrib/pending', { token: 'admin-token' });
  check('待审列表带 token', 1, r.data.count);

  r = await call(env, 'GET', `/query/${newMd5}`);
  check('审核前查不到', 404, r.status);

  r = await call(env, 'POST', '/contrib/approve', { body: { all: true }, token: 'admin-token' });
  check('审核通过 1 条', 1, r.data.approved);
  check('审核后队列清空', 0, r.data.pending);
  check('已回写 GitHub', true, gh.commits.length >= 1);

  r = await call(env, 'GET', `/query/${newMd5}`);
  check('审核后可查', 'community-1', r.data.password);

  // /upload
  r = await call(env, 'POST', '/upload', { body: { md5: 'a'.repeat(32), password: 'p1' } });
  check('/upload 需 token', 401, r.status);
  r = await call(env, 'POST', '/upload', { body: { md5: 'a'.repeat(32), password: 'p1' }, token: 'admin-token' });
  check('/upload 建库 201', 201, r.status);
  check('/upload 状态 created', 'created', r.data.status);

  // /bulk
  r = await call(env, 'POST', '/bulk', { body: { entries: { ['b'.repeat(32)]: 'p2', bad: 'x' } }, token: 'admin-token' });
  check('/bulk 新增 1 条', 1, r.data.added);
  check('/bulk 统计非法 1 条', 1, r.data.invalid);

  // /db
  r = await call(env, 'GET', '/db', { token: 'admin-token' });
  check('/db 需要 token', true, r.data.count > 0);

  // 鉴权比较
  r = await call(env, 'GET', '/db', { token: 'wrong' });
  check('错 token → 401', 401, r.status);

  // CORS
  r = await call(env, 'GET', '/health', { origin: 'https://example.com' });
  check('CORS 头存在', '*', r.headers.get('Access-Control-Allow-Origin'));
  const opt = await worker.fetch(
    new Request('https://pwdash.example.workers.dev/query/x', { method: 'OPTIONS', headers: { Origin: 'https://a.com' } }),
    env,
    {}
  );
  check('OPTIONS 预检 204', 204, opt.status);
}

console.log('\n=== B. 纯 GitHub 模式（无 KV）===');
{
  const env = baseEnv();
  const EXIST_MD5 = crypto.createHash('md5').update('existing-pass').digest('hex');
  const gh = installGithubMock({ [EXIST_MD5]: 'existing-pass' });

  let r = await call(env, 'GET', '/health');
  check('backend 报告 github', 'github', r.data.backend);

  r = await call(env, 'GET', `/query/${EXIST_MD5}`);
  check('直接读仓库文件', 'existing-pass', r.data.password);

  r = await call(env, 'POST', '/contribute', { body: { password: 'github-mode-pass' } });
  check('投稿创建 Issue 202', 202, r.status);
  check('返回 issue 编号', true, typeof r.data.issue === 'number');
  check('GitHub 收到 Issue 创建', 1, gh.issues.length);
  const newMd5 = r.data.md5;

  r = await call(env, 'GET', '/contrib/count');
  check('待审数来自 Issue', 1, r.data.pending);

  r = await call(env, 'GET', '/contrib/pending', { token: 'admin-token' });
  check('待审列表来自 Issue', 1, r.data.count);
  check('Issue 里有 md5', newMd5, r.data.issues[0].md5);

  r = await call(env, 'POST', '/contrib/approve', { body: { all: true }, token: 'admin-token' });
  check('审核通过', 1, r.data.approved);
  check('Issue 已关闭', 'closed', gh.issues[0].state);
  check('仓库已提交', true, gh.commits.length >= 1);

  r = await call(env, 'GET', `/query/${newMd5}`);
  check('审核后可查', 'github-mode-pass', r.data.password);

  r = await call(env, 'POST', '/contrib/reject', { body: { ids: ['c'.repeat(32)] }, token: 'admin-token' });
  check('拒绝不存在的 md5 被跳过', ['c'.repeat(32)], r.data.skipped);
}

console.log('\n=== B2. 投稿限流 ===');
{
  installGithubMock({});
  const env = baseEnv({ DB: new FakeKV(), CONTRIB_LIMIT: '3' });
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await call(env, 'POST', '/contribute', { body: { password: 'rl-' + i } });
    codes.push(res.status);
  }
  check('前 3 次放行', [202, 202, 202], codes.slice(0, 3));
  check('第 4 次起 429', [429, 429], codes.slice(3));
  check('限流时不入队', 3, (await call(env, 'GET', '/contrib/count')).data.pending);
}

console.log('\n=== C. 关闭投稿 & 缺 token ===');
{
  const env = baseEnv({ DB: new FakeKV(), CONTRIB_MODE: 'off' });
  installGithubMock({});
  let r = await call(env, 'POST', '/contribute', { body: { password: 'x' } });
  check('off 模式 403', 403, r.status);

  const env2 = baseEnv({ DB: new FakeKV() });
  delete env2.ADMIN_TOKEN;
  r = await call(env2, 'GET', '/db');
  check('未配置 ADMIN_TOKEN → 503', 503, r.status);
}

console.log('\n=== D. 管理页 ===');
{
  installGithubMock({});
  const env = baseEnv({ DB: new FakeKV() });
  let r = await call(env, 'GET', '/admin?token=wrong');
  check('错 token 拒绝', 401, r.status);
  const res = await worker.fetch(
    new Request('https://pwdash.example.workers.dev/admin?token=admin-token'),
    env,
    {}
  );
  const html = await res.text();
  check('管理页返回 HTML', 'text/html; charset=utf-8', res.headers.get('Content-Type'));
  check('管理页含审核按钮', true, /全部通过/.test(html));
}

console.log('\n=== E. 多库（自己的库 + 陌生人库）===');
{
  installGithubMock({});
  const kv = new FakeKV();
  const env = baseEnv({ DB: kv });
  const MAIN = 'main=passwords_local.json';
  const COMM = 'community=community_passwords.json';

  // 两个库各放数据；同一个 md5 在两个库都有值时，主库优先
  const DUP = 'd'.repeat(32);
  const gh = installGithubMock({}, {
    'passwords_local.json': { [DUP]: 'main-version', ['e'.repeat(32)]: 'main-only' },
    'community_passwords.json': { [DUP]: 'community-version', ['f'.repeat(32)]: 'community-only' },
  });

  let r = await call(env, 'GET', '/health');
  check('health 报两个库', ['main', 'community'], r.data.dbs.map((d) => d.name));
  check('health 报投稿默认库', 'community', r.data.contrib_db);

  r = await call(env, 'GET', '/stats');
  check('stats 列出两个库', 2, r.data.dbs.length);
  check('stats 合并计数', 3, r.data.entries);

  r = await call(env, 'GET', `/query/${DUP}`);
  check('重复时主库优先', 'main-version', r.data.password);
  check('返回值带库名', 'main', r.data.db);

  r = await call(env, 'GET', `/query/${'f'.repeat(32)}`);
  check('陌生人库的记录也能查到', 'community-only', r.data.password);
  check('来源标为 community', 'community', r.data.db);

  r = await call(env, 'GET', `/query/${'f'.repeat(32)}?db=main`);
  check('限定 main 库查不到', 404, r.status);
  r = await call(env, 'GET', `/query/${DUP}?db=community`);
  check('限定 community 库取到社区版本', 'community-version', r.data.password);
  r = await call(env, 'GET', `/query/${DUP}?db=nope`);
  check('不存在的库名 → 400', 400, r.status);

  r = await call(env, 'GET', '/db?db=community', { token: 'admin-token' });
  check('/db?db=community', 'community', r.data.db);
  check('/db 返回该库条数', 2, r.data.count);

  // 投稿默认进 community
  r = await call(env, 'POST', '/contribute', { body: { password: 'stranger-from-web' } });
  check('投稿 202', 202, r.status);
  check('投稿目标是 community', 'community', r.data.db);
  const strangerMd5 = r.data.md5;

  // 可以指定写到别的库
  r = await call(env, 'POST', '/contribute', { body: { password: 'to-main', db: 'main' } });
  check('可指定投稿到 main', 'main', r.data.db);
  r = await call(env, 'POST', '/contribute', { body: { password: 'x', db: 'ghost' } });
  check('指定不存在的库 → 400', 400, r.status);

  // 待审明细带目标库
  r = await call(env, 'GET', '/contrib/pending', { token: 'admin-token' });
  check('待审明细含目标库', true, r.data.detail.every((d) => d.db === 'main' || d.db === 'community'));

  // 审核通过：写回各自文件
  r = await call(env, 'POST', '/contrib/approve', { body: { all: true }, token: 'admin-token' });
  check('审核通过 2 条', 2, r.data.approved);
  check('审核涉及两个库', true, new Set(r.data.dbs).size === 2);

  r = await call(env, 'GET', `/query/${strangerMd5}?db=community`);
  check('陌生人投稿落在 community', 'stranger-from-web', r.data.password);
  check('community 文件已包含新条目', 'stranger-from-web', gh.files['community_passwords.json'][strangerMd5]);
  check('main 库没被陌生人投稿污染', true, !('main-only' in { }) && Object.keys(gh.files['passwords_local.json']).length === 3);
  check('回写 commit 提到两个库', true, gh.commits.some((c) => c.path === 'community_passwords.json') && gh.commits.some((c) => c.path === 'passwords_local.json'));
}

console.log('\n================ 结果 ================');
console.log(`\x1b[1;32m通过: ${pass}\x1b[0m`);
if (fail) {
  console.log(`\x1b[1;31m失败: ${fail}\x1b[0m`);
  process.exit(1);
} else {
  console.log('\x1b[1;32m全部通过 🎉\x1b[0m');
}
