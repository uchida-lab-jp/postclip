'use strict';
const { app, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { capturePost } = require('../app/capture.cjs');
const { parsePostUrl, validateOptions } = require('../app/core.cjs');
app.on('window-all-closed', () => {});

// 引用記事を含む親と、同じ余白を持つ返信の接続線を新旧Xの構造で再現する。
function fixture(dark, modern) {
  const cell = modern ? 'data-timeline-entry' : 'data-testid="cellInnerDiv"';
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:${dark ? '#15202b' : '#fff'};color:${dark ? '#fff' : '#172d24'};font-family:sans-serif}
  .cell{padding:16px;box-sizing:border-box}.parent{padding-bottom:0}.child{padding-top:0}.row{display:flex;gap:8px}.rail{position:relative;width:40px;flex-shrink:0}.avatar{width:40px;height:40px;border-radius:50%;background:#b4ce9b}
  .parent .line{position:absolute;left:19px;top:44px;bottom:0;width:2px;background:#b9c5ca}.child .line{height:14px;width:2px;background:#b9c5ca;margin:0 0 0 19px}
  .content{flex:1;min-width:0}p{font-size:18px;line-height:1.6}.quote{border:1px solid #b9c5ca;border-radius:12px;padding:12px}.quote-media{height:180px;background:#e6e9cf;margin-top:12px}
  .note{border:1px solid #b9c5ca;border-radius:12px;padding:12px;margin:12px 0}.note div{font-size:15px;line-height:1.7}footer{padding:16px 0;font-size:12px}
  </style><body><div ${cell} class="cell parent"><article><div class="row"><div class="rail"><div class="avatar" data-avatar="parent"></div><div class="line" data-line="parent"></div></div><div class="content"><b>返信先の親</b><a href="https://x.com/demo/status/100"><time>9月23日</time></a><p>親の投稿には引用があり、左右の余白と接続線を保ちます。</p><div role="link" class="quote"><article><b>引用した投稿</b><a href="https://x.com/quote/status/999"><time>9月22日</time></a><p>引用の右端まで画像に収めます。</p><div class="quote-media" data-quote-edge></div></article></div><footer>親の投稿の下端</footer></div></div></article></div>
  <div ${cell} class="cell child"><article><div class="line" data-line="child"></div><div class="row"><div class="avatar" data-avatar="child"></div><b>指定した投稿</b></div><p data-testid="tweetText">返信の本文です。左の線が親と一直線につながります。</p><div class="note" data-testid="birdwatch-pivot"><div>Readers added context</div><div>架空のコミュニティノートです。本文も省略せずに保存します。</div></div><a href="https://x.com/demo/status/200"><time>9月23日</time></a><footer>返信の下端</footer></article></div></body>`;
}

// 撮影直前の接続線・アイコンの中心と、引用枠の右端を実ピクセルの描画範囲で確認する。
async function capture(values) {
  const job = { cancelled: false }; let metrics;
  const result = await capturePost(parsePostUrl('https://x.com/demo/status/200'), validateOptions({ conversation: 'parent', includeNotes: true, ...values }), job, (_m, p) => {
    if (p === 88) metrics = job.window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('#postclip-capture');
      const box = e => { const b=e.getBoundingClientRect(); return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,center:b.left+b.width/2}; };
      return {lines:[...root.querySelectorAll('[data-line]')].map(box),avatars:[...root.querySelectorAll('[data-avatar]')].map(box),quote:box(root.querySelector('[data-quote-edge]')),root:box(root)};
    })()`);
  });
  return { result, metrics: await metrics };
}

// 320〜550pxと余白・ダーク設定で、引用のある親を含むPNGを検証する。
async function run() {
  let current;
  session.fromPartition('persist:postclip-x').protocol.handle('https', () => new Response(fixture(current.theme === 'dark', current.modern), {headers:{'content-type':'text/html;charset=utf-8'}}));
  for (current of [{width:430,padding:0,modern:true}, {width:320,padding:16,modern:false}, {width:550,padding:24,theme:'dark',modern:true}]) {
    const {result,metrics:m}=await capture(current);
    assert.ok(Math.abs(m.lines[0].center-m.lines[1].center)<0.25, `接続線のずれ: ${JSON.stringify(m.lines)}`);
    assert.ok(Math.abs(m.avatars[0].center-m.avatars[1].center)<0.25, '親と返信のアイコン位置');
    assert.ok(Math.abs(m.lines[0].bottom-m.lines[1].top)<0.25, '接続線の縦方向の隙間');
    assert.ok(m.quote.right <= m.root.right-current.padding, '引用の右端が切れていないこと');
    assert.equal(result.parentIncluded,true);assert.equal(result.notesIncluded,true);
    await fs.mkdir(path.resolve(__dirname,'../qa'),{recursive:true});
    await fs.writeFile(path.resolve(__dirname,`../qa/parent-layout-${current.width}.png`),result.png);
    console.log('PARENT_LAYOUT',JSON.stringify({width:current.width,metrics:m}));
  }
}
app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1);});
