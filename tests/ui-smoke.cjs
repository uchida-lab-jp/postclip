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
fsSync.writeFileSync(path.join(app.getPath('userData'),'settings.json'), JSON.stringify({conversation:false}));
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
  await fixtures();
  assert.equal(await wc.executeJavaScript('document.getElementById("conversation").value'),'none');
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
  main.setSize(920,680);
  await new Promise(r=>setTimeout(r,300));
  const overflow=await wc.executeJavaScript('document.documentElement.scrollWidth>innerWidth');
  assert.equal(overflow,false);
  await fs.writeFile(path.join(out,'ui-small.png'),(await wc.capturePage()).toPNG());
  console.log('UI_PASS: actual capture IPC, PNG save bytes, save cancel, clipboard, isolation, help, preferences, small layout');
}
require('../app/main.cjs');
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1);});
