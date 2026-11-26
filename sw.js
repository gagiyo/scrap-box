/* 스크랩박스 서비스 워커 — 앱 껄데기는 캐시하고, 스크랩 데이터는 IndexedDB에만 둔다.
   껄데기(index.html·css·js)는 네트워크 우선으로 받아, 새 index.html에 옛 css/js가
   섞이는 일을 막는다. 오프라인일 때만 캐시로 대신한다. */
const CACHE = 'scrapbox-shell-v10';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=10',
  './app.js?v=10',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

const SHELL_ASSET = /\.(?:css|js)$/;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // 미리보기·썸네일 같은 외부 요청은 그대로 통과

  // 화면: 네트워크 우선(HTTP 캐시도 건너뛰어 항상 새 index.html), 실패하면 캐시된 index.html
  // (GitHub Pages가 html을 10분간 캐시하라고 보내므로, 새로 올린 화면이 바로 뜨게 한다.)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(function (cache) { cache.put('./index.html', copy); });
          }
          return response;
        })
        .catch(function () { return caches.match('./index.html').then(function (hit) { return hit || caches.match('./'); }); })
    );
    return;
  }

  // 껄데기(css·js): 네트워크 우선 — 버전 쿼리가 붙은 요청도 항상 최신을 먼저 받는다.
  if (SHELL_ASSET.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        })
        .catch(function () {
          return caches.match(request)
            .then(function (hit) { return hit || caches.match(request, { ignoreSearch: true }); })
            .then(function (hit) { return hit || new Response('', { status: 504, statusText: 'offline' }); });
        })
    );
    return;
  }

  // 나머지(아이콘·manifest 등): 캐시 우선 + 백그라운드 갱신
  event.respondWith(
    caches.match(request).then(function (hit) {
      const network = fetch(request).then(function (response) {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () { return null; });

      return hit || network.then(function (response) {
        return response || new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
