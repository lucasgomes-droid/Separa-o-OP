// Service Worker mínimo — igual ao da Central de Frota: só deixa o site
// "instalável" como app. Não guarda nada em cache, então atualizações
// aparecem na hora. (Os registros feitos sem internet ficam guardados pelo
// próprio app.js, numa fila no aparelho — não aqui.)

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function () { self.clients.claim(); });
self.addEventListener('fetch', function (event) { event.respondWith(fetch(event.request)); });
