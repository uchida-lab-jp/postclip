'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(process.env.POSTCLIP_TEST_ROOT || path.join(__dirname, '..'));
const { capturePost, expression } = require(path.join(root, 'app/capture.cjs'));
const scripts = require(path.join(root, 'app/page-scripts.cjs'));
const content = require(path.join(root, 'app/content-scripts.cjs'));
const core = require(path.join(root, 'app/core.cjs'));
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'postclip-reflow-quote-')));
app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../qa');
const post = core.parsePostUrl('https://x.com/sample/status/200');
const quoteText = 'これは引用の折り返しを確認するための架空の文章です。元の広い画面には収まる長さですが、スマートフォンの幅にすると行数が増えます。本文の途中が隠れないこと、最後の段落まで画像に残ることを確認します。元の表示に行数制限があっても、撮影前に表示できている文字は全部保存する必要があります。画像の幅を変えても、引用の意味や順番は変えません。最後の一文まで読めることを、表示領域の高さと完成した画像の両方で確かめます。QUOTE END';
let scenario = 'reflow', quoteLoads = 0;

// 広いX画面では全文が収まり、撮影幅へ切り出した時だけ行数制限にかかる引用を再現する。
function fixture(id, embedded = false) {
  const lines = scenario.startsWith('real-clipped') ? 2 : 7;
  const quoteLink = scenario === 'real-clipped-linked' ? '<a href="https://x.com/quoted/status/300"><span>引用の時刻</span></a>' : '';
  const body = id === '100' ? `親の本文です。PARENT END<div role="link" class="quote"><b>引用した投稿</b>${quoteLink}<div data-testid="tweetText" data-quote-body>${quoteText}</div></div>` : id === '300' ? quoteText : '指定した投稿の本文です。TARGET END';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#182b24;font-family:sans-serif}main{width:700px}article{padding:16px;box-sizing:border-box}[data-testid=tweetText]{font-size:17px;line-height:25px;white-space:pre-wrap;overflow-wrap:break-word}.quote{margin-top:12px;padding:12px;border:1px solid #ccd;border-radius:16px}.quote [data-testid=tweetText]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden}footer{margin-top:12px}</style><body><main><article><header>投稿者 ${id}</header><a href="https://x.com/sample/status/${id}"><time>2026-10-21</time></a>${embedded && id === '200' ? '<a href="https://x.com/sample/status/100">返信先: @sample</a>' : ''}<div data-testid="tweetText">${id === '100' ? '親の本文です。PARENT END' : body}</div>${id === '100' ? body.slice(body.indexOf('<div')) : ''}<footer>FOOTER ${id}</footer></article></main></body></html>`;
}

// 返信関係と投稿ページを架空の固定URLで用意する。
async function fixtures() {
  for (const name of ['persist:postclip-x', 'postclip-embed']) await session.fromPartition(name).protocol.handle('https', request => {
    const u = new URL(request.url);
    if (u.pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount)=>{const f=document.createElement('iframe');f.src='https://platform.twitter.com/fixture/'+id;mount.append(f);await new Promise(r=>f.onload=r);return f;}}};`, { headers: { 'content-type': 'application/javascript' } });
    const id = u.pathname.split('/').pop();assert.ok(['100','200','300'].includes(id));
    if (id === '300') quoteLoads++;
    return new Response(fixture(id, u.hostname === 'platform.twitter.com'), { headers: { 'content-type': 'text/html;charset=utf-8' } });
  });
}

// 元ページと切り出し後の文字領域を比較し、1.1.9の同じエラーを固定する。
async function reproduce() {
  const win = new BrowserWindow({ show: false, width: 430, height: 1000, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('https://x.com/sample/status/100');
    await win.webContents.executeJavaScript(expression(scripts.inspectPost, '100'));
    const before = await win.webContents.executeJavaScript(expression(content.inspectFullContent, '100', 'none'));
    assert.equal(before.clipped.length, 0, '元画面では引用全文が表示されている');
    const metrics = await win.webContents.executeJavaScript(`(()=>{const n=document.querySelector('[data-quote-body]');return {width:n.clientWidth,height:n.clientHeight,scrollHeight:n.scrollHeight}})()`);
    console.log('SOURCE_QUOTE', JSON.stringify(metrics));
    await win.webContents.executeJavaScript(expression(scripts.isolatePost, '100', { width: 430, padding: 0, conversation: 'none' }));
    const after = await win.webContents.executeJavaScript(expression(content.inspectFullContent, null, 'none'));
    fs.writeFileSync(path.join(out, 'reflow-state.json'), JSON.stringify({ before: before.clipped, after: after.clipped }, null, 2));
    if (process.env.POSTCLIP_EXPECT_V119_FAILURE) assert.equal(after.clipped.length, 1);
    else assert.equal(after.clipped.length, 0, '撮影幅への折り返し後も全文を表示');
  } finally { win.destroy(); }
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
  fs.writeFileSync(path.join(out, `reflow-${width}.png`), result.png);
  console.log('REFLOW_CAPTURE_PASS', width, result.width, result.height);
}

// 再配置だけで生じた切れを直し、元から切れていた本文は成功扱いにしない。
async function run() {
  fs.mkdirSync(out,{recursive:true});await fixtures();await reproduce();
  if (process.env.POSTCLIP_EXPECT_V119_FAILURE) {
    await assert.rejects(() => capture(430), /投稿ID 100.*表示枠で切れている本文 1件/);
    console.log('V119_PARENT_REFLOW_FAILURE_REPRODUCED');return;
  }
  for (const width of [430,320,550]) await capture(width);
  scenario='real-clipped-linked';await capture(430);assert.ok(quoteLoads > 0, '時刻にtime要素がない引用も元投稿から全文を取得');
  console.log('NO_TIME_QUOTED_POST_FETCH_PASS');
  scenario='real-clipped';
  await assert.rejects(() => capture(430), /表示枠で切れている本文|引用カードを開いても/);
  console.log('REAL_CLIPPED_STILL_REJECTED');
}
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1)});
