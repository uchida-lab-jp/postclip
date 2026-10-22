"use strict";
const {app,BrowserWindow,session,screen,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {capturePost,snapshotOpenPage}=require('../app/capture.cjs');
const {parsePostUrl,validateOptions}=require('../app/core.cjs');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'postclip-viewport-')));
app.on('window-all-closed',()=>{});
const out=path.resolve(__dirname,'../qa'),post=parsePostUrl('https://x.com/sample/status/200');
const markers=['BEGIN','MIDDLE','END'];
const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;color:#123;background:white;font-family:sans-serif}main{width:600px;max-width:100%}article{padding:20px;box-sizing:border-box}[data-testid=tweetText]{font-size:18px;line-height:26px;white-space:pre-wrap}.mark{height:30px;background:rgb(255,0,127)}</style><main><article><a href="${post.url}"><time>時刻</time></a><div data-testid="tweetText">${markers.map(m=>m+'<div class="mark" data-mark="'+m+'"></div>'+'画面の外まで続く架空本文。'.repeat(55)).join('<br>')}</div><footer>FOOTER END</footer></article></main>`;
// 画面サイズ・ウィンドウ位置・スクロールを変えて同一本文の撮影結果を比較する。
async function run(){
 fs.mkdirSync(out,{recursive:true});
 await session.fromPartition('persist:postclip-x').protocol.handle('https',()=>new Response(html,{headers:{'content-type':'text/html;charset=utf-8'}}));
 console.log('SCREEN',screen.getPrimaryDisplay().workAreaSize);
 let reference;
 for(const [name,bounds,scroll] of [['large',{width:1000,height:840,x:0,y:0},0],['small',{width:480,height:300,x:0,y:0},2500],['outside',{width:1000,height:840,x:1100,y:600},5000],['hidden',{width:1000,height:840,x:0,y:0},4000]]){
  const source=new BrowserWindow({...bounds,show:name!=='hidden',webPreferences:{partition:'persist:postclip-x',sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  try{
   await source.loadURL(post.url);await source.webContents.executeJavaScript('scrollTo(0,'+scroll+')');
   const state=await source.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,scrollY,body:document.body.scrollHeight})');
   const job={cancelled:false};job.openPageSnapshot=await snapshotOpenPage(source.webContents,post,validateOptions({width:430,scale:3,conversation:'none',mode:'page',includeNotes:false}),job);
   let evidence;
   const result=await capturePost(post,validateOptions({width:430,scale:3,conversation:'none',mode:'page',includeNotes:false}),job,(_m,p)=>{if(p===88)evidence=job.window.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#postclip-capture');return {text:r.innerText,markers:[...r.querySelectorAll('[data-mark]')].map(n=>{const b=n.getBoundingClientRect();return {name:n.dataset.mark,x:b.x+3,y:b.y+3}})}})()`)});
   const proof=await evidence;assert.deepEqual(proof.markers.map(m=>m.name),markers);assert.ok(proof.text.includes('FOOTER END'));const bitmap=nativeImage.createFromBuffer(result.png).toBitmap();
   for(const m of proof.markers){const offset=(Math.round(m.y*3)*result.width+Math.round(m.x*3))*4;assert.deepEqual([...bitmap.subarray(offset,offset+3)],[127,0,255],m.name+' is painted');}
   const digest=require('node:crypto').createHash('sha256').update(result.png).digest('hex');
   if(reference)assert.equal(digest,reference,'same output independent of window size and position');else reference=digest;
   fs.writeFileSync(path.join(out,'viewport-'+name+'.png'),result.png);
   console.log('VIEWPORT_PASS',JSON.stringify({name,bounds:source.getBounds(),state,width:result.width,height:result.height,digest}));
  }finally{source.destroy()}
 }
}
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1)});
