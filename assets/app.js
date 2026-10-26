/* app.js —— pwdash 前端逻辑
 *
 * 设计要点
 *  · 本地优先：密码库整库缓存到 localStorage，断网照样能查；
 *  · 多数据源：按优先级顺序尝试，任一成功即停，失败不影响其余；
 *  · 隐私：不做埋点、不加载外部资源；文件 MD5 在浏览器内计算，文件不出本机；
 *  · 无框架、无构建：直接改完就能部署到 GitHub Pages / Cloudflare Pages。
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 配置
  // ------------------------------------------------------------------
  const MD5_RE = /^[0-9a-f]{32}$/;
  const FETCH_TIMEOUT = 8000;
  const HISTORY_MAX = 12;
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
  const LS = {
    db: 'pwdash.db.v2',
    meta: 'pwdash.meta.v2',
    sources: 'pwdash.sources.v2',
    history: 'pwdash.history.v2',
    theme: 'pwdash.theme.v2',
    server: 'pwdash.server.v2',
  };

  // 部署 Cloudflare Worker 后把地址填在这里，前端首次打开就会自动用它
  // 例：'https://pwdash.your-name.workers.dev'
  const DEFAULT_SERVER_URL = '';

  const DEFAULT_SOURCES = [
    {
      name: 'GitHub · Karune-SHI-E/1111',
      url: 'https://raw.githubusercontent.com/Karune-SHI-E/1111/master/passwords_local.json',
      enabled: true,
    },
  ];

  // ------------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------------
  const state = {
    db: null, // { md5: password }
    meta: null, // { source, url, savedAt, count }
    sources: [],
    sourceStates: [],
    history: [],
    server: { url: '', token: '' },
    busy: false,
    lastBatch: [],
  };

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function lsDel(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function timeAgo(ts) {
    if (!ts) return '未知时间';
    const diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    return `${Math.floor(diff / 86400e3)} 天前`;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const node = $('toast');
    node.textContent = msg;
    node.className = 'toast show' + (kind === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.className = 'toast' + (kind === 'err' ? ' err' : '');
    }, 2200);
  }

  // ------------------------------------------------------------------
  // 密码库：规范化 / 拉取 / 缓存
  // ------------------------------------------------------------------
  function normalizeDb(raw) {
    const out = {};
    if (Array.isArray(raw)) {
      // 兼容旧版 [[md5, password], ...]
      for (const row of raw) {
        if (Array.isArray(row) && row.length >= 2 && typeof row[1] === 'string' && row[1]) {
          out[String(row[0]).trim().toLowerCase()] = row[1];
        }
      }
      return out;
    }
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v) out[String(k).trim().toLowerCase()] = v;
      }
    }
    return out;
  }

  async function fetchJson(url, timeout = FETCH_TIMEOUT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, {
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-cache',
        referrerPolicy: 'no-referrer',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function activeSources() {
    return state.sources.filter((s) => s.enabled);
  }

  async function refreshDb(opts) {
    const force = Boolean(opts && opts.force);
    const list = activeSources();
    if (!list.length) throw new Error('没有启用任何数据源');

    state.sourceStates = list.map((s) => ({ name: s.name, url: s.url, status: 'wait', detail: '' }));
    renderSources();

    let lastErr = null;
    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      state.sourceStates[i].status = 'loading';
      renderSources();
      try {
        const entries = normalizeDb(await fetchJson(src.url));
        const count = Object.keys(entries).length;
        if (!count) throw new Error('库内容为空');

        state.db = entries;
        state.meta = { source: src.name, url: src.url, savedAt: Date.now(), count };
        state.sourceStates[i].status = 'ok';
        state.sourceStates[i].detail = `${count} 条`;
        renderSources();

        const cached = lsSet(LS.db, entries) && lsSet(LS.meta, state.meta);
        if (!cached) toast('密码库已加载，但本地缓存失败（存储空间不足）', 'err');
        renderMeta();
        return state.db;
      } catch (err) {
        state.sourceStates[i].status = 'err';
        state.sourceStates[i].detail = String((err && err.message) || err);
        renderSources();
        lastErr = err;
      }
    }
    if (state.db) {
      renderMeta('（已回退到本地缓存）');
      return state.db;
    }
    throw lastErr || new Error('所有数据源都不可用');
  }

  async function ensureDb() {
    if (state.db) return state.db;
    try {
      return await refreshDb();
    } catch (err) {
      if (state.db) return state.db;
      throw err;
    }
  }

  // 从本地缓存秒开
  function loadCacheFirst() {
    const cached = lsGet(LS.db, null);
    if (!cached) return false;
    const db = normalizeDb(cached);
    if (!Object.keys(db).length) return false;
    state.db = db;
    state.meta = lsGet(LS.meta, null) || {
      source: '本地缓存',
      savedAt: 0,
      count: Object.keys(db).length,
    };
    return true;
  }

  function cacheIsFresh() {
    return Boolean(state.meta && state.meta.savedAt && Date.now() - state.meta.savedAt < CACHE_TTL);
  }

  // ------------------------------------------------------------------
  // 查询
  // ------------------------------------------------------------------
  function normalizeInput(raw) {
    if (typeof raw !== 'string') return '';
    const cleaned = raw.replace(/[\s\-:]/g, '').toLowerCase();
    return MD5_RE.test(cleaned) ? cleaned : '';
  }

  async function lookupRemote(md5) {
    const url = (state.server.url || '').replace(/\/+$/, '');
    if (!url) return '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const headers = { Accept: 'application/json' };
      if (state.server.token) headers.Authorization = `Bearer ${state.server.token}`;
      const resp = await fetch(`${url}/query/${md5}`, {
        headers,
        signal: ctrl.signal,
        credentials: 'omit',
      });
      if (!resp.ok) return '';
      const data = await resp.json();
      return typeof data.password === 'string' ? data.password : '';
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookup(md5) {
    await ensureDb();
    if (state.db && state.db[md5]) return { pwd: state.db[md5], from: state.meta ? state.meta.source : '本地库' };
    const remote = await lookupRemote(md5);
    if (remote) return { pwd: remote, from: '私有服务端' };
    return { pwd: '', from: '' };
  }

  // ------------------------------------------------------------------
  // 渲染：结果
  // ------------------------------------------------------------------
  function renderLoading(text) {
    const box = $('result');
    box.replaceChildren(
      el('div', { class: 'loading' }, el('span', { class: 'spinner' }), el('span', { text: text || '正在查询…' }))
    );
  }

  function renderHit(md5, pwd, from) {
    const box = $('result');
    const pwdNode = el('p', { class: 'pwd masked', text: maskPassword(pwd), title: '点击切换显示' });
    let masked = true;

    const toggle = el('button', {
      class: 'btn ghost',
      type: 'button',
      text: '👁 显示',
      style: 'padding:8px 14px;min-height:36px;font-size:13px',
      onclick: () => {
        masked = !masked;
        pwdNode.textContent = masked ? maskPassword(pwd) : pwd;
        pwdNode.classList.toggle('masked', masked);
        toggle.textContent = masked ? '👁 显示' : '🙈 隐藏';
      },
    });

    const copyBtn = el('button', {
      class: 'btn primary',
      type: 'button',
      text: '复制密码',
      style: 'padding:8px 16px;min-height:36px;font-size:13px',
      onclick: () => copy(pwd, '密码已复制'),
    });

    box.replaceChildren(
      el(
        'div',
        { class: 'hit' },
        el(
          'div',
          { class: 'hit-top' },
          el('span', { class: 'hit-label', text: '查询成功' }),
          el('div', { class: 'row tight' }, toggle, copyBtn)
        ),
        pwdNode,
        el(
          'div',
          { class: 'hit-foot' },
          el('span', { class: 'hit-md5', text: md5 }),
          el('span', { class: 'hit-source', text: `来源：${from || '未知'}` })
        )
      )
    );
  }

  function maskPassword(pwd) {
    if (!pwd) return '';
    if (pwd.length <= 4) return '•'.repeat(pwd.length);
    return pwd.slice(0, 1) + '•'.repeat(Math.min(pwd.length - 2, 10)) + pwd.slice(-1);
  }

  function renderMiss(md5) {
    const box = $('result');
    box.replaceChildren(
      el(
        'div',
        { class: 'miss' },
        el('p', { class: 'miss-title', text: '❌ 没找到这个 MD5 对应的密码' }),
        el(
          'p',
          { class: 'miss-sub' },
          'MD5 ',
          el('code', { text: md5 }),
          ' 不在当前密码库中。可以试试：确认 MD5 是否算对（选「拖入文件」自动算）、刷新密码库、或在设置里加一个自定义数据源。'
        )
      )
    );
  }

  function renderInvalid(msg) {
    $('result').replaceChildren(
      el('div', { class: 'miss' }, el('p', { class: 'miss-title', text: '⚠️ ' + (msg || 'MD5 格式不正确') }))
    );
  }

  function renderError(err) {
    $('result').replaceChildren(
      el(
        'div',
        { class: 'miss' },
        el('p', { class: 'miss-title', text: '⚠️ 密码库加载失败' }),
        el('p', { class: 'miss-sub', text: String((err && err.message) || err) + '。已缓存的旧数据仍可继续使用。' })
      )
    );
  }

  // ------------------------------------------------------------------
  // 渲染：数据源 / 缓存信息 / 历史
  // ------------------------------------------------------------------
  function renderSources() {
    const list = $('source-list');
    if (!state.sourceStates.length) {
      list.replaceChildren(el('li', {}, el('span', { class: 'name wait', text: '尚未加载' })));
      return;
    }
    list.replaceChildren(
      ...state.sourceStates.map((s) => {
        const mark =
          s.status === 'ok'
            ? el('span', { class: 'ok', text: '✓' })
            : s.status === 'err'
            ? el('span', { class: 'err', text: '✕' })
            : el('span', { class: 'wait', text: '…' });
        return el(
          'li',
          { title: s.url },
          mark,
          el('span', { class: 'name', text: s.name }),
          el('span', { class: 'detail', text: s.detail || (s.status === 'loading' ? '加载中' : '') })
        );
      })
    );
  }

  function renderMeta(suffix) {
    const meta = state.meta;
    if (!meta) {
      $('db-meta').textContent = '正在加载密码库…';
      return;
    }
    const count = Object.keys(state.db || {}).length;
    $('db-meta').textContent =
      `${count} 条记录 · 来自 ${meta.source} · 更新于 ${timeAgo(meta.savedAt)}${suffix || ''}`;
    renderCacheInfo();
  }

  function renderCacheInfo() {
    const info = $('cache-info');
    if (!info) return;
    const cached = lsGet(LS.db, null);
    if (!cached) {
      info.textContent = '尚未缓存密码库（离线时将无法查询）。';
      return;
    }
    const bytes = new Blob([JSON.stringify(cached)]).size;
    info.textContent = `已缓存 ${Object.keys(cached).length} 条（约 ${formatBytes(bytes)}），${cacheIsFresh() ? '仍在有效期内' : '已过期，下次打开会尝试刷新'}。离线也能查询。`;
  }

  function pushHistory(md5, pwd) {
    state.history = state.history.filter((h) => h.md5 !== md5);
    state.history.unshift({ md5, pwd: pwd || null, ts: Date.now() });
    state.history = state.history.slice(0, HISTORY_MAX);
    lsSet(LS.history, state.history);
    renderHistory();
  }

  function renderHistory() {
    const list = $('history-list');
    const empty = $('history-empty');
    if (!state.history.length) {
      list.replaceChildren();
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.replaceChildren(
      ...state.history.map((h) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              class: 'chip',
              type: 'button',
              title: h.pwd ? '点击重新查询' : '上次未找到',
              onclick: () => {
                $('md5-input').value = h.md5;
                switchMode('md5');
                runQuery(h.md5);
              },
            },
            el('span', { class: 'dot' + (h.pwd ? '' : ' miss') }),
            el('span', { text: h.md5.slice(0, 8) + '…' + h.md5.slice(-4) })
          )
        )
      )
    );
  }

  // ------------------------------------------------------------------
  // 复制
  // ------------------------------------------------------------------
  async function copy(text, okMsg) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el('textarea', { style: 'position:fixed;opacity:0;top:0' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMsg || '已复制');
      return true;
    } catch {
      toast('复制失败，请手动选择文本', 'err');
      return false;
    }
  }

  // ------------------------------------------------------------------
  // 查询入口
  // ------------------------------------------------------------------
  async function runQuery(raw, opts) {
    const record = !opts || opts.record !== false;
    const md5 = normalizeInput(raw);
    if (!md5) {
      renderInvalid(`这不像 32 位 MD5：「${String(raw).slice(0, 40)}」`);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    renderLoading('正在查询…');
    try {
      const res = await lookup(md5);
      if (res.pwd) {
        renderHit(md5, res.pwd, res.from);
        if (record) pushHistory(md5, res.pwd);
      } else {
        renderMiss(md5);
        if (record) pushHistory(md5, null);
      }
    } catch (err) {
      renderError(err);
    } finally {
      state.busy = false;
    }
  }

  async function runBatch() {
    const raw = $('batch-input').value || '';
    const items = Array.from(
      new Set(
        raw
          .split(/[\s,，;；、]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    if (!items.length) {
      toast('请先粘贴要查询的 MD5', 'err');
      return;
    }
    renderLoading(`正在批量查询 ${items.length} 条…`);
    const rows = [];
    try {
      await ensureDb();
    } catch (err) {
      renderError(err);
      return;
    }
    for (const item of items) {
      const md5 = normalizeInput(item);
      if (!md5) {
        rows.push({ input: item, md5: '', pwd: '', error: '格式不正确' });
        continue;
      }
      const res = await lookup(md5).catch(() => ({ pwd: '', from: '' }));
      rows.push({ input: item, md5, pwd: res.pwd, from: res.from, error: res.pwd ? '' : '未找到' });
      if (res.pwd) pushHistory(md5, res.pwd);
      else pushHistory(md5, null);
    }
    state.lastBatch = rows;
    renderBatchTable(rows);
  }

  function renderBatchTable(rows) {
    const tbody = el('tbody');
    for (const row of rows) {
      tbody.append(
        el(
          'tr',
          {},
          el('td', { class: 'md5', text: row.md5 || row.input }),
          el('td', {
            class: 'pwd-cell' + (row.pwd ? '' : ' miss'),
            text: row.pwd || row.error || '未找到',
          }),
          el(
            'td',
            { style: 'width:1%' },
            row.pwd
              ? el('button', {
                  class: 'mini',
                  type: 'button',
                  title: '复制',
                  text: '⧉',
                  onclick: () => copy(row.pwd, '已复制'),
                })
              : null
          )
        )
      );
    }
    $('result').replaceChildren(
      el(
        'div',
        { class: 'miss', style: 'padding:0;border:0;background:none' },
        el(
          'table',
          { class: 'batch' },
          el('thead', {}, el('tr', {}, el('th', { text: 'MD5' }), el('th', { text: '结果' }), el('th', { text: '' }))),
          tbody
        )
      )
    );
  }

  // ------------------------------------------------------------------
  // 文件 → MD5
  // ------------------------------------------------------------------
  function showProgress(pct) {
    $('file-progress').classList.remove('hidden');
    const bar = $('file-progress').querySelector('i');
    const text = $('file-progress').querySelector('.progress-text');
    const clamped = Math.max(0, Math.min(100, pct));
    bar.style.width = clamped + '%';
    text.textContent = clamped.toFixed(0) + '%';
  }

  function hideProgress() {
    $('file-progress').classList.add('hidden');
  }

  async function handleFile(file) {
    if (!file) return;
    if (!window.Md5) {
      toast('MD5 模块未加载', 'err');
      return;
    }
    $('file-name').textContent = `${file.name} · ${formatBytes(file.size)}`;
    showProgress(0);
    try {
      const md5 = await window.Md5.hashFile(file, (loaded, total) => {
        showProgress(total ? (loaded / total) * 100 : 0);
      });
      showProgress(100);
      setTimeout(hideProgress, 350);
      $('md5-input').value = md5;
      $('md5-hint').textContent = `已计算：${md5}`;
      $('md5-hint').classList.remove('warn');
      switchMode('md5');
      await runQuery(md5);
    } catch (err) {
      hideProgress();
      toast('计算 MD5 失败：' + ((err && err.message) || err), 'err');
    }
  }


  // ------------------------------------------------------------------
  // 投稿：把密码提交到服务端（走公开 /contribute 接口，进审核队列）
  // ------------------------------------------------------------------
  async function submitContribution() {
    const pwdInput = $('contrib-password');
    const md5Input = $('contrib-md5');
    const hint = $('contrib-hint');
    const password = pwdInput.value.trim();
    const md5raw = md5Input.value.trim();

    const setHint = (text, bad) => {
      hint.textContent = text;
      hint.classList.toggle('warn', Boolean(bad));
    };

    if (!password) {
      setHint('请先填写要分享的密码。', true);
      pwdInput.focus();
      return;
    }
    if (md5raw && !normalizeInput(md5raw)) {
      setHint('MD5 格式不对：要么留空，要么填 32 位十六进制。', true);
      return;
    }
    if (!state.server.url) {
      setHint('还没有配置服务端。点右上角 ⚙️ 填入服务端地址（形如 https://你的域名）后再投稿。', true);
      openSettings();
      return;
    }

    const btn = $('btn-contrib');
    btn.disabled = true;
    setHint('正在提交…');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (state.server.token) headers.Authorization = `Bearer ${state.server.token}`;
      const payload = { password };
      if (md5raw) payload.md5 = normalizeInput(md5raw);

      const resp = await fetch(`${state.server.url.replace(/\/+$/, '')}/contribute`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        credentials: 'omit',
      });
      const data = await resp.json().catch(() => ({}));

      if (resp.status === 202) {
        setHint('已提交 ✅ 待管理员审核通过后即可被查到。');
        pwdInput.value = '';
        md5Input.value = '';
        toast('投稿已提交，等待审核');
      } else if (resp.status === 201) {
        setHint('已收录 ✅ 现在就能查到这条记录。');
        pwdInput.value = '';
        md5Input.value = '';
        toast('投稿已收录');
        refreshDb({ force: true }).catch(() => {});
      } else if (resp.status === 200 && data.status === 'exists') {
        setHint('这条记录库里已经有了，无需重复提交。');
      } else if (resp.status === 200 && data.status === 'already_pending') {
        setHint('这条已经在待审队列里了，稍等管理员处理。');
      } else if (resp.status === 403) {
        setHint('对方没有开放投稿。', true);
      } else if (resp.status === 429) {
        setHint('投稿太频繁了，过一会儿再试。', true);
      } else {
        setHint(`提交失败：${data.error || 'HTTP ' + resp.status}`, true);
      }
    } catch (err) {
      setHint(`连不上服务端：${(err && err.message) || err}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // 模式切换
  // ------------------------------------------------------------------
  function switchMode(mode) {
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    $('panel-md5').classList.toggle('hidden', mode !== 'md5');
    $('panel-file').classList.toggle('hidden', mode !== 'file');
    $('panel-batch').classList.toggle('hidden', mode !== 'batch');
    $('panel-contrib').classList.toggle('hidden', mode !== 'contrib');
  }

  // ------------------------------------------------------------------
  // 设置面板
  // ------------------------------------------------------------------
  function renderSourceEditor() {
    const list = $('source-edit');
    list.replaceChildren(
      ...state.sources.map((src, i) =>
        el(
          'li',
          {},
          el('input', {
            class: 'name',
            type: 'text',
            value: src.name,
            'aria-label': '数据源名称',
            onchange: (e) => {
              state.sources[i].name = e.target.value.trim() || src.url;
              saveSources();
            },
          }),
          el(
            'label',
            { class: 'enabled' },
            el('input', {
              type: 'checkbox',
              checked: src.enabled,
              onchange: (e) => {
                state.sources[i].enabled = e.target.checked;
                saveSources();
              },
            }),
            '启用'
          ),
          el('button', {
            class: 'mini',
            type: 'button',
            title: '上移',
            text: '↑',
            onclick: () => moveSource(i, -1),
          }),
          el('button', {
            class: 'mini',
            type: 'button',
            title: '下移',
            text: '↓',
            onclick: () => moveSource(i, 1),
          }),
          el('button', {
            class: 'mini',
            type: 'button',
            title: '删除',
            text: '✕',
            onclick: () => {
              state.sources.splice(i, 1);
              saveSources();
              renderSourceEditor();
            },
          })
        )
      )
    );
    if (!state.sources.length) {
      list.replaceChildren(el('li', {}, el('span', { class: 'name', text: '还没有数据源' })));
    }
  }

  function moveSource(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= state.sources.length) return;
    const [item] = state.sources.splice(index, 1);
    state.sources.splice(next, 0, item);
    saveSources();
    renderSourceEditor();
  }

  function saveSources() {
    lsSet(LS.sources, state.sources);
  }

  function openSettings() {
    $('server-url').value = state.server.url || '';
    $('server-token').value = state.server.token || '';
    renderSourceEditor();
    renderCacheInfo();
    const dlg = $('settings');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  // ------------------------------------------------------------------
  // 主题
  // ------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('btn-theme').textContent = theme === 'dark' ? '🌙' : '☀️';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0f14' : '#eef2f7');
    lsSet(LS.theme, theme);
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  // ------------------------------------------------------------------
  // 导入 / 导出
  // ------------------------------------------------------------------
  async function readDbFile(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.gz')) {
      if (typeof DecompressionStream !== 'function') throw new Error('浏览器不支持就地解压 .gz，请先转成 .json');
      const ds = new DecompressionStream('deflate'); // 库文件是 zlib 格式
      const stream = file.stream().pipeThrough(ds);
      return await new Response(stream).json();
    }
    return JSON.parse(await file.text());
  }

  async function importDb(file) {
    if (!file) return;
    try {
      const raw = await readDbFile(file);
      const entries = normalizeDb(raw);
      const count = Object.keys(entries).length;
      if (!count) throw new Error('文件里没有可用的记录');
      state.db = Object.assign({}, state.db || {}, entries);
      state.meta = {
        source: `本地导入（${file.name}）`,
        savedAt: Date.now(),
        count: Object.keys(state.db).length,
      };
      lsSet(LS.db, state.db);
      lsSet(LS.meta, state.meta);
      renderMeta();
      renderCacheInfo();
      toast(`已导入 ${count} 条记录`);
    } catch (err) {
      toast('导入失败：' + ((err && err.message) || err), 'err');
    }
  }

  function exportDb() {
    if (!state.db || !Object.keys(state.db).length) {
      toast('库里没有数据可导出', 'err');
      return;
    }
    const blob = new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'passwords_local.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出当前库');
  }

  // ------------------------------------------------------------------
  // 离线 / 联网状态
  // ------------------------------------------------------------------
  function updateNetBadge() {
    $('net-badge').hidden = navigator.onLine;
  }

  // ------------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------------
  function bindEvents() {
    // 标签页
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    }

    // 单条查询
    $('btn-query').addEventListener('click', () => runQuery($('md5-input').value));
    $('md5-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runQuery($('md5-input').value);
      }
    });
    // 输入时给出实时格式提示（不自动查询，避免每敲一个字就发请求）
    $('md5-input').addEventListener('input', () => {
      const raw = $('md5-input').value.trim();
      const hint = $('md5-hint');
      if (!raw) {
        hint.textContent = '支持带空格或大写的 MD5，会自动规范化。';
        hint.classList.remove('warn');
      } else if (normalizeInput(raw)) {
        hint.textContent = '格式正确，按回车或点「查询密码」。';
        hint.classList.remove('warn');
      } else {
        hint.textContent = `还需要 ${Math.max(0, 32 - raw.replace(/[\s\-:]/g, '').length)} 个字符才够 32 位 MD5。`;
        hint.classList.add('warn');
      }
    });

    $('btn-clear').addEventListener('click', () => {
      $('md5-input').value = '';
      $('md5-hint').textContent = '支持带空格或大写的 MD5，会自动规范化。';
      $('md5-hint').classList.remove('warn');
      $('result').replaceChildren();
      $('md5-input').focus();
    });

    $('btn-paste').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        $('md5-input').value = text.trim();
        $('md5-input').dispatchEvent(new Event('input'));
        if (normalizeInput(text)) runQuery(text);
      } catch {
        toast('浏览器不允许读取剪贴板，请手动粘贴', 'err');
        $('md5-input').focus();
      }
    });

    // 文件
    const dz = $('dropzone');
    dz.addEventListener('click', () => $('file-input').click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('file-input').click();
      }
    });
    $('file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      handleFile(file);
      e.target.value = '';
    });
    for (const type of ['dragenter', 'dragover']) {
      dz.addEventListener(type, (e) => {
        e.preventDefault();
        dz.classList.add('is-drag');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      dz.addEventListener(type, (e) => {
        e.preventDefault();
        dz.classList.remove('is-drag');
      });
    }
    dz.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    // 整页拖拽也接住，避免浏览器直接打开文件
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (e.target.closest && e.target.closest('#dropzone')) return;
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) {
        e.preventDefault();
        switchMode('file');
        handleFile(file);
      }
    });

    // 批量
    $('btn-batch-query').addEventListener('click', runBatch);
    $('btn-batch-copy').addEventListener('click', () => {
      const rows = state.lastBatch.filter((r) => r.pwd);
      if (!rows.length) {
        toast('还没有可复制的结果', 'err');
        return;
      }
      copy(rows.map((r) => `${r.md5}\t${r.pwd}`).join('\n'), `已复制 ${rows.length} 条结果`);
    });

    // 投稿
    $('btn-contrib').addEventListener('click', submitContribution);
    $('btn-contrib-file').addEventListener('click', () => $('contrib-file-input').click());
    $('contrib-file-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !window.Md5) return;
      const hint = $('contrib-hint');
      hint.textContent = '正在计算文件 MD5…';
      try {
        const md5 = await window.Md5.hashFile(file);
        $('contrib-md5').value = md5;
        hint.textContent = `已填入 ${file.name} 的 MD5（${md5}）`;
      } catch (err) {
        hint.textContent = '计算 MD5 失败：' + ((err && err.message) || err);
      }
    });

    // 历史
    $('btn-clear-history').addEventListener('click', () => {
      state.history = [];
      lsDel(LS.history);
      renderHistory();
      toast('已清空查询历史');
    });

    // 数据源
    $('btn-refresh').addEventListener('click', async () => {
      toast('正在刷新密码库…');
      try {
        await refreshDb({ force: true });
        toast(`已刷新，共 ${Object.keys(state.db || {}).length} 条`);
      } catch (err) {
        toast('刷新失败：' + ((err && err.message) || err), 'err');
      }
    });

    // 主题 / 设置
    $('btn-theme').addEventListener('click', toggleTheme);
    $('btn-settings').addEventListener('click', openSettings);

    $('btn-add-source').addEventListener('click', () => {
      const name = $('new-source-name').value.trim();
      const url = $('new-source-url').value.trim();
      if (!/^https?:\/\//i.test(url)) {
        toast('请填写 http(s) 开头的地址', 'err');
        return;
      }
      state.sources.push({ name: name || url, url, enabled: true });
      saveSources();
      renderSourceEditor();
      $('new-source-name').value = '';
      $('new-source-url').value = '';
      toast('已添加数据源，点右上「刷新密码库」生效');
    });

    // 服务端设置：失焦即存
    const saveServer = () => {
      state.server = {
        url: $('server-url').value.trim().replace(/\/+$/, ''),
        token: $('server-token').value.trim(),
      };
      lsSet(LS.server, state.server);
    };
    $('server-url').addEventListener('change', saveServer);
    $('server-token').addEventListener('change', saveServer);

    // 导入 / 导出 / 清缓存
    $('btn-import').addEventListener('click', () => $('import-input').click());
    $('import-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      importDb(file);
      e.target.value = '';
    });
    $('btn-export').addEventListener('click', exportDb);
    $('btn-clear-cache').addEventListener('click', () => {
      lsDel(LS.db);
      lsDel(LS.meta);
      state.db = null;
      state.meta = null;
      renderCacheInfo();
      $('db-meta').textContent = '缓存已清除，下次查询会重新拉取。';
      toast('已清除本地缓存');
    });

    // 网络状态
    window.addEventListener('online', updateNetBadge);
    window.addEventListener('offline', updateNetBadge);

    // 快捷键
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        switchMode('md5');
        $('md5-input').focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        switchMode('md5');
        $('md5-input').select();
      } else if (!typing && e.key.toLowerCase() === 't') {
        toggleTheme();
      } else if (e.key === 'Escape' && tag === 'input') {
        $('md5-input').value = '';
        $('md5-input').dispatchEvent(new Event('input'));
      }
    });
  }

  // ------------------------------------------------------------------
  // Service Worker
  // ------------------------------------------------------------------
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 离线能力不可用不影响主流程 */
    });
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  async function init() {
    // 主题
    const savedTheme = lsGet(LS.theme, null);
    applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

    // 数据源与服务端配置
    const savedSources = lsGet(LS.sources, null);
    state.sources = Array.isArray(savedSources) && savedSources.length ? savedSources : DEFAULT_SOURCES.slice();
    const savedServer = lsGet(LS.server, null);
    state.server =
      savedServer && (savedServer.url || savedServer.token)
        ? savedServer
        : { url: DEFAULT_SERVER_URL || '', token: '' };
    state.history = lsGet(LS.history, []) || [];

    bindEvents();
    renderHistory();
    renderSources();
    updateNetBadge();

    // 先用缓存秒开，再后台刷新
    const hasCache = loadCacheFirst();
    if (hasCache) {
      renderMeta();
      if (!cacheIsFresh()) {
        refreshDb({ force: true }).catch(() => {
          /* 刷新失败就继续用缓存 */
        });
      }
    } else {
      try {
        await refreshDb();
      } catch (err) {
        renderError(err);
      }
    }

    // 支持 ?md5= 或 #md5= 直接查询
    const params = new URLSearchParams(location.search);
    const fromHash = location.hash.replace(/^#(md5=)?/i, '');
    const preset = params.get('md5') || fromHash;
    if (preset && normalizeInput(preset)) {
      $('md5-input').value = normalizeInput(preset);
      $('md5-input').dispatchEvent(new Event('input'));
      runQuery(preset);
    }

    registerSW();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
