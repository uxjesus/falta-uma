/* Playset — funciona offline. Troque VERSION a cada publicação. */
var VERSION = 'fu-v0.13.0';
var SHELL = ['./', 'index.html', 'logic.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
var IMG_CACHE = 'fu-img-v1';
var IMG_MAX = 400;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== IMG_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function trim(cache) {
  cache.keys().then(function (keys) {
    if (keys.length > IMG_MAX) keys.slice(0, keys.length - IMG_MAX).forEach(function (k) { cache.delete(k); });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Imagens das cartas: guarda depois da primeira vez (aparecem sem internet)
  if (url.hostname === 'cards.scryfall.io' || url.hostname === 'svgs.scryfall.io') {
    e.respondWith(caches.open(IMG_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trim(cache); }
          return res;
        });
      });
    }));
    return;
  }

  // Arquivos do próprio app: rede primeiro (pega atualização), cache se estiver sem sinal
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
    }));
  }
});
