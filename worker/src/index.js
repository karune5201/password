/**
 * pwdash Worker —— Cloudflare Workers 版后端（零依赖，单个 ES Module）
 *
 * 两种存储后端，按绑定自动选择：
 *   1) 有 KV 绑定（env.DB）           → 库与待审队列放 KV，审核通过后再回写 GitHub
 *   2) 没有 KV（纯 GitHub 模式）      → 库直接读仓库文件；投稿变成 GitHub Issue；
 *                                       审核通过在 GitHub 上处理，或调 /contrib/approve 自动提交
 *
 * 接口（与 server/server.py 保持兼容）
 *   GET  /health
 *   GET  /stats
 *   GET  /query/<md5>
 *   GET  /db                    （需 admin token）
 *   GET  /contrib/count
 *   GET  /contrib/pending       （需 admin token）
 *   POST /contribute            公开投稿：queue 进队列 / auto 直接入库
 *   POST /upload                （需 admin token）
 *   POST /bulk                  （需 admin token）
 *   POST /contrib/approve|reject（需 admin token）
 *   GET  /admin?token=xxx       管理页面（手机也能点）
 *
 * 环境变量
 *   GH_OWNER / GH_REPO / GH_BRANCH / GH_PATH   仓库坐标，默认 Karune-SHI-E / 1111 / master / passwords_local.json
 *   CORS_ORIGIN                                允许的来源，默认 *
 *   CONTRIB_MODE                               queue | auto | off，默认 queue
 *   CONTRIB_LIMIT                              每 IP 每小时投稿上限，默认 10
 *   CONTRIB_MAX_PENDING                        待审队列上限，默认 500
 *   DB                                         （可选）KV 命名空间绑定
 *   GH_TOKEN                                   （secret）有 Contents/Issues 写权限的 PAT
 *   ADMIN_TOKEN                                （secret）管理员口令
 */

const VERSION = '2.1';
const MD5_RE = /^[0-9a-f]{32}$/;

// ---------------------------------------------------------------- 工具
const enc = new TextEncoder();

function cfg(env) {
  return {
    owner: env.GH_OWNER || 'Karune-SHI-E',
    repo: env.GH_REPO || '1111',
    branch: env.GH_BRANCH || 'master',
    path: env.GH_PATH || 'passwords_local.json',
    cors: env.CORS_ORIGIN || '*',
    mode: env.CONTRIB_MODE || 'queue',
    limit: Number(env.CONTRIB_LIMIT || 10),
    maxPending: Number(env.CONTRIB_MAX_PENDING || 500),
  };
}

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });

function corsHeaders(origin, allow) {
  const allowAll = !allow || allow === '*';
  const value = allowAll ? '*' : allow.split(',').map((s) => s.trim()).includes(origin) ? origin : '';
  if (!value) return {};
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function md5Hex(str) {
  // 只用于「由密码反算 MD5」，实现同 RFC 1321（与 Python/前端一致）
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  const msg = enc.encode(str);
  const bitLen = msg.length * 8;
  const withOne = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  withOne.set(msg);
  withOne[msg.length] = 0x80;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 8, bitLen >>> 0, true);
  dv.setUint32(withOne.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const sum = (a + f + K[i] + w[g]) | 0;
      const rot = (sum << S[i]) | (sum >>> (32 - S[i]));
      const next = (b + rot) | 0;
      a = d; d = c; c = b; b = next;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const hex = (n) => [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

function normalizeMd5(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!MD5_RE.test(v)) throw new Error(`不是合法的 32 位 MD5: ${value}`);
  return v;
}

/** 定长比较，避免 token 被时序侧信道猜 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function b64encode(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------- GitHub API
class GitHub {
  constructor(env) {
    this.cfg = cfg(env);
    this.token = env.GH_TOKEN || '';
  }

  get ready() {
    return Boolean(this.token);
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pwdash-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async api(path, init = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      const err = new Error(`GitHub API 失败: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** 读仓库里的密码库（无需 token，走 CDN） */
  async readDb() {
    const { owner, repo, branch, path } = this.cfg;
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`读取库失败: HTTP ${res.status}`);
    const data = await res.json();
    const out = {};
    if (Array.isArray(data)) {
      for (const row of data) {
        if (Array.isArray(row) && row.length >= 2 && row[1]) out[String(row[0]).trim().toLowerCase()] = String(row[1]);
      }
    } else if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string' && v) out[k.trim().toLowerCase()] = v;
    }
    return out;
  }

  /** 把整库写回仓库（Contents API，自动带 sha 更新） */
  async writeDb(entries, message) {
    if (!this.ready) throw new Error('未配置 GH_TOKEN，无法回写仓库');
    const { owner, repo, branch, path } = this.cfg;
    let sha;
    try {
      const cur = await this.api(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      sha = cur.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const sorted = {};
    for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
    const content = JSON.stringify(sorted, null, 2);
    return this.api(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: message || `chore(pwdash): 更新密码库 (${Object.keys(sorted).length} 条)`,
        content: b64encode(content),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  // ---- 纯 GitHub 模式：用 Issue 当待审队列 ----
  async createIssue(md5, password, ip) {
    const { owner, repo } = this.cfg;
    const body = [
      '由 pwdash 投稿接口创建，等待审核。',
      '',
      '```json',
      JSON.stringify({ md5, password }, null, 2),
      '```',
      '',
      `- 来源 IP: ${ip}`,
      `- 时间: ${new Date().toISOString()}`,
      '',
      '**审核方式**：给本 Issue 打上 `approved` 标签并关闭 → 由 GitHub Action 自动合并入库；',
      '或者调用 `POST /contrib/approve`（带 admin token）。',
    ].join('\n');
    return this.api(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: `投稿: ${md5}`, body, labels: ['contribution', 'pending'] }),
    });
  }

  async listIssues() {
    const { owner, repo } = this.cfg;
    const items = await this.api(
      `/repos/${owner}/${repo}/issues?state=open&labels=contribution&per_page=100`
    );
    const out = [];
    for (const issue of items) {
      if (issue.pull_request) continue;
      const match = /```json\s*([\s\S]*?)```/.exec(issue.body || '');
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.md5 && parsed.password) {
          out.push({ id: issue.number, md5: String(parsed.md5).toLowerCase(), password: String(parsed.password), title: issue.title });
        }
      } catch {
        /* 忽略格式不对的 issue */
      }
    }
    return out;
  }

  async closeIssue(number, comment) {
    const { owner, repo } = this.cfg;
    if (comment) {
      await this.api(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: comment }),
      });
    }
    return this.api(`/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }
}

// ---------------------------------------------------------------- 存储（KV 模式）
class KVStore {
  constructor(ns) {
    this.ns = ns;
  }

  async getMap(key) {
    const raw = await this.ns.get(key);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async putMap(key, map) {
    await this.ns.put(key, JSON.stringify(map));
    return map;
  }

  async bump(prefix, ttl) {
    const key = `${prefix}:${Math.floor(Date.now() / 1000)}`;
    const cur = Number((await this.ns.get(key)) || 0) + 1;
    await this.ns.put(key, String(cur), { expirationTtl: ttl });
    return cur;
  }
}

// ---------------------------------------------------------------- 主逻辑
export default {
  async fetch(request, env, ctx) {
    const c = cfg(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, c.cors);
    const gh = new GitHub(env);
    const kv = env.DB ? new KVStore(env.DB) : null;
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    const respond = (body, status = 200, extra = {}) => json(body, status, { ...cors, ...extra });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const isAdmin = () => safeEqual(request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '', env.ADMIN_TOKEN || '');
    const requireAdmin = () => {
      if (!env.ADMIN_TOKEN) return respond({ error: '服务端未配置 ADMIN_TOKEN' }, 503);
      if (!isAdmin()) return respond({ error: '需要有效 token' }, 401);
      return null;
    };

    // ---- 读库：KV 优先，否则读 GitHub ----
    const loadDb = async () => {
      if (kv) {
        const cached = await kv.getMap('db');
        if (Object.keys(cached).length) return cached;
      }
      return gh.readDb();
    };

    try {
      // ---------------- GET ----------------
      if (request.method === 'GET') {
        if (path === '/health') {
          return respond({
            status: 'ok',
            version: VERSION,
            backend: kv ? 'kv' : 'github',
            gh_token: gh.ready,
          });
        }

        if (path === '/stats') {
          const db = await loadDb();
          const bad = Object.keys(db).filter((k) => !MD5_RE.test(k));
          return respond({
            entries: Object.keys(db).length,
            invalid_keys: bad.length,
            backend: kv ? 'kv' : 'github',
            pending: kv ? Object.keys(await kv.getMap('pending')).length : (gh.ready ? (await gh.listIssues()).length : null),
          });
        }

        if (path === '/query' || path.startsWith('/query/')) {
          const raw = path === '/query' ? url.searchParams.get('md5') : path.slice('/query/'.length);
          let md5;
          try {
            md5 = normalizeMd5(raw);
          } catch (err) {
            return respond({ error: err.message }, 400);
          }
          const db = await loadDb();
          const password = db[md5];
          if (!password) return respond({ error: '未找到该 MD5' }, 404);
          return respond({ md5, password });
        }

        if (path === '/db') {
          const denied = requireAdmin();
          if (denied) return denied;
          const db = await loadDb();
          return respond({ entries: db, count: Object.keys(db).length });
        }

        if (path === '/contrib/count') {
          if (kv) return respond({ pending: Object.keys(await kv.getMap('pending')).length });
          if (!gh.ready) return respond({ pending: null, note: '未配置 GH_TOKEN，无法读取待审 Issue' });
          return respond({ pending: (await gh.listIssues()).length });
        }

        if (path === '/contrib/pending') {
          const denied = requireAdmin();
          if (denied) return denied;
          if (kv) {
            const pending = await kv.getMap('pending');
            return respond({ count: Object.keys(pending).length, entries: pending });
          }
          const issues = await gh.listIssues();
          const entries = {};
          for (const item of issues) entries[item.md5] = item.password;
          return respond({ count: issues.length, entries, issues });
        }

        if (path === '/admin') {
          const token = url.searchParams.get('token') || '';
          if (!safeEqual(token, env.ADMIN_TOKEN || '')) return respond({ error: 'token 不正确' }, 401);
          return new Response(adminPage(token), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }

        return respond({ error: '未知接口' }, 404);
      }

      // ---------------- POST ----------------
      if (request.method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return respond({ error: 'JSON 解析失败' }, 400);
        }

        // 公开投稿
        if (path === '/contribute') {
          if (c.mode === 'off') return respond({ error: '本站未开放投稿' }, 403);

          // 限流：KV 可用时按小时计数；否则退回 CA 缓存键计数（尽力而为）
          if (kv) {
            const bucket = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
            const used = await kv.bump(bucket, 3600);
            if (used > c.limit) return respond({ error: '投稿太频繁，请稍后再试' }, 429);
          }

          const password = typeof body.password === 'string' ? body.password.trim() : '';
          if (!password) return respond({ error: '请填写密码' }, 400);
          if (password.length > 256) return respond({ error: '密码过长（>256）' }, 400);

          let md5;
          try {
            md5 = body.md5 ? normalizeMd5(body.md5) : md5Hex(password);
          } catch (err) {
            return respond({ error: err.message }, 400);
          }

          const db = await loadDb();
          if (db[md5]) return respond({ status: 'exists', md5 });

          // auto 模式：直接入库
          if (c.mode === 'auto') {
            if (!gh.ready) return respond({ error: '未配置 GH_TOKEN，无法写入' }, 503);
            const next = { ...db, [md5]: password };
            if (kv) await kv.putMap('db', next);
            await gh.writeDb(next, `feat(pwdash): 新增投稿 ${md5.slice(0, 8)}…`);
            return respond({ status: 'accepted', md5 }, 201);
          }

          // queue 模式
          if (kv) {
            const pending = await kv.getMap('pending');
            if (pending[md5]) return respond({ status: 'already_pending', md5 });
            if (Object.keys(pending).length >= c.maxPending) {
              return respond({ error: '待审队列已满，请稍后再试', pending: Object.keys(pending).length }, 429);
            }
            pending[md5] = password;
            await kv.putMap('pending', pending);
            return respond({ status: 'pending', md5, message: '已提交，等管理员审核后生效', pending: Object.keys(pending).length }, 202);
          }

          // 纯 GitHub 模式：开 Issue
          if (!gh.ready) return respond({ error: '未配置 GH_TOKEN，无法接收投稿' }, 503);
          const issues = await gh.listIssues();
          if (issues.some((i) => i.md5 === md5)) return respond({ status: 'already_pending', md5 });
          if (issues.length >= c.maxPending) return respond({ error: '待审队列已满，请稍后再试' }, 429);
          const issue = await gh.createIssue(md5, password, ip);
          return respond({ status: 'pending', md5, issue: issue.number, message: '已创建审核 Issue，等待处理' }, 202);
        }

        // 以下都需要 admin
        if (path === '/upload' || path === '/bulk' || path === '/contrib/approve' || path === '/contrib/reject') {
          const denied = requireAdmin();
          if (denied) return denied;

          if (path === '/contrib/approve' || path === '/contrib/reject') {
            const approve = path === '/contrib/approve';
            const db = await loadDb();

            if (kv) {
              const pending = await kv.getMap('pending');
              const targets = body.all ? Object.keys(pending) : [].concat(body.ids || []).map((s) => String(s).trim().toLowerCase());
              if (!targets.length) return respond({ error: '需要 ids 列表或 all=true' }, 400);
              const done = [];
              const skipped = [];
              const next = { ...db };
              for (const md5 of targets) {
                if (!pending[md5]) {
                  skipped.push(md5);
                  continue;
                }
                if (approve) next[md5] = pending[md5];
                delete pending[md5];
                done.push(md5);
              }
              if (approve && done.length) {
                await kv.putMap('db', next);
                if (gh.ready) {
                  try {
                    await gh.writeDb(next, `feat(pwdash): 审核通过 ${done.length} 条投稿`);
                  } catch (err) {
                    return respond({ ok: false, done, skipped, pending: Object.keys(pending).length, warning: `KV 已更新，但回写 GitHub 失败: ${err.message}` }, 200);
                  }
                }
              }
              await kv.putMap('pending', pending);
              return respond({ approved: approve ? done.length : 0, rejected: approve ? 0 : done.length, done, skipped, pending: Object.keys(pending).length });
            }

            // 纯 GitHub 模式：按 Issue 处理
            const issues = await gh.listIssues();
            const targets = body.all ? issues.map((i) => i.md5) : [].concat(body.ids || []).map((s) => String(s).trim().toLowerCase());
            const done = [];
            const skipped = [];
            const next = { ...db };
            for (const md5 of targets) {
              const issue = issues.find((i) => i.md5 === md5);
              if (!issue) {
                skipped.push(md5);
                continue;
              }
              if (approve) next[md5] = issue.password;
              await gh.closeIssue(issue.id, approve ? `✅ 已合并入库（${md5}）` : '❌ 未采纳');
              done.push(md5);
            }
            if (approve && done.length) await gh.writeDb(next, `feat(pwdash): 审核通过 ${done.length} 条投稿`);
            return respond({ approved: approve ? done.length : 0, rejected: approve ? 0 : done.length, done, skipped });
          }

          if (path === '/bulk') {
            const entries = body.entries;
            if (!entries || typeof entries !== 'object') return respond({ error: 'entries 必须是对象' }, 400);
            const next = { ...db0Safe(await loadDb()) };
            let added = 0;
            let updated = 0;
            let invalid = 0;
            for (const [k, v] of Object.entries(entries)) {
              const key = String(k).trim().toLowerCase();
              if (!MD5_RE.test(key) || typeof v !== 'string' || !v) {
                invalid++;
                continue;
              }
              if (next[key] && next[key] !== v) {
                if (body.overwrite) {
                  next[key] = v;
                  updated++;
                }
                continue;
              }
              if (next[key] === v) continue;
              next[key] = v;
              added++;
            }
            if (!added && !updated) return respond({ ok: true, added, updated, invalid, note: '没有变化' });
            if (kv) await kv.putMap('db', next);
            if (gh.ready) await gh.writeDb(next, `feat(pwdash): 批量导入 ${added} 条 / 更新 ${updated} 条`);
            return respond({ ok: true, added, updated, invalid });
          }

          // /upload：单条
          const password = typeof body.password === 'string' ? body.password.trim() : '';
          if (!password) return respond({ error: '缺少 password' }, 400);
          if (password.length > 256) return respond({ error: '密码过长' }, 400);
          let md5;
          try {
            md5 = body.md5 ? normalizeMd5(body.md5) : md5Hex(password);
          } catch (err) {
            return respond({ error: err.message }, 400);
          }
          const db = await loadDb();
          if (db[md5] === password) return respond({ status: 'exists', md5 });
          const next = { ...db, [md5]: password };
          if (kv) await kv.putMap('db', next);
          if (gh.ready) await gh.writeDb(next, `feat(pwdash): 新增 ${md5.slice(0, 8)}…`);
          return respond({ status: 'created', md5 }, 201);
        }

        return respond({ error: '未知接口' }, 404);
      }

      return respond({ error: '不支持的方法' }, 405);
    } catch (err) {
      return respond({ error: String((err && err.message) || err) }, 500);
    }
  },
};

function db0Safe(db) {
  return db && typeof db === 'object' ? db : {};
}

// ---------------------------------------------------------------- 管理页
function adminPage(token) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pwdash 投稿审核</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0b0f14;color:#e6edf6;font:15px/1.6 system-ui,-apple-system,sans-serif;padding:18px}
 h1{font-size:17px;margin:0 0 14px}
 .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
 button{font:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:10px;border:1px solid #2a3441;background:#141a23;color:#e6edf6;cursor:pointer}
 button.ok{border-color:#2f6b45;color:#4ade80}
 button.no{border-color:#6b2f2f;color:#f87171}
 ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
 li{background:#141a23;border:1px solid #222c38;border-radius:12px;padding:12px}
 .md5{font-family:ui-monospace,monospace;font-size:11.5px;color:#93a1b5;word-break:break-all}
 .pwd{font-family:ui-monospace,monospace;font-weight:700;margin:6px 0 10px;word-break:break-all}
 .empty{color:#64748b}
 .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#4ade80;color:#05230f;
  padding:10px 18px;border-radius:999px;font-weight:700;font-size:13px;opacity:0;transition:.2s}
 .toast.show{opacity:1}
</style></head><body>
<h1>📥 待审投稿</h1>
<div class="row">
  <button onclick="load()">刷新</button>
  <button class="ok" onclick="act('approve',{all:true})">全部通过</button>
  <button class="no" onclick="act('reject',{all:true})">全部拒绝</button>
</div>
<ul id="list"><li class="empty">加载中…</li></ul>
<div class="toast" id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const H = {'Content-Type':'application/json', Authorization:'Bearer ' + TOKEN};
const $ = id => document.getElementById(id);
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1800); }
async function load(){
  const r = await fetch('/contrib/pending', {headers:H});
  const d = await r.json();
  const list = $('list');
  if (!d.entries || !Object.keys(d.entries).length) { list.innerHTML = '<li class="empty">没有待审投稿 🎉</li>'; return; }
  list.replaceChildren(...Object.entries(d.entries).map(([md5,pwd]) => {
    const li = document.createElement('li');
    const a = document.createElement('div'); a.className='md5'; a.textContent = md5;
    const b = document.createElement('div'); b.className='pwd'; b.textContent = pwd;
    const row = document.createElement('div'); row.className='row';
    const ok = document.createElement('button'); ok.className='ok'; ok.textContent='通过';
    ok.onclick = () => act('approve', {ids:[md5]});
    const no = document.createElement('button'); no.className='no'; no.textContent='拒绝';
    no.onclick = () => act('reject', {ids:[md5]});
    row.append(ok, no); li.append(a,b,row); return li;
  }));
}
async function act(kind, payload){
  const r = await fetch('/contrib/' + kind, {method:'POST', headers:H, body: JSON.stringify(payload)});
  const d = await r.json();
  toast(d.error ? ('失败: ' + d.error) : ('完成，剩余 ' + (d.pending ?? '?') + ' 条'));
  load();
}
load();
</script></body></html>`;
}
