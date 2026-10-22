'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(process.env.POSTCLIP_TEST_ROOT || path.join(__dirname, '..'));
const { capturePost } = require(path.join(root, 'app/capture.cjs'));
const core = require(path.join(root, 'app/core.cjs'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'postclip-reflow-quote-')));
app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../qa');
const post = core.parsePostUrl('https://x.com/sample/status/200');
const quoteText = 'これは引用の折り返しを確認するための架空の文章です。元の広い画面には収まる長さですが、スマートフォンの幅にすると行数が増えます。本文の途中が隠れないこと、最後の段落まで画像に残ることを確認します。元の表示に行数制限があっても、撮影前に表示できている文字は全部保存する必要があります。画像の幅を変えても、引用の意味や順番は変えません。最後の一文まで読めることを、表示領域の高さと完成した画像の両方で確かめます。QUOTE END';
let scenario = 'click', quoteLoads = 0;

// HTMLに投稿URLがなく、クリックでだけ開く省略引用を再現する。
function fixture(id, embedded = false) {
  const lines = 2;
  const destination = scenario === 'wrong' ? 'https://x.com/quoted/status/400' : 'https://x.com/quoted/status/300';
  const click = scenario === 'stuck' ? '' : scenario === 'spa' ? `history.pushState({},'', '${destination}')` : `location.href='${destination}'`;
  const quoteLink = scenario === 'real-clipped-linked' ? '<a href="https://x.com/quoted/status/300"><span>引用の時刻</span></a>' : '';
  const body = id === '100' ? `親の本文です。PARENT END<div role="link" class="quote" onclick="${click}"><b>引用した投稿</b>${quoteLink}<div data-testid="tweetText" data-quote-body>${quoteText.slice(0,160)}…</div></div>` : id === '300' ? quoteText : id === '400' ? '別の投稿の本文です。WRONG END' : '指定した投稿の本文です。TARGET END';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#182b24;font-family:sans-serif}main{width:700px}article{padding:16px;box-sizing:border-box}[data-testid=tweetText]{font-size:17px;line-height:25px;white-space:pre-wrap;overflow-wrap:break-word}.quote{margin-top:12px;padding:12px;border:1px solid #ccd;border-radius:16px}.quote [data-testid=tweetText]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden}footer{margin-top:12px}</style><body><main><article><header>投稿者 ${id}</header><a href="https://x.com/sample/status/${id}"><time>2026-10-21</time></a>${embedded && id === '200' ? '<a href="https://x.com/sample/status/100">返信先: @sample</a>' : ''}<div data-testid="tweetText">${id === '100' ? '親の本文です。PARENT END' : body}</div>${id === '100' ? body.slice(body.indexOf('<div')) : ''}<footer>FOOTER ${id}</footer></article></main></body></html>`;
}

// 返信関係と投稿ページを架空の固定URLで用意する。
async function fixtures() {
  for (const name of ['persist:postclip-x', 'postclip-embed']) await session.fromPartition(name).protocol.handle('https', request => {
    const u = new URL(request.url);
    if (u.pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount)=>{const f=document.createElement('iframe');f.src='https://platform.twitter.com/fixture/'+id;mount.append(f);await new Promise(r=>f.onload=r);return f;}}};`, { headers: { 'content-type': 'application/javascript' } });
    const id = u.pathname.split('/').pop();assert.ok(['100','200','300','400'].includes(id));
    if (id === '300') quoteLoads++;
    return new Response(fixture(id, u.hostname === 'platform.twitter.com'), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
}

// 親と引用を含む完成画像で、末尾・折り返し・並び順を確認する。
async function capture(width) {
  const job = { cancelled: false };let evidence;
  const result = await capturePost(post, core.validateOptions({ width, scale: 3, conversation: 'thread', mode: 'page', includeNotes: false }), job, (_m, percent) => {
    if (percent === 88) evidence = job.window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#postclip-capture'),q=r.querySelector('[data-quote-body]');return {text:r.innerText,ids:[...r.querySelectorAll('[data-postclip-id]')].map(n=>n.dataset.postclipId),quoteText:q.textContent,quoteHeight:q.clientHeight,quoteScrollHeight:q.scrollHeight,width:r.clientWidth,scrollWidth:r.scrollWidth}})()`);
  });
  const proof = await evidence;
  assert.deepEqual(proof.ids, ['100','200']);assert.equal(proof.quoteText, quoteText);
  for (const marker of ['PARENT END','QUOTE END','TARGET END']) assert.ok(proof.text.includes(marker));
  assert.ok(proof.quoteHeight >= proof.quoteScrollHeight - 2);assert.ok(proof.scrollWidth <= proof.width + 1);
  assert.equal(result.width, width * 3);assert.deepEqual(result.warnings, []);
  fs.writeFileSync(path.join(out, `quote-navigation-${scenario}-${width}.png`), result.png);
  console.log('REFLOW_CAPTURE_PASS', width, result.width, result.height);
}

// 通常遷移とSPAの引用を取得し、違う本文や開かない引用は成功にしない。
async function run() {
  fs.mkdirSync(out,{recursive:true});await fixtures();
  if (process.env.POSTCLIP_EXPECT_V1110_FAILURE) {
    await assert.rejects(() => capture(430), /投稿ID 100.*表示枠で切れている本文 1件/);
    console.log('V1110_QUOTE_WITHOUT_HREF_REPRODUCED');return;
  }
  for(const name of ['click','spa']) {scenario=name;const before=quoteLoads;await capture(430);assert.ok(quoteLoads>before);console.log('QUOTE_NAVIGATION_PASS',name);}
  scenario='wrong';await assert.rejects(()=>capture(430),/引用元の本文が元の表示と一致しません/);
  scenario='stuck';await assert.rejects(()=>capture(430),/引用カードを開いても/);
  console.log('QUOTE_NAVIGATION_FAILURES_PASS: mismatched content and inactive card rejected');
}
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1)});
