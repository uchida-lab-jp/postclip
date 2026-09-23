'use strict';
const { app, session, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { capturePost } = require('../app/capture.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
const out = path.resolve(__dirname, '../qa');
app.on('window-all-closed', () => {});

// 動作検証専用の架空投稿を作る。製品にはテストデータを含めない。
function fixture({parent=false,long=false,dark=false,missing=false,more=false}={}) {
  const body = long ? Array.from({length:45},(_,i)=>`<p>確認用の長い投稿 ${i+1} 行目。日本語の輪郭と改行、画像の下端まで記録します。</p>`).join('') : '<p>残しておきたい言葉を、<br>読みやすい一枚に。</p><p>URLを貼るだけ。<br>スマホ幅で、文字までくっきり。</p>';
  const article = (id, text, name) => `<article data-testid="tweet"><header><span class="avatar">P</span><div><b>${name}</b><small>@postclip_sample</small></div><span class="mark">𝕏</span></header><div data-testid="tweetText">${text}</div>${missing?'<img src="https://platform.twitter.com/missing.png" width="200" height="80" alt="missing">':''}${more?'<button data-testid="tweet-text-show-more-link">もっと見る</button>':''}<div class="art"><span>Save a little moment.</span><i></i></div><a href="https://x.com/postclip_sample/status/${id}"><time>2026年9月22日</time></a><footer>♡ 12　↻ 3　◯ 2　　架空サンプル</footer></article>`;
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;padding:0;font-family:'Noto Sans CJK JP',sans-serif;background:${dark?'#15202b':'#fff'};color:${dark?'#eee':'#15251d'}}article{padding:20px 18px;border-bottom:1px solid #dce4d4;width:100%}header{display:flex;gap:10px;align-items:center;font-size:14px;margin-bottom:22px}header div{flex:1}small{display:block;color:#82947c;font:11px Arial;margin-top:4px}.avatar{display:grid;place-items:center;background:#dcedb8;color:#537336;width:39px;height:39px;border-radius:50%;font-weight:bold}.mark{font-size:21px}p{font-size:20px;line-height:1.8;margin:15px 0 18px}.art{height:170px;background:#ebf3dc;color:#7a9258;position:relative;overflow:hidden;border-radius:12px;margin:20px 0}.art span{position:absolute;left:20px;top:23px;font:italic 23px Georgia;width:150px;z-index:1}.art i{position:absolute;right:-20px;top:-30px;border:40px solid #b4ca88;border-radius:50%;width:200px;height:200px}a{font-size:12px;color:#8b9783;text-decoration:none}footer{border-top:1px solid #e3eadb;padding-top:15px;margin-top:15px;color:#8a9681;font-size:12px}button{display:block}</style><body>${parent?article('100','<p>返信先の投稿です。<br>上端が切れていないことを確認します。</p>','返信先サンプル'):''}${article('200',body,'PostClip サンプル')}<div id="bottom-marker">FINISH</div></body></html>`;
}

// httpsを専用セッションだけで置き換え、長文・返信・失敗を再現する。
async function installFixtures() {
  let scenario = {};
  for (const name of ['postclip-embed','persist:postclip-x']) {
    await session.fromPartition(name).protocol.handle('https', request => {
      const u = new URL(request.url);
      if (u.pathname === '/widgets.js') {
        const js = `window.twttr={widgets:{createTweet:async function(id,mount,opts){if(id==='404')return undefined;const iframe=document.createElement('iframe');iframe.style.width=opts.width+'px';iframe.style.height='${scenario.long?7200:scenario.parent?1040:610}px';iframe.src='https://platform.twitter.com/fixture';mount.append(iframe);await new Promise(r=>iframe.onload=r);return iframe;}}};`;
        return new Response(js,{headers:{'content-type':'application/javascript'}});
      }
      if (u.pathname === '/missing.png') return new Response('',{status:404});
      return new Response(fixture(scenario),{headers:{'content-type':'text/html;charset=utf-8'}});
    });
  }
  return value => { scenario=value; };
}

// 実際のPNG寸法を確認し、下端のピクセルまで描画されているか検証する。
async function captureCase(name, optionValues, check) {
  const options=validateOptions({includeNotes:false,...optionValues});
  const result=await capturePost(parsePostUrl('https://x.com/postclip_sample/status/200'),options,{cancelled:false,window:null},()=>{});
  await fs.writeFile(path.join(out,`${name}.png`),result.png);
  assert.equal(result.width,(options.width+options.padding*2)*options.scale);
  assert.ok(result.height>100);
  if(check)check(result);
  process.stdout.write(JSON.stringify({case:name,width:result.width,height:result.height,warnings:result.warnings})+'\n');
  return result;
}

// 本物のXへの疎通は再現テストと区別して結果を記録する。
async function live() {
  const url=process.env.POSTCLIP_LIVE_URL;
  if(!url)throw new Error('POSTCLIP_LIVE_URLに検証する投稿URLを指定してください。');
  const cases=[['live-embed',url,'embed'],['live-page',url,'page']];
  for(const [name,url,mode] of cases) {
    try {
      const result=await capturePost(parsePostUrl(url),validateOptions({mode,includeNotes:false}),{cancelled:false,window:null},message=>process.stdout.write(message+'\n'));
      await fs.writeFile(path.join(out,name+'.png'),result.png);
      process.stdout.write(JSON.stringify({live:name,ok:true,width:result.width,height:result.height,warnings:result.warnings})+'\n');
    } catch(e){process.stdout.write(JSON.stringify({live:name,ok:false,error:e.message})+'\n');}
  }
}

// 同じ撮影処理で高DPI・全高・返信切替・読込失敗・キャンセルを検証する。
async function run() {
  await fs.mkdir(out,{recursive:true});
  if (process.env.POSTCLIP_LIVE === '1') { await live(); return; }
  const scenario=await installFixtures();
  scenario({});
  await captureCase('embed-400-3x',{},r=>assert.equal(r.warnings.length,0));
  scenario({parent:true});
  const withParent=await captureCase('page-parent',{mode:'page',conversation:true});
  const withoutParent=await captureCase('page-single',{mode:'page',conversation:false});
  assert.ok(withParent.height>withoutParent.height+500);
  scenario({long:true});
  const long=await captureCase('page-long',{mode:'page',scale:2},r=>assert.ok(r.height>5000));
  const image=nativeImage.createFromBuffer(long.png);
  const bytes=image.crop({x:0,y:long.height-300,width:long.width,height:300}).toBitmap();
  assert.ok([...bytes].some((b,i)=>i%4!==3&&b<150),'下端付近に本文または罫線の描画が必要');
  scenario({dark:true});
  await captureCase('embed-dark-padding',{width:430,theme:'dark',padding:24,scale:2});
  scenario({missing:true,more:true});
  await captureCase('missing-and-more',{mode:'page'},r=>assert.ok(r.warnings.length>=2));
  scenario({});
  await assert.rejects(()=>capturePost(parsePostUrl('x.com/a/status/404'),validateOptions({includeNotes:false}),{cancelled:false},()=>{}),/埋め込み表示できません/);
  const job={cancelled:false,window:null};
  const promise=capturePost(parsePostUrl('x.com/a/status/200'),validateOptions({includeNotes:false}),job,()=>{});
  setTimeout(()=>{job.cancelled=true;if(job.window&&!job.window.isDestroyed())job.window.destroy();},100);
  await assert.rejects(()=>promise);
  process.stdout.write('SMOKE_PASS\n');
}
app.whenReady().then(run).then(()=>app.quit()).catch(e=>{process.stderr.write(e.stack+'\n');app.exit(1);});
