'use strict';

// 対象の投稿自身へのリンクで記事を特定し、引用内の別投稿と取り違えない。
function inspectPost(id) {
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const match = articles.find(article => {
    const time = article.querySelector('time');
    const primaryLink = time && time.closest('a');
    const path = primaryLink ? new URL(primaryLink.href, location.href).pathname : '';
    if (new RegExp(`/status/${id}/?$`).test(path)) return true;
    // 詳細表示ではタイムスタンプのtime要素がない場合もある。
    if (time) return false;
    return [...article.querySelectorAll('a[href]')].some(a => new RegExp(`/status/${id}/?$`).test(new URL(a.href, location.href).pathname));
  });
  if (match) {
    match.setAttribute('data-postclip-target', id);
    return { found: true, height: match.getBoundingClientRect().height };
  }
  const text = document.body.innerText;
  const unavailable = /このポストは表示できません|このポストは削除|このアカウントは存在しません|This Post is unavailable|This account doesn.t exist|This Post was deleted/i.test(text);
  const loginGate = !articles.length && /ログイン|Sign in|Log in/.test(text) && !!document.querySelector('a[href*="/login"],a[href*="/i/flow/login"],input[autocomplete="username"]');
  return { found: false, unavailable, login: /\/i\/flow\/login/.test(location.pathname) || loginGate };
}

// 本文の展開ボタンだけを操作し、引用や返信先の省略は別途通知する。
function expandPost(id) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) return false;
  const text = article.querySelector('[data-testid="tweetText"]');
  if (!text) return false;
  const button = article.querySelector('[data-testid="tweet-text-show-more-link"]');
  if (button && !button.closest('[role="link"]')) { button.click(); return true; }
  return false;
}

// 表示済みの記事を同じCSSのまま複製し、ナビゲーションや返信一覧を除いて撮影する。
function isolatePost(id, options) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) throw new Error('対象の投稿を見失いました。もう一度作成してください。');
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
  const index = articles.indexOf(article);
  const selected = options.conversation && index > 0 ? [articles[index - 1], article] : [article];
  const root = document.createElement('div');
  root.id = 'postclip-capture';
  const background = getComputedStyle(document.body).backgroundColor;
  root.style.cssText = `position:relative;box-sizing:border-box;width:${options.width + options.padding * 2}px;padding:${options.padding}px;background:${background === 'rgba(0, 0, 0, 0)' ? '#fff' : background};overflow:visible;`;
  const warnings = [];
  for (const source of selected) {
    const clone = source.cloneNode(true);
    clone.style.width = `${options.width}px`;
    clone.style.boxSizing = 'border-box';
    clone.style.maxWidth = 'none';
    clone.querySelectorAll('video').forEach(video => { video.autoplay = false; video.pause(); });
    clone.querySelectorAll('img').forEach(img => { img.loading = 'eager'; });
    root.append(clone);
    if (source.querySelector('[data-testid="tweet-text-show-more-link"]') || /(?:さらに表示|もっと見る|Show more)/.test(source.innerText)) {
      warnings.push('本文・返信先・引用のいずれかに省略表示があります。プレビューで内容を確認してください。');
    }
  }
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0!important;padding:0!important;min-width:0!important;overflow:hidden!important;height:auto!important}body>*:not(#postclip-capture){display:none!important}#postclip-capture *{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.append(style);
  document.body.append(root);
  window.scrollTo(0, 0);
  return { warnings: [...new Set(warnings)], parentIncluded: selected.length > 1, background };
}

// フォントと表示画像の読込完了を待ち、欠落があれば呼出元に伝える。
async function settleAssets() {
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 8000))]);
  const images = [...document.images].filter(img => img.getBoundingClientRect().width > 1);
  const missing = await Promise.all(images.map(async img => {
    img.loading = 'eager';
    if (!img.complete) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); img.removeEventListener('load', finish); img.removeEventListener('error', finish); resolve(); };
      const timer = setTimeout(finish, 10000);
      img.addEventListener('load', finish, { once: true }); img.addEventListener('error', finish, { once: true });
    });
    if (img.complete && img.naturalWidth) { try { await img.decode(); } catch {} }
    return img.naturalWidth === 0;
  }));
  document.querySelectorAll('video').forEach(video => { video.pause(); });
  return { missing: missing.filter(Boolean).length, more: /(?:さらに表示|もっと見る|Show more|Read more)/.test(document.body.innerText), fonts: document.fonts.status };
}

// スクロール位置に依存せず、撮影対象全体の境界を返す。
function measureCapture() {
  const root = document.querySelector('#postclip-capture');
  if (!root) throw new Error('撮影領域がありません。');
  const b = root.getBoundingClientRect();
  return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: Math.max(b.height, root.scrollHeight) };
}

// 埋め込みフレームのDOMとCSSを保存し、低解像度の子フレームから独立させる。
function snapshotEmbeddedFrame() {
  if (!document.querySelector('article')) return null;
  const clone = document.documentElement.cloneNode(true);
  const originalStyles = [...document.querySelectorAll('style')];
  clone.querySelectorAll('style').forEach((style, index) => {
    try { style.textContent = [...originalStyles[index].sheet.cssRules].map(rule => rule.cssText).join('\n'); } catch {}
  });
  clone.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv],link[rel="preload"],link[rel="modulepreload"],link[rel="preconnect"],link[rel="dns-prefetch"]').forEach(el => el.remove());
  clone.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    if (el.tagName === 'IMG') { el.loading = 'eager'; }
  });
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://*.twimg.com https://*.twitter.com https://*.x.com; img-src data: https://*.twimg.com https://*.twitter.com https://*.x.com; font-src data: https://*.twimg.com https://*.twitter.com https://*.x.com; media-src https://*.twimg.com; base-uri 'none'; form-action 'none'";
  clone.querySelector('head').prepend(csp);
  return '<!doctype html>' + clone.outerHTML;
}

// 投稿内容のDOMを変更せず、余白と自動高さの撮影領域だけを追加する。
function wrapEmbedSnapshot(options) {
  const root = document.createElement('div');
  root.id = 'postclip-capture';
  root.style.cssText = `position:relative;box-sizing:border-box;width:${options.width + options.padding * 2}px;padding:${options.padding}px;background:${options.theme === 'dark' ? '#15202b' : '#fff'};overflow:visible;`;
  const inner = document.createElement('div');
  inner.style.cssText = `width:${options.width}px;display:flow-root;`;
  while (document.body.firstChild) inner.append(document.body.firstChild);
  root.append(inner);
  document.body.append(root);
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0!important;padding:0!important;min-width:0!important;height:auto!important;overflow:hidden!important}*{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.append(style);
  window.scrollTo(0, 0);
}

module.exports = { inspectPost, expandPost, isolatePost, settleAssets, measureCapture, snapshotEmbeddedFrame, wrapEmbedSnapshot };
