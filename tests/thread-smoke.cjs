'use strict';
const {app,session} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {capturePost} = require('../app/capture.cjs');
const {parsePostUrl,validateOptions} = require('../app/core.cjs');
const out = path.resolve(__dirname,'../qa');
app.on('window-all-closed',()=>{});

// 本文・引用の紛らわしい返信リンクと、別枝の記事を混ぜた架空投稿を返す。
function fixture(id, state, page) {
  const next = id === '100' ? null : String(Number(id)-100);
  const parent = state === 'missing' && id === '300' ? '404' : state === 'cycle' && id === '100' ? '400' : next;
  const note = page && id === '400' ? '<div data-testid="birdwatch-pivot"><div>Readers added context</div><p>THREAD NOTE: 指定した投稿の背景情報を最後まで保存します。</p></div>' : '';
  const reply = (parent ? `<a href="https://twitter.com/demo/status/${parent}">返信先: @demoさん</a>` : '') + note;
  const article = `<article data-testid="tweet"><a href="https://x.com/demo/status/${id}" aria-label="Xでこのポストを表示する"></a><header>DEMO ${id}</header><div>${reply}<div data-testid="tweetText"><p>POST ${id} の本文です。<br>文字と画像を下端まで保存します。</p><a href="https://x.com/decoy/status/999">返信先: 本文中のリンク</a></div></div><div role="link"><article><a href="https://x.com/decoy/status/999">返信先: 引用の親</a><div data-testid="tweetText">引用をたどらない</div></article></div><a href="https://x.com/demo/status/${id}"><time>2026-09-22</time></a><footer>END ${id}</footer></article>`;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:white;color:#182b24;font-family:'Noto Sans CJK JP',sans-serif}article{padding:18px;border:1px solid #bcc9bb;box-sizing:border-box}header{font-size:22px;font-weight:bold}p{font-size:19px;line-height:1.8}a{font-size:12px;color:#467464}footer{margin-top:30px;padding:12px;background:#daeeb4}[role=link]{margin:18px 0}h1{height:240px}</style><body>${page?'<article data-testid="tweet"><a href="https://x.com/decoy/status/888"><time>OTHER BRANCH</time></a></article>':''}${article}${page?'<h1>UNRELATED REPLIES</h1>':''}</body></html>`;
}

// 専用の通信だけを置換し、実アプリと同じフレーム処理を通す。
async function fixtures() {
  let state = 'normal';
  for (const name of ['postclip-embed','persist:postclip-x']) {
    await session.fromPartition(name).protocol.handle('https',request=>{
      const url = new URL(request.url);
      if(url.pathname==='/widgets.js') return new Response(`window.twttr={widgets:{createTweet:async(id,mount,o)=>{if(id==='404')return undefined;const f=document.createElement('iframe');f.style.cssText='width:'+o.width+'px;height:650px';f.src='https://platform.twitter.com/fixture/'+id;mount.append(f);await new Promise(r=>f.onload=r);return f}}};`,{headers:{'content-type':'application/javascript'}});
      const id = url.pathname.split('/').pop();
      if(!['100','200','300','400'].includes(id)) throw new Error('Unexpected post: '+id);
      return new Response(fixture(id,state,url.hostname==='x.com'),{headers:{'content-type':'text/html;charset=utf-8'}});
    });
  }
  return value=>{state=value;};
}

// PNG化する直前の実DOMを検査し、本文順と別枝の除外も確認する。
async function capture(url, mode='embed', includeNotes=false) {
  const job = {cancelled:false,window:null};
  let inspect;
  const result=await capturePost(parsePostUrl(url),validateOptions({conversation:'thread',mode,includeNotes}),job,(message,percent)=>{
    process.stdout.write(message+'\n');
    if(percent===88) inspect=job.window.webContents.executeJavaScript(`({ids:[...document.querySelectorAll('[data-postclip-id]')].map(e=>e.dataset.postclipId),text:document.querySelector('#postclip-capture').innerText})`);
  });
  return {result,dom:await inspect};
}

// 実URL検証と再現用のシナリオを明確に分けて記録する。
async function run() {
  await fs.mkdir(out,{recursive:true});
  if(process.env.POSTCLIP_LIVE_URL){
    const {result,dom}=await capture(process.env.POSTCLIP_LIVE_URL);
    await fs.writeFile(path.join(out,'live-thread.png'),result.png);
    const meta={width:result.width,height:result.height,count:result.postCount,warnings:result.warnings,ids:dom.ids};
    await fs.writeFile(path.join(out,'live-thread.json'),JSON.stringify(meta,null,2));
    console.log('LIVE_THREAD',JSON.stringify(meta));return;
  }
  const state=await fixtures();
  for(const mode of ['embed','page']){
    const {result,dom}=await capture('https://x.com/demo/status/400',mode);
    assert.deepEqual(dom.ids,['100','200','300','400']);
    assert.equal(result.postCount,4);assert.equal(result.width,1200);assert.ok(result.height>3000);
    assert.ok(dom.text.indexOf('POST 100')<dom.text.indexOf('POST 400'));
    assert.ok(dom.text.includes('END 400'));
    assert.ok(!/OTHER BRANCH|UNRELATED REPLIES/.test(dom.text));
    assert.deepEqual(result.warnings,[]);
    await fs.writeFile(path.join(out,`thread-${mode}.png`),result.png);
  }
  const root=await capture('https://x.com/demo/status/100');assert.equal(root.result.postCount,1);
  const notes=await capture('https://x.com/demo/status/400','embed',true);
  assert.equal(notes.result.notesIncluded,true);
  assert.deepEqual(notes.dom.ids,['100','200','300','400']);
  assert.equal(notes.dom.text.match(/THREAD NOTE/g).length,1);
  state('missing');await assert.rejects(capture('https://x.com/demo/status/400'),/親までたどれません/);
  state('cycle');await assert.rejects(capture('https://x.com/demo/status/400'),/繰り返/);
  state('normal');
  const job={cancelled:false};
  await assert.rejects(capturePost(parsePostUrl('https://x.com/demo/status/400'),validateOptions({conversation:'thread'}),job,(_m,p)=>{if(p===19){job.cancelled=true;job.abort?.();}}),/キャンセル/);
  console.log('THREAD_PASS: 4 posts, both modes, full height, quote/branch exclusion, root, missing parent, cycle, cancellation');
}
app.whenReady().then(run).then(()=>app.quit()).catch(e=>{console.error(e.stack);app.exit(1);});
