'use strict';
const { app, BrowserWindow, session, dialog } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const project = path.resolve(process.env.POSTCLIP_TEST_ROOT || path.join(__dirname, '..'));
const baseline = process.env.POSTCLIP_EXPECT_V113 === '1';
const id = '2108290974980128891';
const url = `https://x.com/Chvm247376/status/${id}`;
const out = path.resolve(__dirname, '../qa');
app.setPath('userData', fsSync.mkdtempSync(path.join(os.tmpdir(), 'postclip-open-flow-')));
fsSync.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ settingsVersion: baseline ? 2 : 3, width: 430, scale: 3, conversation: 'none', mode: 'embed', includeNotes: false }));
app.getVersion = () => JSON.parse(fsSync.readFileSync(path.join(project, 'package.json'))).version;
app.requestSingleInstanceLock = () => true;

// 実UIの状態を待ち、失敗を無期限に待たない。
async function wait(check, message, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}

// 専用ボタンを使わず、利用者と同じ通常の「画像を作成」を押す。
async function submit(wc) {
  await wc.executeJavaScript('document.getElementById("capture-button").click()');
  await wait(() => wc.executeJavaScript('!document.body.classList.contains("busy")'), '通常の作成が終了しない');
}

// 埋め込みは失敗するが開いた画面には本文がある、報告された操作条件を再現する。
async function run() {
  await fs.mkdir(out, { recursive: true });
  let main;
  await wait(() => { main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/ui/index.html')); return !!main; }, 'メイン画面が開かない');
  const wc = main.webContents;
  await wait(() => wc.executeJavaScript(`document.getElementById('version').textContent === ${JSON.stringify(app.getVersion())}`), '初期化が終わらない');
  const sample = (await fs.readFile(path.join(__dirname, 'fixtures/sample.html'), 'utf8'))
    .replace('https://x.com/postclip_sample/status/200', url)
    .replace('</article>', '<div data-testid="birdwatch-pivot"><span>Readers added context</span><p>架空の検証用ノートです。通常ボタンからも保持します。</p></div></article>');
  let embedRequests = 0, pageRequests = 0, failReload = false;
  session.fromPartition('postclip-embed').protocol.handle('https', () => {
    embedRequests++;
    return new Response('window.twttr={widgets:{createTweet:async()=>undefined}};', { headers: { 'content-type': 'application/javascript' } });
  });
  session.fromPartition('persist:postclip-x').protocol.handle('https', () => {
    pageRequests++;
    return new Response(failReload ? '<meta charset="utf-8"><p>このポストはXアプリでのみ表示できます</p>' : sample, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
  await wc.executeJavaScript(`document.getElementById('url').value=${JSON.stringify(url)}`);
  await submit(wc);
  assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'), true);
  assert.equal(await wc.executeJavaScript('document.getElementById("recovery-actions").hidden'), baseline, '埋め込み失敗でも対処ボタンを表示する');
  if (!baseline) assert.equal(await wc.executeJavaScript('document.querySelectorAll("#recovery-actions button").length'), 1);
  await fs.writeFile(path.join(out, `flow-error-${app.getVersion()}.png`), (await wc.capturePage()).toPNG());
  await wc.executeJavaScript('document.getElementById("advanced").open=true;document.getElementById("open-x").click()');
  let xWindow;
  await wait(() => { xWindow = BrowserWindow.getAllWindows().find(w => w !== main && w.webContents.getURL().includes(id)); return !!xWindow; }, 'X画面が開かない');
  await wait(() => xWindow.webContents.executeJavaScript('!!document.querySelector("article")'), 'X画面に本文が表示されない');
  failReload = true;
  const before = { embedRequests, pageRequests };
  await submit(wc);
  if (baseline) {
    assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'), true);
    assert.equal(await wc.executeJavaScript('document.getElementById("recovery-actions").hidden'), true);
    assert.ok(embedRequests > before.embedRequests);
    assert.equal(await xWindow.webContents.executeJavaScript('!!document.querySelector("article")'), true);
    console.log('V113_REPRODUCED: source article visible, notes off, normal button retries failed embed, PNG unavailable, recovery buttons hidden');
    return;
  }
  assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'), false);
  assert.equal(await wc.executeJavaScript('document.getElementById("includeNotes").checked'), false);
  assert.deepEqual({ embedRequests, pageRequests }, before, '表示済みの同じ投稿は埋め込み・投稿ページへ再アクセスしない');
  assert.ok((await wc.executeJavaScript('document.getElementById("status").textContent')).startsWith('開いているX画面から作成しました。'));
  assert.equal(await wc.executeJavaScript('document.getElementById("result-image").naturalWidth'), 1290);
  const file = path.join(out, 'flow-off-saved.png');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  await wc.executeJavaScript('document.getElementById("download").click()');
  await wait(() => fsSync.existsSync(file), 'PNGが保存されない');
  assert.equal((await fs.readFile(file)).toString('base64'), (await wc.executeJavaScript('document.getElementById("result-image").src')).split(',')[1]);
  await fs.writeFile(path.join(out, 'flow-normal-button-success.png'), (await wc.capturePage()).toPNG());
  // ノートオンでも、同じ通常ボタンと同じ表示済み画面から撮影する。
  await wc.executeJavaScript('document.getElementById("includeNotes").click()');
  await submit(wc);
  assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'), false);
  assert.equal(await wc.executeJavaScript('document.getElementById("preview-heading").textContent'), 'コミュニティノートを含めて作成しました');
  assert.deepEqual({ embedRequests, pageRequests }, before);
  // 別投稿のX画面を使わず、失敗後にも対処ボタンを残す。
  failReload = false;
  await xWindow.webContents.loadURL('https://x.com/other/status/777');
  await wc.executeJavaScript('document.getElementById("includeNotes").click()');
  await submit(wc);
  assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'), true);
  assert.equal(await wc.executeJavaScript('document.getElementById("recovery-actions").hidden'), false);
  console.log('OPEN_FLOW_PASS: notes off/on, normal create button, 1290px PNG, saved bytes, no reload, no extra embed request, mismatched source rejected, recovery stays visible');
}
require(path.join(project, 'app/main.cjs'));
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
