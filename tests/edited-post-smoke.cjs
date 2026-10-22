'use strict';
const { app, session, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { capturePost, snapshotOpenPage, expression } = require('../app/capture.cjs');
const scripts = require('../app/page-scripts.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.setPath('userData', fsSync.mkdtempSync(path.join(os.tmpdir(), 'postclip-edited-')));
app.on('window-all-closed', () => {});
const post = parsePostUrl('https://x.com/sample/status/2109963685271933340');

// 実投稿で確認した編集履歴リンク・新DOM・長文を、架空の内容で再現する。
function fixture(timeLink = `/sample/status/${post.id}/history`, quoteOnly = false) {
  const text = Array.from({ length: 25 }, (_, i) => `段落 ${i + 1}：これは編集済みの架空投稿です。長文と改行を下端まで保存できることを確認します。`).join('\n\n');
  const content = `<div data-timeline-entry><article><a href="/sample">編集済みサンプル</a><div dir="auto" class="whitespace-pre-wrap">${text}\n本文中の「ログイン」「このポストは表示できません」を制限と取り違えない。</div><div role="link"><article><a href="/quoted/status/${quoteOnly ? post.id : '999'}/history"><time>引用の時刻</time></a><p>引用の架空本文</p></article></div><a href="${timeLink}">最終編集 <time>2026年10月13日</time></a><a href="/sample/status/${quoteOnly ? '777' : post.id}">再生数</a><footer>EDITED POST END</footer></article></div>`;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;background:white;color:#22332c;font-family:sans-serif}[data-timeline-entry]{padding:16px;box-sizing:border-box}article{font-size:18px;line-height:1.8}.whitespace-pre-wrap{white-space:pre-wrap}a{color:#336688}[role=link]{border:1px solid #ddd;padding:12px}</style><body>${content}<article><a href="/reply/status/555"><time>返信時刻</time></a>UNRELATED REPLY</article></body></html>`;
}

// 時刻のリンク形式を照合し、引用・外部URL・他の投稿を誤って選ばないことを確認する。
async function run() {
  let html = fixture();
  let requests = 0;
  await session.fromPartition('persist:postclip-x').protocol.handle('https', () => { requests++; return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } }); });
  const source = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const wc = source.webContents;
  for (const [link, quoteOnly, expected] of [
    [`/sample/status/${post.id}/history`, false, true],
    [`/sample/status/${post.id}/history?lang=ja`, false, true],
    [`/sample/status/${post.id}`, false, true],
    ['/sample/status/777/history', true, false],
    [`https://example.com/sample/status/${post.id}/history`, false, false],
    [`/sample/status/${post.id}/unknown`, false, false]
  ]) {
    html = fixture(link, quoteOnly);
    await wc.loadURL(post.url);
    assert.equal((await wc.executeJavaScript(expression(scripts.inspectPost, post.id))).found, expected, link);
  }
  html = fixture();
  await wc.loadURL(post.url);
  const baseline = path.resolve(__dirname, '../qa/page-scripts-v114.cjs');
  if (fsSync.existsSync(baseline)) assert.equal((await wc.executeJavaScript(expression(require(baseline).inspectPost, post.id))).found, false, '旧版の編集済み投稿の見落としを再現');
  const options = validateOptions({ mode: 'auto', width: 430, scale: 3, conversation: 'none', includeNotes: false });
  const before = requests;
  const job = { cancelled: false };
  job.openPageSnapshot = await snapshotOpenPage(wc, post, options, job);
  let text;
  const result = await capturePost(post, options, job, (_message, percent) => { if (percent === 88) text = job.window.webContents.executeJavaScript('document.getElementById("postclip-capture").innerText'); });
  assert.equal(requests, before);
  assert.equal(result.width, 1290);
  assert.ok(result.height > 6000);
  assert.ok((await text).includes('EDITED POST END'));
  assert.ok(!(await text).includes('UNRELATED REPLY'));
  assert.ok((await text).includes('引用の架空本文'));
  await fs.mkdir(path.resolve(__dirname, '../qa'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../qa/edited-long-v115.png'), result.png);
  source.destroy();
  console.log(`EDITED_PASS: old failure reproduced, history links, quoted ID rejection, external link rejection, modern body, full ending, no reload, ${result.width} x ${result.height} PNG`);
}
app.whenReady().then(run).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
