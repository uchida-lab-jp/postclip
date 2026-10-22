'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixtures, sourceLoadCount } = require('./missing-grok-link-smoke.cjs');
const url = 'https://x.com/sample/status/200';
const out = path.resolve(__dirname, '../qa');
app.requestSingleInstanceLock = () => true;
app.getVersion = () => require('../package.json').version;
fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ settingsVersion: 3, width: 430, scale: 3, conversation: 'thread', mode: 'page', includeNotes: false }));

// 画面の準備と処理終了を待ち、エラーを隠して待ち続けない。
async function wait(check, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('実UIの処理が完了しませんでした。');
}

// 全親設定で開いたX画面を通常ボタンから使い、PNG保存の実バイトまで照合する。
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await fixtures();
  const main = await wait(() => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/ui/index.html')));
  const wc = main.webContents;
  await wait(() => wc.executeJavaScript('!!document.getElementById("version").textContent'));
  await wc.executeJavaScript(`document.getElementById('url').value=${JSON.stringify(url)};document.getElementById('advanced').open=true;document.getElementById('open-x').click()`);
  const source = await wait(() => BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL() === url));
  await wait(() => source.webContents.executeJavaScript('!!document.querySelector("article")'));
  const before = sourceLoadCount();
  await wc.executeJavaScript('document.getElementById("capture-button").click()');
  await wait(() => wc.executeJavaScript('!document.body.classList.contains("busy")'));
  const state = await wc.executeJavaScript('({ok:!document.getElementById("download").disabled,status:document.getElementById("status").textContent,width:document.getElementById("result-image").naturalWidth,data:document.getElementById("result-image").src})');
  assert.ok(state.ok, state.status);
  assert.ok(state.status.startsWith('開いているX画面から作成しました。'));
  assert.equal(state.width, 1290);
  assert.equal(sourceLoadCount(), before);
  const file = path.join(out, 'missing-grok-link-ui-saved.png');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  const saved = await wc.executeJavaScript('window.postclip.save()');
  assert.equal(saved.ok, true);
  assert.equal(fs.readFileSync(file).toString('base64'), state.data.split(',')[1]);
  fs.writeFileSync(path.join(out, 'missing-grok-link-ui.png'), (await wc.capturePage()).toPNG());
  console.log('MISSING_GROK_LINK_UI_PASS: thread/page/430/3x/notes-off, open page reuse, PNG saved bytes match');
}
require('../app/main.cjs');
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
