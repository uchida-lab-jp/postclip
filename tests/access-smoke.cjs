'use strict';
const { app, session, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { capturePost, snapshotOpenPage, expression } = require('../app/capture.cjs');
const scripts = require('../app/page-scripts.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.setPath('userData', fsSync.mkdtempSync(path.join(os.tmpdir(), 'postclip-access-')));
app.on('window-all-closed', () => {});
const post = parsePostUrl('https://x.com/demo/status/2108290974980128891');
const options = validateOptions({ width: 430, conversation: 'none', includeNotes: true });
const gate = '<main><h2>センシティブな内容</h2><p>このポストはXアプリでのみ表示できます</p><p>スキャンしてアプリを入手</p></main><aside><h2>Xにログインまたは登録してください</h2><a href="/i/jf/onboarding/web?mode=login">ユーザー名またはメールアドレスでログインしてください</a></aside>';

// 実ページで観測した制限文と、手動表示した架空記事を分けて再現する。
function fixture(content) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#15202b;font-family:sans-serif}article{padding:18px;box-sizing:border-box;font-size:18px;line-height:1.8}a{color:#167abc}.note{margin:12px 0;padding:14px;border:1px solid #aaa;border-radius:12px}</style><body>${content}</body></html>`;
}

// センシティブ・ログインという文字を含む本文でも通常記事として扱う。
function article(id = post.id) {
  return `<div data-timeline-entry><article><div data-testid="tweetText">架空の投稿です。本文に「センシティブな内容」「このポストは表示できません」「ログイン」があっても撮影できます。</div><div role="link"><article><a href="/other/status/99"><time>引用</time></a>このポストはXアプリでのみ表示できます</article></div><div class="note" data-testid="birdwatch-pivot"><span>Readers added context</span><p>架空のノート本文です。背景情報と出典を一緒に保存します。</p><a href="https://x.com/i/birdwatch/n/123">ノート詳細</a></div><a href="/demo/status/${id}"><time>2026年10月10日</time></a><footer>TARGET END</footer></article></div>`;
}

// 制限・新旧ログイン・表示済みDOMの撮影を、製品と同じElectron経路で検証する。
async function run() {
  const out = path.resolve(__dirname, '../qa');
  await fs.mkdir(out, { recursive: true });
  let content = gate, loads = 0;
  session.fromPartition('persist:postclip-x').protocol.handle('https', () => {
    loads++;
    return new Response(fixture(content), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
  const start = Date.now();
  await assert.rejects(capturePost(post, options, { cancelled: false }, () => {}), error => error.code === 'app-only' && error.recovery && !error.message.includes('かんたんモード'));
  assert.ok(Date.now() - start < 10000, '既知の制限画面で45秒のタイムアウトを待たない');
  const source = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = source.webContents;
  for (const [body, reason] of [
    ['<h2>Xにログインしてください</h2><a href="/i/jf/onboarding/web?mode=login">ログイン</a>', 'login'],
    ['<h2>Log in to X</h2><a href="/i/flow/login">Log in</a>', 'login'],
    ['<h2>Sensitive content</h2><p>This post can only be viewed in the X app</p>', 'app-only'],
    ['<h2>このポストは表示できません</h2>', 'unavailable'],
    ['<h2>センシティブな内容</h2><button>表示する</button>', 'sensitive'],
    [article('777') + gate, 'app-only']
  ]) {
    content = body;
    await wc.loadURL(post.url);
    assert.equal((await wc.executeJavaScript(expression(scripts.inspectPost, post.id))).reason, reason);
  }
  content = article();
  await wc.loadURL(post.url);
  assert.equal((await wc.executeJavaScript(expression(scripts.inspectPost, post.id))).found, true);
  // 再読込したら制限画面へ戻る状況を再現し、画面にある記事から作れることを検証する。
  content = gate;
  const before = loads;
  const job = { cancelled: false };
  job.openPageSnapshot = await snapshotOpenPage(wc, post, options, job);
  assert.equal(await wc.executeJavaScript('!!document.querySelector("#postclip-capture")'), false, '元のX画面は切り抜かない');
  let captured;
  const result = await capturePost(post, options, job, (_m, percent) => {
    if (percent === 88) captured = job.window.webContents.executeJavaScript('document.querySelector("#postclip-capture").innerText');
  });
  assert.equal(loads, before, '開いた画面からの撮影では投稿URLを再読込しない');
  assert.equal(result.width, 1290);
  assert.equal(result.notesIncluded, true);
  assert.equal(result.notesStatus, 'included');
  assert.ok((await captured).includes('TARGET END'));
  assert.ok(!(await captured).includes('スキャンしてアプリを入手'));
  await fs.writeFile(path.join(out, 'access-open-page.png'), result.png);
  await assert.rejects(snapshotOpenPage(wc, parsePostUrl('https://x.com/demo/status/777'), options, { cancelled: false }), /別の投稿/);
  await assert.rejects(snapshotOpenPage(wc, post, { ...options, conversation: 'thread' }, { cancelled: false }), /この投稿のみ/);
  await assert.rejects(snapshotOpenPage(null, post, options, { cancelled: false }), /先に/);
  const cancelled = { cancelled: true };
  await assert.rejects(snapshotOpenPage(wc, post, options, cancelled), /キャンセル/);
  source.destroy();
  console.log('ACCESS_PASS: app-only gate, modern/legacy login, unrelated articles, no text false positive, no reload, correct target, notes, 1290px PNG, cancellation');
}
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
