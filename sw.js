/* sw.js —— Service Worker：让网页在断网时依然可用
 *
 * 策略
 *  · 应用外壳（html/css/js/图标）：cache-first，后台更新；
 *  · 密码库 JSON（跨域）：network-first，成功即写入缓存，失败回退缓存；
 *  · 导航请求：先走网络，断网时回退到缓存的 index.html。
 *
 * 改完前端记得把 VERSION 加一，否则老用户会继续用旧缓存。
 */
const VERSION = 'v3-2026-03-log';
const SHELL_CACHE = `pwdash-shell-${VERSION}`;
const DATA_CACHE = `pwdash-data-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './assets/app.css',
  './assets/app.js',
  './assets/md5.js',
  './assets/icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('pwdash-') && k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 页面导航：网络优先，断网回退
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('./index.html').then((r) => r || Response.error()))
    );
    return;
  }

  // 同源静态资源：缓存优先
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((resp) => {
            if (resp.ok) {
              const copy = resp.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return resp;
          })
      )
    );
    return;
  }

  // 跨域数据（密码库）：网络优先 + 缓存兜底
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(DATA_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
