'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const side = 1254;
const logicalSide = 1000;
const userData = fsSync.mkdtempSync(path.join(os.tmpdir(), 'postclip-promo-'));
app.setPath('userData', userData);
app.getVersion = () => require('../package.json').version;
app.requestSingleInstanceLock = () => true;

// 素材の描画に必要な画面状態だけを、上限時間内で待つ。
async function wait(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

// 架空投稿だけを返し、掲載画像の作成時にXへ接続しないようにする。
async function fixtures() {
  const sample = await fs.readFile(path.resolve(__dirname, '../tests/fixtures/sample.html'), 'utf8');
  const captureSession = session.fromPartition('postclip-embed');
  await captureSession.protocol.handle('https', request => {
    if (new URL(request.url).pathname === '/widgets.js') {
      return new Response(`window.twttr={widgets:{createTweet:async(id,mount,opts)=>{const f=document.createElement('iframe');f.style.cssText='width:'+opts.width+'px;height:620px';f.src='https://platform.twitter.com/sample';mount.append(f);await new Promise(r=>f.onload=r);return f}}};`, { headers: { 'content-type': 'application/javascript' } });
    }
    return new Response(sample, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
}

// 実際のアプリで架空投稿を作成し、正方形の画面紹介画像を撮影する。
async function run() {
  let main;
  await wait(() => {
    main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/ui/index.html'));
    return !!main;
  }, 'メイン画面が起動しませんでした。');
  const wc = main.webContents;
  await wait(() => wc.executeJavaScript(`!!window.postclip && document.getElementById("version").textContent === ${JSON.stringify(app.getVersion())}`), '画面の初期化が完了しませんでした。');
  await fixtures();
  await wc.executeJavaScript('document.getElementById("url").value="https://x.com/postclip_sample/status/200";document.getElementById("capture-button").click()');
  await wait(() => wc.executeJavaScript('!document.getElementById("download").disabled'), 'サンプル画像の作成が完了しませんでした。');
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: logicalSide, height: logicalSide, deviceScaleFactor: side / logicalSide, mobile: false });
  await wc.executeJavaScript('document.fonts.ready');
  await wc.executeJavaScript('Promise.all([...document.images].map(image => image.decode().catch(() => {})))');
  await new Promise(resolve => setTimeout(resolve, 300));
  const shot = await wc.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: logicalSide, height: logicalSide, scale: 1 }
  });
  const png = Buffer.from(shot.data, 'base64');
  if (png.readUInt32BE(16) !== side || png.readUInt32BE(20) !== side) throw new Error('撮影画像が正方形ではありません。');
  await fs.writeFile(path.resolve(__dirname, '../booth/postclip-screen.png'), png);
  console.log(`postclip-screen.png: ${side} x ${side}; actual application with fictional sample`);
  wc.debugger.detach();
}

require('../app/main.cjs');
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
