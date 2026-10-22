'use strict';
const { app, session, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { capturePost, snapshotOpenPage } = require('../app/capture.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'postclip-legacy-thread-')));
app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../qa');
const post = parsePostUrl('https://x.com/sample/status/200');
const options = validateOptions({ conversation: 'thread', mode: 'page', width: 430, scale: 3, includeNotes: false, padding: 0 });
let scenario = 'card', targetLoads = 0;

// 旧画面型の本文入りGrokカードと、ボタンを持たない引用の省略を再現する。
function fixture(id, embed) {
  const quote = scenario === 'quote' ? '<div role="link" data-href="/quoted/status/300"><a href="/quoted/status/300"><time>引用時刻</time></a><div data-testid="tweetText" style="overflow:hidden;max-height:40px">引用の前半。<br>引用はここから続きます。<br>さらに続きます。</div><span>さらに表示</span></div>' : '';
  const card = `<div ${scenario === 'wrapper' ? 'data-testid="card.wrapper"' : 'class="answer-card"'}><strong>質問の先頭だけ…</strong><div>Grokによる回答</div><span>71 ウェブページ</span><div data-testid="tweetText" style="overflow:hidden;max-height:60px">回答の先頭だけ。<br>回答のプレビューです。<br>回答の途中で省略されています。<br>まだ続きます。</div><span>さらに表示</span>${scenario === 'wrapper' ? '<a href="https://t.co/SharedGrok">回答を開く</a>' : ''}</div>`;
  const text = id === '100' ? '親の本文。PARENT END' : id === '300' ? '引用の前半。\n引用はここから続きます。\nさらに続きます。\n省略の後半も取得。QUOTE END' : '主投稿の本文。TARGET END';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta property="og:url" content="https://x.com/sample/status/${id}"><meta property="og:description" content="${id === '200' ? 'https://t.co/SharedGrok' : ''}"><style>body{margin:0;font-family:sans-serif;color:#182b24;background:white}article{padding:16px;box-sizing:border-box}a{color:#1588cc}[data-testid=tweetText]{line-height:24px;white-space:pre-wrap}.answer-card,[data-testid="card.wrapper"],[role=link]{border:1px solid #ccd;border-radius:16px;padding:16px;margin:12px 0}</style><body><svg style="position:absolute;width:0;height:0"><defs><symbol id="test-badge" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1888ee"/></symbol></defs></svg><div data-testid="cellInnerDiv"><article><header>投稿者 ${id}<svg width="18" height="18" viewBox="0 0 24 24"><use href="#test-badge"/></svg></header><a href="https://x.com/sample/status/${id}"><time>2026-10-21</time></a>${embed && id === '200' ? '<a href="https://x.com/sample/status/100">返信先: @sample</a>' : ''}<div data-testid="tweetText">${text}</div>${id === '100' ? quote : id === '200' ? card : ''}<footer>FOOTER ${id}</footer></article></div></body></html>`;
}

// 実ネットワークへ接続せず、公式埋め込み・元投稿・共有回答を別URLで用意する。
async function fixtures() {
  for (const name of ['persist:postclip-x', 'postclip-embed', 'postclip-public']) await session.fromPartition(name).protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount)=>{const f=document.createElement('iframe');f.src='https://platform.twitter.com/fixture/'+id;mount.append(f);await new Promise(r=>f.onload=r);return f;}}};`, { headers: { 'content-type': 'application/javascript' } });
    if (url.hostname === 't.co') return new Response(null, { status: 302, headers: { location: 'https://x.com/i/grok/share/full-response' } });
    if (url.pathname === '/i/grok/share/full-response') return new Response('<!doctype html><meta charset="utf-8"><main><h1>Grok回答</h1><div><div class="whitespace-pre-wrap">省略されていた質問の全文。QUESTION END</div><div><p>' + '回答の全段落を保存します。'.repeat(80) + '</p><p>回答の最終段落。GROK END</p></div></div></main>', { headers: { 'content-type': 'text/html;charset=utf-8' } });
    const id = url.pathname.split('/').pop();
    assert.ok(['100', '200', '300'].includes(id));
    if (id === '200' && url.hostname === 'x.com') targetLoads++;
    return new Response(fixture(id, url.hostname === 'platform.twitter.com'), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
}

// 全親設定で本文・引用・質問・回答の末尾と、古いプレビューの除去を検証する。
async function check(name, opened = false) {
  scenario = name;
  const job = { cancelled: false };
  let source, before, evidence;
  try {
    if (opened) {
      source = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await source.loadURL(post.url); before = targetLoads;
      job.openPageSnapshot = await snapshotOpenPage(source.webContents, post, options, job);
    }
    const result = await capturePost(post, options, job, (_m, percent) => {
      if (percent === 88) evidence = job.window.webContents.executeJavaScript(`({text:document.querySelector('#postclip-capture').innerText,ids:[...document.querySelectorAll('[data-postclip-id]')].map(n=>n.dataset.postclipId),missingSymbols:[...document.querySelectorAll('#postclip-capture use')].filter(n=>!document.getElementById(n.getAttribute('href').slice(1))).length,cards:document.querySelectorAll('[data-postclip-full-resource]').length})`);
    });
    const proof = await evidence;
    for (const tail of ['PARENT END', 'TARGET END', 'QUESTION END', 'GROK END']) assert.ok(proof.text.includes(tail), tail);
    if (name === 'quote') assert.ok(proof.text.includes('QUOTE END'));
    assert.ok(!proof.text.includes('回答の先頭だけ'));
    assert.ok(!proof.text.includes('さらに表示'));
    assert.deepEqual(proof.ids, ['100', '200']);
    assert.equal(proof.cards, 1);
    assert.equal(proof.missingSymbols, 0, 'スレッド内のアイコン参照先を保持');
    assert.equal(result.width, 1290);
    assert.deepEqual(result.warnings, []);
    if (opened) assert.equal(targetLoads, before, '全親設定でも開いた主投稿を再読込しない');
    fs.writeFileSync(path.join(out, `legacy-${name}${opened ? '-open' : ''}.png`), result.png);
    console.log('LEGACY_THREAD_PASS', name, opened ? 'open' : 'normal', result.width, result.height);
  } finally { source?.destroy(); }
}

// 修正前の失敗を固定し、同じ条件を通常作成と表示済み画面で再検証する。
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await fixtures();
  if (process.env.POSTCLIP_EXPECT_OLD_FAILURE) {
    await assert.rejects(() => check('card'), /本文・返信先・引用の全文表示を確認できませんでした/);
    console.log('V116_FAILURE_REPRODUCED: unrecognized Grok preview remains after full answer insertion');
    return;
  }
  await check('card');
  await check('wrapper');
  await check('quote');
  await check('card', true);
}
if (process.argv.some(argument => path.resolve(argument) === __filename)) app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
// 実UIの回帰テストでも同じ再現ページと読込回数を使う。
module.exports = { fixtures, targetLoadCount: () => targetLoads };
