'use strict';
const { app, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { capturePost } = require('../app/capture.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
const out = path.resolve(__dirname, '../qa');
// 他の撮影テストとブラウザーの保存領域を共有しない。
app.setPath('userData', fsSync.mkdtempSync(path.join(os.tmpdir(), 'postclip-notes-test-')));
app.on('window-all-closed', () => {});

// 新旧の投稿画面と記事外ノートを、他投稿や引用の紛らわしいノートとともに再現する。
function fixture(kind) {
  const card = `<div class="note" data-testid="birdwatch-pivot"><a href="https://x.com/i/birdwatch/n/123" aria-label="Readers added context they thought people might want to know"></a><div><span>Readers added context</span></div><div>NOTE BODY: 架空の背景情報です。本文と出典を下端まで保存します。<br><a href="https://example.invalid/source">参考資料</a></div><div>NOTE END</div></div>`;
  const note = kind === 'modern' ? card.replace(' data-testid="birdwatch-pivot"', '') : card;
  const text = `<div data-testid="tweetText">TARGET BODY<br><a href="https://x.com/i/birdwatch/n/666">本文中のノート詳細リンク</a></div>`;
  const quote = `<div role="link"><a href="https://x.com/other/status/99"><time>引用の日付</time></a>${card.replaceAll('NOTE BODY', 'QUOTE NOTE')}</div>`;
  const placeholder = kind === 'incomplete' ? '<div data-testid="birdwatch-pivot"><div>Readers added context</div><div role="progressbar"></div></div>' : '';
  const target = `<article ${kind === 'modern' ? '' : 'data-testid="tweet"'}>${text}${quote}${kind === 'inside' || kind === 'modern' ? note : ''}${placeholder}<a href="https://x.com/demo/status/200">${kind === 'modern' ? '投稿日時' : '<time>2026-09-23</time>'}</a><footer>POST END</footer></article>`;
  const other = `<article data-testid="tweet"><a href="https://x.com/other/status/300"><time>別投稿</time></a>${card.replaceAll('NOTE BODY', 'OTHER NOTE')}</article>`;
  const delay = kind === 'delayed' ? `<script>setTimeout(()=>document.querySelector('#cell').insertAdjacentHTML('beforeend',${JSON.stringify(note)}),1800)</script>` : '';
  return `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#15202b;font-family:sans-serif}#cell{--note-padding:17px;padding:16px;box-sizing:border-box}article{font-size:18px;line-height:1.8}.note{border:1px solid #aaa;border-radius:10px;padding:var(--note-padding);margin:20px 0}a{color:#177abc}[role=link]{font-size:12px;background:#eee;padding:10px}footer{margin:14px}</style><body><div id="cell" data-testid="cellInnerDiv">${target}${kind === 'outside' ? note : ''}</div>${other}${delay}</body></html>`;
}

// ノート付き保存を実際の撮影経路へ渡し、PNG直前の対象範囲も取り出す。
async function capture(values = {}, job = { cancelled: false }) {
  let dom;
  const result = await capturePost(parsePostUrl('https://x.com/demo/status/200'), validateOptions({ conversation: 'none', includeNotes: true, ...values }), job, (_m, p) => {
    if (p === 88) dom = job.window.webContents.executeJavaScript(`({text:document.querySelector('#postclip-capture').innerText,notes:[...document.querySelectorAll('#postclip-capture [data-postclip-note="200"]')].map(n=>n.innerText)})`);
  });
  return { result, dom: await dom };
}

// 欠落・遅延・別記事誤認・キャンセルを、実際のElectron描画で検証する。
async function run() {
  await fs.mkdir(out, { recursive: true });
  let kind = 'inside';
  session.fromPartition('persist:postclip-x').protocol.handle('https', () => new Response(fixture(kind), { headers: { 'content-type': 'text/html;charset=utf-8' } }));
  for (kind of ['inside', 'modern', 'outside', 'delayed']) {
    const { result, dom } = await capture();
    assert.equal(result.notesIncluded, true);
    assert.equal(result.width, 1200);
    assert.ok(dom.text.includes('TARGET BODY') && dom.text.includes('NOTE END'));
    assert.ok(!dom.text.includes('OTHER NOTE'));
    assert.equal(dom.notes.length, 1);
    assert.ok(dom.notes[0].startsWith('Readers added context\nNOTE BODY'));
    assert.deepEqual(result.warnings, []);
    await fs.writeFile(path.join(out, `notes-${kind}.png`), result.png);
    console.log('PASS:', kind, result.width, result.height);
  }
  kind = 'missing';
  const noNote = await capture();
  assert.equal(noNote.result.notesIncluded,false);
  assert.equal(noNote.result.notesStatus,'not-shown');
  assert.deepEqual(noNote.result.warnings,[]);
  const ordinary = await capture({ includeNotes: false, mode: 'page' });
  assert.equal(ordinary.result.notesIncluded, false);
  kind = 'incomplete';
  await assert.rejects(capture(), /コミュニティノートの読み込みを確認できません/);
  const job = { cancelled: false };
  const pending = capture({}, job);
  setTimeout(() => { job.cancelled = true; job.abort?.(); job.window?.destroy(); }, 1500);
  await assert.rejects(pending, /キャンセル/);
  console.log('NOTES_PASS: both layouts, sibling note, delayed note, false-match exclusion, no-note success, incomplete-note failure, cancellation');
}
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
