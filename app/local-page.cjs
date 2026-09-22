'use strict';
const { protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const ready = new WeakSet();

// 埋め込み先にPC内のインストールパスを送らず、固定のアプリ内URLを使う。
protocol.registerSchemesAsPrivileged([{ scheme: 'postclip', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// 決められた3ファイルだけをアプリ内ページとして配信する。
function installLocalPage(session) {
  if (ready.has(session)) return;
  const files = { '/embed.html': ['embed.html','text/html; charset=utf-8'], '/embed.js': ['embed.js','application/javascript; charset=utf-8'], '/embed.css': ['embed.css','text/css; charset=utf-8'] };
  session.protocol.handle('postclip', async request => {
    const url = new URL(request.url);
    const entry = url.hostname === 'capture' ? files[url.pathname] : null;
    if (!entry) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(__dirname, entry[0])), { headers: { 'content-type': entry[1], 'cache-control': 'no-store' } });
  });
  ready.add(session);
}

module.exports = { installLocalPage };
