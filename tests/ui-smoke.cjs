'use strict';
const { app, BrowserWindow, session, dialog, clipboard } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../qa');
// テスト時だけ独立した設定フォルダーを使い、利用者の設定に触れない。
app.setPath('userData', path.join(os.tmpdir(), `postclip-ui-test-${process.pid}`));
fsSync.mkdirSync(app.getPath('userData'), {recursive:true});
fsSync.writeFileSync(path.join(app.getPath('userData'),'settings.json'), JSON.stringify({conversation:false,includeNotes:false}));
app.getVersion = () => require('../package.json').version;
if (process.env.POSTCLIP_SKIP_SINGLETON_TEST === '1') app.requestSingleInstanceLock = () => true;
let main;

// 画面や処理の状態変化を、一定時間だけ待つ。
async function wait(check, message, timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error(message);
}

// 自作のサンプルだけを返すローカル通信置換を登録する。
async function fixtures() {
  const sample=await fs.readFile(path.join(__dirname,'fixtures','sample.html'),'utf8');
  const s=session.fromPartition('postclip-embed');
  await s.protocol.handle('https',request=>{
    if(new URL(request.url).pathname==='/widgets.js')return new Response(`window.twttr={widgets:{createTweet:async(id,mount,opts)=>{const f=document.createElement('iframe');f.style.cssText='width:'+opts.width+'px;height:620px';f.src='https://platform.twitter.com/sample';mount.append(f);await new Promise(r=>f.onload=r);return f}}};`,{headers:{'content-type':'application/javascript'}});
    return new Response(sample,{headers:{'content-type':'text/html;charset=utf-8'}});
  });
  let gated = false;
  const gate = '<!doctype html><meta charset="utf-8"><h2>センシティブな内容</h2><p>このポストはXアプリでのみ表示できます</p><a href="/i/jf/onboarding/web?mode=login">ログイン</a>';
  const withNote = sample.replace('</article>', '<div data-testid="birdwatch-pivot"><div>Readers added context</div><p>テスト用のコミュニティノート本文です。背景情報も保存します。</p></div></article>');
  await session.fromPartition('persist:postclip-x').protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === '/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount,opts)=>{const f=document.createElement('iframe');f.style.cssText='width:'+opts.width+'px;height:620px';f.src='https://platform.twitter.com/sample';mount.append(f);await new Promise(r=>f.onload=r);return f}}};`,{headers:{'content-type':'application/javascript'}});
    return new Response(url.hostname === 'x.com' ? (gated ? gate : withNote) : sample, {headers:{'content-type':'text/html;charset=utf-8'}});
  });
  return value => { gated = value; };
}

// アプリの実際のIPCを通して、作成・保存・コピー・設定再読込を検証する。
async function run() {
  await fs.mkdir(out,{recursive:true});
  await wait(()=>{main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html'));return !!main;},'メイン画面が起動しない');
  const wc=main.webContents;
  await wait(()=>wc.executeJavaScript(`!!window.postclip && document.getElementById("version").textContent === ${JSON.stringify(app.getVersion())}`),'画面の初期化が完了しない');
  await new Promise(r=>setTimeout(r,300));
  await fs.writeFile(path.join(out,'ui-home.png'),(await wc.capturePage()).toPNG());
  const isolation=await wc.executeJavaScript('({node:typeof require,process:typeof process})');
  assert.deepEqual(isolation,{node:'undefined',process:'undefined'});
  const invalid=await wc.executeJavaScript('window.postclip.capture({url:"https://example.com/",options:{}})');
  assert.equal(invalid.ok,false);
  const setGate = await fixtures();
  assert.equal(await wc.executeJavaScript('document.getElementById("conversation").value'),'none');
  assert.equal(await wc.executeJavaScript('document.getElementById("includeNotes").checked'),true);
  await wc.executeJavaScript('document.getElementById("includeNotes").click()');
  assert.deepEqual(await wc.executeJavaScript('[...document.getElementById("conversation").options].map(o=>o.value)'),['none','parent','thread']);
  await wc.executeJavaScript('document.getElementById("conversation").value="thread";document.getElementById("conversation").dispatchEvent(new Event("input",{bubbles:true}))');
  await wc.executeJavaScript('document.getElementById("url").value="https://x.com/postclip_sample/status/200";document.getElementById("capture-button").click()');
  await wait(()=>wc.executeJavaScript('!document.getElementById("download").disabled'),'画像作成が完了しない');
  assert.equal(await wc.executeJavaScript('document.getElementById("result-image").naturalWidth'),1200);
  assert.equal(await wc.executeJavaScript('document.getElementById("preview-heading").textContent'),'1件の投稿をまとめました');
  await fs.writeFile(path.join(out,'ui-result.png'),(await wc.capturePage()).toPNG());
  const file=path.join(out,'ui-saved.png');
  dialog.showSaveDialog=async()=>({canceled:false,filePath:file});
  const saved=await wc.executeJavaScript('window.postclip.save()');
  assert.equal(saved.ok,true);
  const bytes=await fs.readFile(file);
  const expected=await wc.executeJavaScript('document.getElementById("result-image").src');
  assert.equal(bytes.toString('base64'),expected.split(',')[1]);
  assert.equal((await wc.executeJavaScript('window.postclip.copy()')).ok,true);
  const items = await clipboard.read();
  const png = await items.find(item => item.types.includes('image/png')).getType('image/png');
  assert.equal(Buffer.from(await png.arrayBuffer()).readUInt32BE(16),1200);
  await clipboard.writeText('https://x.com/postclip_sample/status/200');
  assert.equal(await wc.executeJavaScript('window.postclip.paste()'),'https://x.com/postclip_sample/status/200');
  dialog.showSaveDialog=async()=>({canceled:true});
  assert.equal((await wc.executeJavaScript('window.postclip.save()')).cancelled,true);
  await wc.executeJavaScript('document.getElementById("actual-size").click()');
  assert.equal(await wc.executeJavaScript('document.getElementById("result").classList.contains("actual")'),true);
  await wc.executeJavaScript('document.getElementById("actual-size").click();document.getElementById("help-button").click()');
  assert.equal(await wc.executeJavaScript('document.getElementById("help-dialog").open'),true);
  await fs.writeFile(path.join(out,'ui-help.png'),(await wc.capturePage()).toPNG());
  await wc.executeJavaScript('document.getElementById("help-close").click()');
  await wc.reload();
  await wait(()=>wc.executeJavaScript('document.getElementById("conversation").value === "thread"'),'親までの設定が復元されない');
  assert.equal(await wc.executeJavaScript('document.getElementById("includeNotes").checked'),false);
  assert.equal(JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'settings.json'),'utf8')).settingsVersion,3);
  await wc.executeJavaScript('document.getElementById("includeNotes").click();document.getElementById("url").value="https://x.com/postclip_sample/status/200";document.getElementById("capture-button").click()');
  await wait(()=>wc.executeJavaScript('!document.getElementById("download").disabled'),'ノート付き画像作成が完了しない');
  assert.equal(await wc.executeJavaScript('document.getElementById("preview-heading").textContent'),'コミュニティノートを含めて作成しました');
  assert.equal(await wc.executeJavaScript('document.getElementById("mode").disabled'),true);
  dialog.showSaveDialog=async()=>({canceled:false,filePath:file});
  assert.equal((await wc.executeJavaScript('window.postclip.save()')).ok,true);
  assert.equal((await fs.readFile(file)).toString('base64'), (await wc.executeJavaScript('document.getElementById("result-image").src')).split(',')[1]);
  await wc.reload();
  await wait(()=>wc.executeJavaScript('document.getElementById("includeNotes").checked'),'ノート付き保存の設定が復元されない');
  main.setSize(920,680);
  await new Promise(r=>setTimeout(r,300));
  const overflow=await wc.executeJavaScript('document.documentElement.scrollWidth>innerWidth');
  assert.equal(overflow,false);
  await fs.writeFile(path.join(out,'ui-small.png'),(await wc.capturePage()).toPNG());
  // 本文の表示を待って自動再開し、利用者に別の作成ボタンを押させない。
  setGate(true);
  await wc.executeJavaScript('document.getElementById("conversation").value="none";document.getElementById("url").value="https://x.com/postclip_sample/status/200";document.getElementById("capture-button").click()');
  let xWindow;
  await wait(() => { xWindow=BrowserWindow.getAllWindows().find(w=>w!==main && w.isVisible() && w.webContents.getURL().includes('/postclip_sample/status/200'));return !!xWindow; }, '必要なX確認ウィンドウが自動で開かない');
  assert.equal(await wc.executeJavaScript('document.body.classList.contains("busy")'), true);
  await wait(()=>wc.executeJavaScript('document.getElementById("busy-message").textContent.includes("自動")'), "自動再開の案内が出ない");
  assert.equal(await wc.executeJavaScript('document.getElementById("capture-open-x")'), null);
  setGate(false);
  await xWindow.webContents.reload();
  await wait(()=>xWindow.webContents.executeJavaScript('!!document.querySelector("article")'), '本文が表示されない');
  setGate(true);
  await wait(()=>wc.executeJavaScript('!document.getElementById("download").disabled'), '表示確認後に自動で作成が続かない');
  assert.equal(await wc.executeJavaScript('document.getElementById("preview-heading").textContent'), 'コミュニティノートを含めて作成しました');
  assert.equal((await wc.executeJavaScript('window.postclip.save()')).ok,true);
  assert.equal((await fs.readFile(file)).toString('base64'),(await wc.executeJavaScript('document.getElementById("result-image").src')).split(',')[1]);
  await fs.writeFile(path.join(out,'ui-auto-resume-v115.png'),(await wc.capturePage()).toPNG());
  // X画面の表示待ちも直ちにキャンセルでき、後から成功結果が届かない。
  await xWindow.webContents.reload();
  await wc.executeJavaScript('document.getElementById("capture-button").click()');
  await wait(()=>wc.executeJavaScript('document.getElementById("busy-message").textContent.includes("自動")'), '表示確認の待機に入らない');
  const cancelStart=Date.now();
  await wc.executeJavaScript('document.getElementById("cancel").click()');
  await wait(()=>wc.executeJavaScript('!document.body.classList.contains("busy")'), '表示待ちをキャンセルできない',2000);
  assert.ok(Date.now()-cancelStart<2000);
  assert.equal(await wc.executeJavaScript('document.getElementById("download").disabled'),true);
  assert.equal(xWindow.isDestroyed(),false);
  console.log('UI_PASS: actual capture IPC, PNG save bytes, notes/thread option and persistence, save cancel, clipboard, isolation, help, small layout, automatic X display recovery, no second capture button, immediate wait cancellation');
}
require('../app/main.cjs');
app.whenReady().then(run).then(()=>app.quit()).catch(async error=>{
  console.error(error.stack);
  if(main&&!main.isDestroyed())console.error(await main.webContents.executeJavaScript('({status:document.getElementById("status").textContent,progress:document.getElementById("busy-message").textContent,busy:document.body.classList.contains("busy")})'));
  app.exit(1);
});
