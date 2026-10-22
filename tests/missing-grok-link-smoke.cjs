'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { capturePost, snapshotOpenPage } = require('../app/capture.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'postclip-missing-grok-')));
app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../qa');
const post = parsePostUrl('https://x.com/sample/status/200');
const question = '架空の長い質問を省略せず全部保存できますか。QUESTION END';
const answer = 'はい、質問も回答も全部保存します。元のプレビューにはない続きも確認します。';
const options = validateOptions({ conversation: 'thread', mode: 'page', width: 430, scale: 3, includeNotes: false });
let scenario = 'normal', sourceLoads = 0, publicLoads = 0, shareLoads = 0, externalLoads = 0;

// リンクとOGメタデータが一切ない、ログイン画面型のGrokカードを再現する。
function sourcePage(id, embed = false) {
  const card = `<div class="card"><strong>${question.slice(0, 22)}…</strong><div>Grokによる回答</div><span>71 ウェブページ</span><div data-testid="tweetText" style="max-height:48px;overflow:hidden">${answer}<br>回答はまだ続きます。</div><button onclick="window.previewClicked=true">さらに表示</button></div>`;
  const runtime = id === '200' && scenario.startsWith('runtime') ? `<script>document.querySelector('.card').__reactProps$fixture={card:{links:${JSON.stringify(scenario === 'runtime-multiple' ? ['https://x.com/i/grok/share/other', 'https://x.com/i/grok/share/full-response'] : ['https://x.com/i/grok/share/full-response'])}},_owner:{secret:'https://x.com/i/grok/share/wrong-owner'}};</script>` : '';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{margin:0;color:#172d24;background:white;font-family:sans-serif}article{padding:16px;border-bottom:1px solid #ccd;box-sizing:border-box}[data-testid=tweetText]{line-height:24px;white-space:pre-wrap}.card{margin:12px 0;padding:16px;border:1px solid #ccd;border-radius:16px}</style><body><article><header>投稿者 ${id}</header><a href="https://x.com/sample/status/${id}"><time>2026-10-21</time></a>${embed && id === '200' ? '<a href="https://x.com/sample/status/100">返信先: @sample</a>' : ''}<div data-testid="tweetText">${id === '100' ? '親の本文。PARENT END' : '指定投稿の本文。TARGET END'}</div>${id === '200' ? card : ''}<footer>FOOTER ${id}</footer></article>${runtime}</body></html>`;
}

// 同じ投稿の公開表示には共有リンクがある状態を、ログイン側と別のセッションで用意する。
function publicPage() {
  if (scenario.startsWith('runtime')) throw new Error('カードの描画データで解決できる場合は公開表示を開かない');
  if (scenario === 'unavailable') return '<main>This Post is unavailable</main>';
  const id = scenario === 'wrong-post' ? '999' : '200';
  const description = scenario === 'external' ? 'https://t.co/External' : scenario === 'multiple' ? 'https://t.co/Other https://t.co/Shared' : 'https://t.co/Shared';
  const metadata = `<meta property="og:url" content="https://x.com/sample/status/${id}"><meta property="og:description" content="${description}">`;
  return `<!doctype html><meta charset="utf-8">${scenario === 'delayed' ? `<script>setTimeout(()=>document.head.insertAdjacentHTML('beforeend',${JSON.stringify(metadata)}),2200)</script>` : metadata}<article><a href="${post.url}"><time>時刻</time></a><div data-testid="tweetText">指定投稿の本文。TARGET END</div></article>`;
}

// 公開共有ページに質問と回答の最終段落を用意する。
function sharePage(other = false) {
  return `<!doctype html><meta charset="utf-8"><main><h1>共有回答</h1><div><div class="whitespace-pre-wrap">${other ? '別の質問です。選択してはいけません。' : question}</div><div><p>${other ? '別の回答です。選択してはいけません。' : answer}</p>${Array.from({ length: 12 }, (_, i) => `<p>回答の段落${i + 1}。省略されていた内容を最後まで保存します。</p>`).join('')}<p>${other ? 'WRONG ANSWER' : '回答の最終段落。GROK END'}</p></div></div></main>`;
}

// 専用セッションで通信を置換し、公開取得への認証情報の混入と外部転送も監視する。
async function fixtures() {
  for (const name of ['persist:postclip-x', 'postclip-embed', 'postclip-public']) {
    await session.fromPartition(name).protocol.handle('https', request => {
      const url = new URL(request.url);
      if (!['x.com', 'platform.twitter.com', 't.co'].includes(url.hostname)) { externalLoads++; return new Response('Unexpected destination'); }
      if (url.pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount)=>{const f=document.createElement('iframe');f.src='https://platform.twitter.com/fixture/'+id;mount.append(f);await new Promise(r=>f.onload=r);return f;}}};`, { headers: { 'content-type': 'application/javascript' } });
      if (url.hostname === 't.co') return new Response(null, { status: 302, headers: { location: url.pathname === '/External' ? 'https://example.com/do-not-open' : 'https://x.com/i/grok/share/' + (url.pathname === '/Other' ? 'other' : 'full-response') } });
      if (url.pathname.startsWith('/i/grok/share/')) {
        assert.equal(name, 'postclip-public', '共有先は公開セッションで読む');
        shareLoads++;
        return new Response(sharePage(url.pathname.endsWith('/other')), { headers: { 'content-type': 'text/html;charset=utf-8' } });
      }
      const id = url.pathname.split('/').pop();
      assert.ok(['100', '200'].includes(id));
      if (name === 'postclip-public') { publicLoads++; return new Response(publicPage(), { headers: { 'content-type': 'text/html;charset=utf-8' } }); }
      if (id === '200' && url.hostname === 'x.com') sourceLoads++;
      const html = sourcePage(id, url.hostname === 'platform.twitter.com');
      return new Response(scenario === 'no-time' ? html.replace('<time>2026-10-21</time>', '<span>2026-10-21</span>') : html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    });
  }
  await session.fromPartition('persist:postclip-x').cookies.set({ url: 'https://x.com', name: 'postclip-fixture-login', value: 'fictional-marker' });
}

// 表示済みの主投稿を保ち、先頭の親からGrok回答末尾まで実際のPNGへ保存する。
async function capture(name, opened = true) {
  scenario = name;
  const job = { cancelled: false };
  let source, evidence, before;
  try {
    if (opened) {
      source = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await source.loadURL(post.url); before = sourceLoads;
      job.openPageSnapshot = await snapshotOpenPage(source.webContents, post, options, job);
    }
    const result = await capturePost(post, options, job, (_message, percent) => {
      if (percent === 88) evidence = job.window.webContents.executeJavaScript(`({text:document.querySelector('#postclip-capture').innerText,cards:document.querySelectorAll('[data-postclip-full-resource]').length,ids:[...document.querySelectorAll('[data-postclip-id]')].map(n=>n.dataset.postclipId)})`);
    });
    const proof = await evidence;
    for (const text of ['PARENT END', 'TARGET END', question, answer, 'GROK END']) assert.ok(proof.text.includes(text), text);
    assert.ok(!/さらに表示|WRONG ANSWER/.test(proof.text));
    assert.equal(proof.cards, 1);
    assert.deepEqual(proof.ids, ['100', '200']);
    assert.equal(result.width, 1290);
    assert.deepEqual(result.warnings, []);
    if (source) {
      assert.equal(sourceLoads, before, 'ログイン側の主投稿を再読込しない');
      assert.equal(source.webContents.getURL(), post.url);
      assert.equal(await source.webContents.executeJavaScript('!!window.previewClicked'), false, '元の反応しないクリック処理には依存しない');
      assert.equal(await source.webContents.executeJavaScript('!!document.querySelector("[data-postclip-full-resource]")?.textContent.includes("GROK END")'), true, '表示中のカードにも全文を反映する');
    }
    assert.deepEqual(await session.fromPartition('postclip-public').cookies.get({ name: 'postclip-fixture-login' }), []);
    assert.equal(externalLoads, 0);
    fs.writeFileSync(path.join(out, `missing-link-${name}-${opened ? 'open' : 'normal'}.png`), result.png);
    console.log('MISSING_LINK_PASS', name, opened, result.width, result.height);
  } finally { source?.destroy(); }
}

// 1.1.7の停止を再現し、修正後はリンク欠落・誤対応・非公開・中断を検証する。
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await fixtures();
  if (process.env.POSTCLIP_EXPECT_V117_FAILURE) {
    // 旧版ではカード内ボタンの誤操作を避け、報告された共有URL欠落を直接再現する。
    const source = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await source.loadURL(post.url);
    await source.webContents.executeJavaScript('document.querySelector("button").outerHTML="<span>さらに表示</span>"');
    await assert.rejects(() => snapshotOpenPage(source.webContents, post, options, { cancelled: false }), /Grokカードは表示されていますが、共有URLを確認できません/);
    source.destroy(); console.log('V117_SHARED_URL_FAILURE_REPRODUCED'); return;
  }
  await capture('normal', true);
  await capture('normal', false);
  await capture('no-time', true);
  await capture('multiple', true);
  await capture('delayed', true);
  await capture('runtime', true);
  await capture('runtime-multiple', true);
  await assert.rejects(() => capture('wrong-post'), /共有|公開/);
  await assert.rejects(() => capture('unavailable'), /表示|取得|公開/);
  await assert.rejects(() => capture('external'), /共有|公開/);
  assert.equal(externalLoads, 0);
  scenario = 'normal';
  const before = publicLoads;
  const job = { cancelled: false };
  const pending = capturePost(post, options, job, () => {});
  const timer = setInterval(() => { if (publicLoads > before) { job.cancelled = true; job.abort?.(); job.window?.destroy(); clearInterval(timer); } }, 20);
  await assert.rejects(() => pending, /キャンセル/);
  clearInterval(timer);
  assert.equal(job.contentCleanups.size, 0);
  console.log('MISSING_LINK_FAILURE_CASES_PASS: wrong metadata, unavailable, external redirect, cancellation, no login-cookie copy');
}
if (process.argv.some(argument => path.resolve(argument) === __filename)) app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
// 実UIテストへ同じ再現ページと読込回数を渡す。
module.exports = { fixtures, sourcePage, question, answer, sourceLoadCount: () => sourceLoads, setScenario: value => { scenario = value; } };
