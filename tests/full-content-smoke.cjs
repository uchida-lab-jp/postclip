'use strict';
const { app, BrowserWindow, session, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { capturePost, snapshotOpenPage, expression } = require('../app/capture.cjs');
const scripts = require('../app/page-scripts.cjs');
const contentScripts = require('../app/content-scripts.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'postclip-full-content-')));
app.on('window-all-closed', () => {});
const post = parsePostUrl('https://x.com/sample/status/200');
const options = validateOptions({ mode: 'auto', conversation: 'parent', width: 430, scale: 2, includeNotes: false });
const out = path.resolve(__dirname, '../qa');
let scenario = 'card', pageRequests = 0, grokRequests = 0, externalRequests = 0;

// 新旧の本文、返信先の引用、Grokカードを同時に省略した架空投稿を作る。
function fixture() {
  const stuck = scenario === 'stuck';
  const quoteLink = scenario === 'quote-link';
  const quoteButton = quoteLink ? '<a href="/quoted/status/300" data-testid="tweet-text-show-more-link">さらに表示</a>' : `<button onclick="this.parentElement.innerHTML='引用の前半。引用の後半まで取得しました。QUOTE END'">さらに表示</button>`;
  const parent = `<article><a href="/parent/status/100"><time>親の時刻</time></a><div dir="auto" class="whitespace-pre-wrap">返信先の本文。PARENT END</div><div role="link" data-href="/quoted/status/300"><article><a href="/quoted/status/300"><time>引用時刻</time></a><div dir="auto" class="whitespace-pre-wrap">引用の前半。${quoteButton}</div></article></div><button aria-haspopup="menu" aria-label="もっと見る" onclick="window.menuOpened=true">もっと見る</button></article>`;
  const more = `<button data-testid="tweet-text-show-more-link" ${stuck ? '' : 'onclick="document.querySelector(\'#main-text\').textContent=\'本文の前半。本文の後半。MAIN END。本文中の「さらに表示」「もっと見る」「Show more」は省略ではない。\';this.remove()"'}>もっと見る</button>`;
  const grok = scenario === 'metadata' || scenario === 'external' ? '' : scenario === 'no-card-link' ? '<div data-testid="card.wrapper"><b>Grokによる回答</b><p>回答の最初だけ…</p></div>' : `<div data-testid="card.wrapper"><a href="https://t.co/SharedGrok"><b>長い質問の先頭…</b><div>Grokによる回答</div><p>回答の最初だけ…</p><span>さらに表示</span></a></div>`;
  const description = scenario === 'external' ? 'https://t.co/External' : 'https://t.co/SharedGrok';
  const target = `<article><a href="/sample/status/200"><time>主投稿の時刻</time></a><div id="main-text" data-testid="tweetText">本文の前半。</div>${more}${grok}<footer>POST FOOTER</footer></article>`;
  const clipped = scenario === 'clipped' ? '<div data-testid="tweetText" style="max-height:12px;overflow:hidden">CSSで切られた本文。<br>CLIPPED END</div>' : '';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta property="og:url" content="${post.url}"><meta property="og:description" content="${description}"><style>body{margin:0;font-family:sans-serif;color:#123;background:white}article{padding:14px;line-height:1.7;border-bottom:1px solid #ccd}[role=link]{border:1px solid #ddd;padding:8px}.whitespace-pre-wrap{white-space:pre-wrap}[data-testid="card.wrapper"]{border:1px solid #ccc;border-radius:12px;padding:12px}button,a{color:#168bd2}footer{margin-top:20px}</style><body>${parent}${target.replace('</footer>', '</footer>'+clipped)}<article><a href="/reply/status/999"><time>返信</time></a><button onclick="window.replyClicked=true">さらに表示</button>UNRELATED REPLY</article></body></html>`;
}

// 共有ページの質問と長い回答、末尾の文章を別々に用意する。
function grokFixture() {
  const paragraphs = Array.from({ length: 16 }, (_, i) => `<p>回答の段落 ${i + 1}。ここに省略されていた回答本文があります。元の文章を変えず、画像の下端まで取得する確認です。</p>`).join('');
  return `<!doctype html><meta charset="utf-8"><main><h2>Grok Conversation</h2><h1>架空の共有回答</h1><div><div class="whitespace-pre-wrap">Grokに尋ねた長い質問も最後まで表示します。QUESTION END</div><div>${paragraphs}<h3 data-streamdown="heading-3">最後の見出し</h3><p>これが回答の最後の文章です。GROK END</p><script>window.unsafe=true</script><button>コピー</button></div></div></main>`;
}

// 実際の表示・短縮URL転送・別ページ取得を専用セッションで再現する。
async function installFixtures() {
  await session.fromPartition('postclip-embed').protocol.handle('https', request => {
    if (new URL(request.url).pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount,opts)=>{const frame=document.createElement('iframe');frame.src='https://platform.twitter.com/fixture';mount.append(frame);await new Promise(r=>frame.onload=r);return frame;}}};`, { headers: { 'content-type': 'application/javascript' } });
    return new Response(fixture(), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
  for (const name of ['persist:postclip-x', 'postclip-public']) await session.fromPartition(name).protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.hostname === 't.co') {
      if (scenario === 'metadata') return new Response('<head><noscript><META http-equiv="refresh" content="0;URL=https://x.com/i/grok/share/test-public-response"></noscript></head><script>location.replace("https://example.com/do-not-open")</script>', { headers: { 'content-type': 'text/html' } });
      return new Response(null, { status: 302, headers: { location: url.pathname === '/External' ? 'https://example.com/private' : 'https://x.com/i/grok/share/test-public-response' } });
    }
    if (url.hostname !== 'x.com') { externalRequests++; return new Response('unexpected'); }
    if (url.pathname.startsWith('/i/grok/share/')) { grokRequests++; return new Response(scenario === 'grok-failed' ? '<main>回答を表示できません</main>' : grokFixture(), { headers: { 'content-type': 'text/html;charset=utf-8' } }); }
    if (url.pathname === '/quoted/status/300') return new Response('<!doctype html><meta charset="utf-8"><article><a href="/quoted/status/300"><time>時刻</time></a><div data-testid="tweetText">引用の前半。引用の後半まで取得しました。QUOTE END</div></article>', { headers: { 'content-type': 'text/html;charset=utf-8' } });
    pageRequests++;
    return new Response(fixture(), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
}

// 完成PNGの内容と末尾の描画を、表示済み画面からの作成も含めて検証する。
async function verifyCapture(name, useOpenPage) {
  scenario = name;
  const source = useOpenPage ? new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }) : null;
  const job = { cancelled: false };
  let before;
  try {
    if (source) {
      await source.loadURL(post.url);
      await source.webContents.executeJavaScript(expression(scripts.inspectPost, post.id));
      const oldPath = path.join(out, 'page-scripts-v115.cjs');
      if (fs.existsSync(oldPath) && name === 'card') {
        const old = require(oldPath);
        await source.webContents.executeJavaScript(expression(old.expandPost, post.id));
        const remaining = await source.webContents.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, options.conversation));
        assert.ok(remaining.controls.length > 0, '旧版が返信先の引用を省略したままにする不具合を再現');
      }
      before = pageRequests;
      job.openPageSnapshot = await snapshotOpenPage(source.webContents, post, options, job);
      assert.ok(await source.webContents.executeJavaScript('!!document.querySelector("[data-postclip-full-resource]")?.textContent.includes("GROK END")'), '表示中のGrokカードも全文へ展開する');
    }
    let evidence;
    const result = await capturePost(post, name === 'embed-fallback' ? { ...options, mode: 'embed' } : options, job, (_message, percent) => {
      if (percent === 88) evidence = job.window.webContents.executeJavaScript('({text:document.querySelector("#postclip-capture").innerText,html:document.querySelector("#postclip-capture").outerHTML,menu:window.menuOpened,reply:window.replyClicked})');
    });
    const captured = await evidence;
    for (const ending of ['MAIN END', 'PARENT END', 'QUOTE END', 'QUESTION END', 'GROK END']) assert.ok(captured.text.includes(ending), ending);
    assert.ok(!captured.text.includes('UNRELATED REPLY'));
    assert.ok(!captured.html.includes('<script'));
    assert.ok(!captured.text.includes('回答の最初だけ…'), '省略カードは全文へ置き換える');
    assert.equal(captured.menu, undefined);
    assert.equal(captured.reply, undefined);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.width, 860);
    assert.ok(result.height > 3000);
    if (source) assert.equal(pageRequests, before, '表示済み投稿を再読込しない');
    const bitmap = nativeImage.createFromBuffer(result.png).crop({ x: 0, y: result.height - 350, width: result.width, height: 350 }).toBitmap();
    assert.ok([...bitmap].some((b, i) => i % 4 !== 3 && b < 120), '下端も実際に描画されている');
    fs.writeFileSync(path.join(out, `full-${name}.png`), result.png);
    console.log(`FULL_CASE_PASS ${name}: ${result.width} x ${result.height}`);
  } finally { source?.destroy(); }
}

// 成功・取得失敗・CSSの切れ・外部転送・キャンセルを実際の撮影処理で確認する。
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await installFixtures();
  await verifyCapture('card', true);
  await verifyCapture('metadata', false);
  await verifyCapture('quote-link', false);
  await verifyCapture('no-card-link', false);
  await verifyCapture('embed-fallback', false);
  scenario = 'stuck';
  await assert.rejects(() => capturePost(post, options, { cancelled: false }, () => {}), /さらに表示|全文/);
  scenario = 'clipped';
  await assert.rejects(() => capturePost(post, options, { cancelled: false }, () => {}), /全文表示/);
  scenario = 'grok-failed';
  await assert.rejects(() => capturePost(post, options, { cancelled: false }, () => {}), /Grok回答の全文/);
  scenario = 'external';
  await capturePost(post, options, { cancelled: false }, () => {});
  assert.equal(externalRequests, 0, '短縮URLの外部転送先には通信しない');
  scenario = 'grok-failed';
  const before = grokRequests;
  const job = { cancelled: false };
  const promise = capturePost(post, options, job, () => {});
  const timer = setInterval(() => { if (grokRequests > before) { job.cancelled = true; job.window?.destroy(); clearInterval(timer); } }, 50);
  await assert.rejects(() => promise, /キャンセル/);
  clearInterval(timer);
  assert.equal(job.contentCleanups.size, 0, '補助画面も閉じる');
  console.log('FULL_CONTENT_PASS: quoted text, parent, Grok full answer, metadata fallback, no false warning, fail closed, external redirect rejected, cancellation');
}
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
