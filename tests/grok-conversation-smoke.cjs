'use strict';
const {app,BrowserWindow,session,dialog}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(process.env.POSTCLIP_TEST_ROOT || path.join(__dirname,'..'));
const content=require(path.join(root,'app/content-scripts.cjs'));
const {expression}=require(path.join(root,'app/capture.cjs'));
const out=path.resolve(__dirname,'../qa'),url='https://x.com/sample/status/200',share='https://x.com/i/grok/share/conversation-test';
const q1='最初に尋ねた質問です。初回の回答と正しく対応させてください。';
const q2='https://x.com/parent/status/100\n\nこの返信について質問を続けます。QUESTION TWO END';
const a1='これは初回の回答です。別の質問の回答へ混ぜず、最後まで保存してください。FIRST ANSWER END';
const a2='これは二回目の回答の先頭です。質問に対応する回答を最後まで取得します。';
const end='こちらが二回目の回答の最終段落です。SECOND ANSWER END';
let mode='second',privateReads=0,publicReads=0,fallback=false;
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'postclip-grok-conversation-')));
fs.writeFileSync(path.join(app.getPath('userData'),'settings.json'),JSON.stringify({settingsVersion:3,width:430,scale:3,mode:'page',conversation:'none',includeNotes:false}));
app.requestSingleInstanceLock=()=>true;app.getVersion=()=>require(path.join(root,'package.json')).version;

// URLを含む質問と無反応の展開ボタンを持つ、ログイン画面型のカードを用意する。
function postPage(){
 const preview=mode==='first'?a1:a2;
 if(process.env.POSTCLIP_EXPECT_FAILURE)return `<!doctype html><meta charset="utf-8"><article><a href="${url}"><time>2026-10-21</time></a><div data-testid="tweetText">投稿本文。<a href="${share}">x.com/i/grok/share/c…</a></div><div class="card"><button>fixture-ready</button></div></article>`;
 const heading=mode==='first'?q1:`<a href="https://x.com/parent/status/100">${q2.split('\n')[0]}</a>…`;
 return `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;color:#123;font:16px sans-serif}article{padding:16px}.card{padding:16px;border:1px solid #ccd;border-radius:12px}[data-testid=tweetText]{white-space:pre-wrap;line-height:26px}.card [data-testid=tweetText]{max-height:52px;overflow:hidden}</style><article><a href="${url}"><time>2026-10-21</time></a><div data-testid="tweetText">投稿本文。POST END</div><div class="card"><strong>${heading}</strong><div>Grokによる回答</div><div data-testid="tweetText">${preview}…</div><button onclick="window.nativeClicked=true">さらに表示</button></div><footer>FOOTER END</footer></article><script>document.querySelector('.card').__reactProps$test={card:{shareUrl:'${share}'}}</script>`;
}

// 公開ページで観測した会話の構造を使い、質問・回答が2往復するページを作る。
function sharePage(){
 return `<!doctype html><meta charset="utf-8"><main><h1>共有された会話</h1><div><div class="flex flex-col gap-6"><div class="items-end"><div class="whitespace-pre-wrap">${q1}</div></div><div><div><p>${a1}</p></div></div><div class="items-end"><div class="whitespace-pre-wrap">${q2}</div></div><div><div><p>${a2}</p><pre><code>const sample = 'ANSWER CODE';</code></pre><p>${end}</p><script>window.unwanted=true</script><button>コピー</button></div></div></div></div></main>`;
}

// ログイン有無で共有ページの構造を変え、公開表示へ切り替わることを確認する。
async function fixtures(){
 for(const name of ['persist:postclip-x','postclip-public'])await session.fromPartition(name).protocol.handle('https',request=>{
  if(request.url===share){
   if(name==='persist:postclip-x'){privateReads++;if(fallback)return new Response(sharePage(),{headers:{'content-type':'text/html;charset=utf-8'}});return new Response('<main><div data-legacy-chat>見えている回答でも旧読取器のh1条件を満たさない表示</div></main>',{headers:{'content-type':'text/html;charset=utf-8'}});}
   publicReads++;if(fallback)return Response.error();return new Response(sharePage(),{headers:{'content-type':'text/html;charset=utf-8'}});
  }
  assert.equal(request.url,url);return new Response(postPage(),{headers:{'content-type':'text/html;charset=utf-8'}});
 });
 await session.fromPartition('persist:postclip-x').cookies.set({url:'https://x.com',name:'fixture-login',value:'fictional'});
}

// UIの完了を待ち、途中状態をテスト成功として扱わない。
async function wait(check,timeout=70000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('会話共有テストが完了しませんでした。');}

// ネイティブのマウス入力で「さらに表示」を押す。
async function clickMore(win){
 win.show();win.focus();const point=await win.webContents.executeJavaScript(`(async()=>{const b=document.querySelector('.card button');b.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const p=b.getBoundingClientRect();return{x:Math.round(p.x+p.width/2),y:Math.round(p.y+p.height/2)}})()`);
 for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});
}

// 旧版の停止、URL付き質問の展開、初回/後続回答の選択、PNG保存を確認する。
async function run(){
 fs.mkdirSync(out,{recursive:true});await fixtures();
 const main=await wait(()=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html'))),wc=main.webContents;
 await wait(()=>wc.executeJavaScript('!!document.querySelector("#version").textContent'));
 await wc.executeJavaScript(`document.querySelector('#url').value='${url}';document.querySelector('#advanced').open=true;document.querySelector('#open-x').click()`);
 const source=await wait(()=>BrowserWindow.getAllWindows().find(w=>w!==main&&w.webContents.getURL()===url));
 await wait(()=>source.webContents.executeJavaScript('!!document.querySelector(".card button")'));
 if(process.env.POSTCLIP_EXPECT_FAILURE){
  await wc.executeJavaScript('document.querySelector("#capture-button").click()');
  await wait(()=>wc.executeJavaScript('!document.body.classList.contains("busy")'));
  const error=await wc.executeJavaScript('document.querySelector("#status").textContent');
  assert.match(error,/Grok回答の全文を確認できません/);assert.ok(privateReads>0);assert.equal(publicReads,0);console.log('V1111_SHARED_LAYOUT_ERROR_REPRODUCED',error);return;
 }
 for(const choice of ['second','first']){
  mode=choice;if(choice==='first')await source.loadURL(url);
  await wait(()=>source.webContents.executeJavaScript('!!document.querySelector(".card button")'));
  await clickMore(source);
  const text=await wait(()=>source.webContents.executeJavaScript('document.querySelector("[data-postclip-full-resource]")?.textContent'));
  assert.equal(await source.webContents.executeJavaScript('!!window.nativeClicked'),false);
  assert.ok(text.includes(choice==='second'?q2:q1));assert.ok(text.includes(choice==='second'?end:a1));
  assert.ok(!text.includes(choice==='second'?a1:end),'別の回答を混ぜない');assert.equal(source.webContents.getURL(),url);
  console.log('CONVERSATION_SELECTED_PASS',choice);
 }
 await wc.executeJavaScript('document.querySelector("#capture-button").click()');await wait(()=>wc.executeJavaScript('!document.body.classList.contains("busy")'));
 const state=await wc.executeJavaScript('({ok:!document.querySelector("#download").disabled,error:document.querySelector("#status").textContent,src:document.querySelector("#result-image").src})');assert.ok(state.ok,state.error);
 const file=path.join(out,'grok-conversation-saved.png');dialog.showSaveDialog=async()=>({canceled:false,filePath:file});assert.equal((await wc.executeJavaScript('window.postclip.save()')).ok,true);assert.equal(fs.readFileSync(file).toString('base64'),state.src.split(',')[1]);
 assert.equal(privateReads,0);assert.ok(publicReads>=2);assert.deepEqual(await session.fromPartition('postclip-public').cookies.get({name:'fixture-login'}),[]);
 fallback=true;mode='second';await source.loadURL(url);await wait(()=>source.webContents.executeJavaScript('!!document.querySelector(".card button")'));await clickMore(source);
 const recovered=await wait(()=>source.webContents.executeJavaScript('document.querySelector("[data-postclip-full-resource]")?.textContent'));assert.ok(recovered.includes(end));assert.equal(privateReads,1);fallback=false;console.log('PUBLIC_UNAVAILABLE_SESSION_FALLBACK_PASS');
 const probe=new BrowserWindow({show:false,webPreferences:{partition:'postclip-public',sandbox:true,contextIsolation:true,nodeIntegration:false}});await probe.loadURL(share);
 const parsed=await probe.webContents.executeJavaScript(expression(content.readGrokContent,new URL(share).pathname));
 assert.equal(parsed.turns.length,2);assert.equal(parsed.question,q2);assert.ok(parsed.text.includes(end));assert.ok(!parsed.html.includes('<script'));assert.ok(!parsed.html.includes('コピー'));
 await probe.webContents.executeJavaScript(`document.querySelector('main h1').nextElementSibling.insertAdjacentHTML('beforeend','<div class="items-end"><div class="whitespace-pre-wrap">未回答の第三の質問</div></div>')`);
 assert.equal(await probe.webContents.executeJavaScript(expression(content.readGrokContent,new URL(share).pathname)),null,'末尾が未回答なら完成扱いにしない');probe.destroy();
 console.log('GROK_CONVERSATION_PASS: two turns, exact question/answer match, trusted click, public session, PNG saved, incomplete rejected');
}
require(path.join(root,'app/main.cjs'));
app.whenReady().then(run).then(()=>app.quit()).catch(e=>{console.error(e.stack);app.exit(1)});
