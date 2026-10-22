'use strict';
const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {fixtures,question,sourceLoadCount,setScenario}=require('./missing-grok-link-smoke.cjs');
const url='https://x.com/sample/status/200',out=path.resolve(__dirname,'../qa');
app.requestSingleInstanceLock=()=>true;
app.getVersion=()=>require('../package.json').version;
fs.writeFileSync(path.join(app.getPath('userData'),'settings.json'),JSON.stringify({settingsVersion:3,width:430,scale:3,conversation:'thread',mode:'page',includeNotes:false}));

// UIが条件を満たすまで待ち、無反応を制限時間で検出する。
async function wait(check,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error('Grok展開の実UIテストが完了しませんでした。');}

// 実際のマウス入力でクリックし、ページ側の合成クリックと区別する。
async function click(win,selector){
  win.show();win.focus();
  const point=await win.webContents.executeJavaScript(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
}

// 反応しないGrokボタンから全文を表示し、その表示状態で通常作成とPNG保存を行う。
async function run(){
  fs.mkdirSync(out,{recursive:true});await fixtures();setScenario('runtime-multiple');
  const main=await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html'))),wc=main.webContents;
  await wait(()=>wc.executeJavaScript('!!document.querySelector("#version").textContent'));
  await wc.executeJavaScript(`document.querySelector('#url').value=${JSON.stringify(url)};document.querySelector('#advanced').open=true;document.querySelector('#open-x').click()`);
  const source=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==main&&w.webContents.getURL()===url));
  await wait(()=>source.webContents.executeJavaScript('!!document.querySelector(".card button")'));
  const before=sourceLoadCount();
  if(!process.env.POSTCLIP_BASELINE_V118){
    await source.webContents.executeJavaScript(`(()=>{const original=document.querySelector('article');const parent=original.cloneNode(true);parent.id='parent-for-click';parent.querySelector('a').href='https://x.com/sample/status/100';parent.querySelector('.card').__reactProps$fixture=original.querySelector('.card').__reactProps$fixture;original.before(parent)})()`);
    await click(source,'#parent-for-click .card button');
    await wait(()=>source.webContents.executeJavaScript('!!document.querySelector("#parent-for-click [data-postclip-full-resource]")'));
    assert.equal(await source.webContents.executeJavaScript('!!document.querySelector("article:not(#parent-for-click) .card")'),true,'押した親のカードだけを展開する');
    await source.webContents.executeJavaScript('document.querySelector("#parent-for-click").remove()');
  }
  await source.webContents.executeJavaScript(`(()=>{const b=document.createElement('button');b.id='body-more';b.textContent='さらに表示';b.onclick=()=>{window.bodyClicked=true;b.remove()};document.querySelector('[data-testid="tweetText"]').append(b)})()`);
  await click(source,'#body-more');
  await wait(()=>source.webContents.executeJavaScript('!!window.bodyClicked'));
  await source.webContents.executeJavaScript(`document.querySelector('.card button').outerHTML='<span id="native-more" role="button" tabindex="0" onclick="window.previewClicked=true">さらに表示</span>'`);
  await click(source,'#native-more');
  if(process.env.POSTCLIP_BASELINE_V118){
    await new Promise(r=>setTimeout(r,1200));
    assert.equal(await source.webContents.executeJavaScript('!!window.previewClicked'),true);
    assert.equal(await source.webContents.executeJavaScript('!!document.querySelector("[data-postclip-full-resource]")'),false);
    console.log('V118_NATIVE_MORE_NO_EXPANSION_REPRODUCED');return;
  }
  const expanded=await wait(()=>source.webContents.executeJavaScript(`(()=>{const card=document.querySelector('[data-postclip-full-resource]');return card?{text:card.innerText,nativeClicked:!!window.previewClicked,more:[...document.querySelectorAll('button')].filter(n=>n.textContent.trim()==='さらに表示').length}:false})()`));
  assert.ok(expanded.text.includes(question));assert.ok(expanded.text.includes('GROK END'));assert.ok(!expanded.text.includes('WRONG ANSWER'));
  assert.equal(expanded.nativeClicked,false);assert.equal(expanded.more,0);assert.equal(sourceLoadCount(),before);
  await source.webContents.executeJavaScript(`new Promise(resolve=>{document.querySelector('[data-postclip-full-resource]').scrollIntoView({block:'start'});requestAnimationFrame(()=>requestAnimationFrame(resolve))})`);
  await new Promise(r=>setTimeout(r,300));
  fs.writeFileSync(path.join(out,'grok-expanded-window.png'),(await source.webContents.capturePage()).toPNG());
  await wc.executeJavaScript('document.querySelector("#capture-button").click()');
  await wait(()=>wc.executeJavaScript('!document.body.classList.contains("busy")'));
  const state=await wc.executeJavaScript('({ok:!document.querySelector("#download").disabled,error:document.querySelector("#status").textContent,data:document.querySelector("#result-image").src,width:document.querySelector("#result-image").naturalWidth})');
  assert.ok(state.ok,state.error);assert.equal(state.width,1290);assert.equal(sourceLoadCount(),before);
  const file=path.join(out,'grok-expand-ui-saved.png');dialog.showSaveDialog=async()=>({canceled:false,filePath:file});
  assert.equal((await wc.executeJavaScript('window.postclip.save()')).ok,true);
  assert.equal(fs.readFileSync(file).toString('base64'),state.data.split(',')[1]);
  setScenario('unavailable');await source.loadURL(url);
  await wait(()=>source.webContents.executeJavaScript('!!document.querySelector(".card button")'));
  await click(source,'.card button');
  await wait(()=>source.webContents.executeJavaScript(`(()=>{const text=document.querySelector('[data-postclip-grok-status]')?.textContent||'';return text&&!text.includes('取得しています')?text:false})()`));
  assert.equal(await source.webContents.executeJavaScript('!!document.querySelector("[data-postclip-full-resource]")'),false);
  setScenario('normal');await click(source,'.card button');
  await wait(()=>source.webContents.executeJavaScript('!!document.querySelector("[data-postclip-full-resource]")?.textContent.includes("GROK END")'));
  assert.equal(await source.webContents.executeJavaScript('typeof require'), 'undefined');
  assert.equal(await source.webContents.executeJavaScript('typeof window.postclip'), 'undefined');
  console.log('GROK_EXPAND_UI_PASS: trusted click, original card expands, own runtime data, no public metadata, matching answer, unchanged source URL, normal post button preserved, PNG saved bytes match');
  console.log('GROK_EXPAND_RECOVERY_PASS: failure shown inline, retry succeeds, remote page has no Node or local-UI API');
}
require(process.env.POSTCLIP_BASELINE_MAIN || '../app/main.cjs');
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1)});
