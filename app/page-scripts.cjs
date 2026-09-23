'use strict';

// 対象の投稿自身へのリンクで記事を特定し、引用内の別投稿と取り違えない。
function inspectPost(id) {
  const articles = [...document.querySelectorAll('article')].filter(a => !a.parentElement.closest('article'));
  const match = articles.find(article => {
    // 引用・本文のリンクを外し、新旧X画面の投稿自身のリンクだけを比較する。
    const ownLinks = [...article.querySelectorAll('a[href]')].filter(a => {
      const quote = a.parentElement.closest('[role="link"]');
      return a.closest('article') === article && !a.closest('[data-testid="tweetText"]') && (!quote || !article.contains(quote));
    });
    const time = ownLinks.map(a => a.querySelector('time')).find(Boolean);
    const primaryLink = time && time.closest('a');
    const path = primaryLink ? new URL(primaryLink.href, location.href).pathname : '';
    if (new RegExp(`/status/${id}/?$`).test(path)) return true;
    // 詳細表示ではタイムスタンプのtime要素がない場合もある。
    if (time) return false;
    return ownLinks.some(a => new RegExp(`/status/${id}/?$`).test(new URL(a.href, location.href).pathname));
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

// 対象記事に属するノート本文を特定し、リンクだけ・引用・返信のノートを区別する。
function inspectCommunityNote(id) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) return { found: false };
  const cell = article.closest('[data-testid="cellInnerDiv"], [data-timeline-entry]');
  const scope = cell && [...cell.querySelectorAll('article')].every(a => a === article || article.contains(a)) ? cell : article;
  // Xのノートカードに実在する見出しと、ノート詳細リンクを組み合わせて調べる。
  const heading = /^(?:閲覧したユーザーが(?:他のユーザーにとって役立つと思う)?背景情報を追加しました|読者が背景情報を追加しました|Readers added context(?: they thought people might want to know)?|Readers added a community note)$/i;
  const selectors = '[data-testid="birdwatch-pivot"], [data-testid="birdwatch-pivot-note"], [data-testid="communityNote"], a[href*="/i/birdwatch/n/"], a[href*="/i/communitynotes/"]';
  const candidates = [...scope.querySelectorAll(selectors)];
  for (const el of scope.querySelectorAll('span,div')) {
    if (heading.test(el.textContent.trim()) && ![...el.children].some(c => heading.test(c.textContent.trim()))) candidates.push(el);
  }
  let hint = false;
  for (const marker of candidates) {
    if (marker.closest('[data-testid="tweetText"]')) continue;
    const owner = marker.closest('article');
    if (owner && owner !== article) continue;
    const quote = marker.parentElement.closest('[role="link"]');
    if (quote && article.contains(quote) && quote.querySelector('a[href*="/status/"]')) continue;
    if (marker.matches(selectors)) hint = true;
    let node = marker;
    while (node && node !== scope && node !== article) {
      const text = (node.innerText || '').trim();
      const hasHeading = [...node.querySelectorAll('span,div')].some(e => heading.test(e.textContent.trim())) || heading.test(node.getAttribute('aria-label') || '');
      // 投稿本文までさかのぼってノートと誤認しない。ノートの本文領域が必要。
      const body = text.split('\n').filter(line => !heading.test(line.trim())).join('').trim();
      const identified = node.matches(selectors) || !!node.querySelector(selectors);
      if (identified && hasHeading && body.length >= 12 && !node.querySelector('[data-testid="tweetText"],time,a[href*="/status/"]')) {
        node.setAttribute('data-postclip-note', id);
        return { found: true, text, signature: text, external: !article.contains(node) };
      }
      node = node.parentElement;
    }
  }
  return { found: false, hint, pending: !!scope.querySelector('[role="progressbar"],[aria-busy="true"]') };
}

// 返信先を含む対象投稿と写真を可視領域へ送り、Xの遅延表示を開始する。
async function revealPost(id, conversation) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) return;
  const articles = [...document.querySelectorAll('article')].filter(a => !a.parentElement.closest('article'));
  const index = articles.indexOf(article);
  const selected = conversation === 'parent' && index > 0 ? [articles[index - 1], article] : [article];
  for (const source of selected) {
    source.scrollIntoView({ block: 'start' });
    await new Promise(resolve => setTimeout(resolve, 200));
    const media = [...source.querySelectorAll('a[href*="/photo/"],img, [data-testid="birdwatch-pivot"]')];
    for (const node of media.slice(0, 12)) {
      if (node.tagName === 'IMG') node.loading = 'eager';
      node.scrollIntoView({ block: 'center' });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  article.scrollIntoView({ block: 'end' });
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
  const articles = [...document.querySelectorAll('article')].filter(a => !a.parentElement.closest('article'));
  const index = articles.indexOf(article);
  const selected = options.conversation === 'parent' && index > 0 ? [articles[index - 1], article] : [article];
  const root = document.createElement('div');
  root.id = 'postclip-capture';
  const background = getComputedStyle(document.body).backgroundColor;
  root.style.cssText = `position:relative;box-sizing:border-box;width:${options.width + options.padding * 2}px;padding:${options.padding}px;background:${background === 'rgba(0, 0, 0, 0)' ? '#fff' : background};overflow:visible;`;
  const warnings = [];
  for (const source of selected) {
    const cell = source.closest('[data-testid="cellInnerDiv"], [data-timeline-entry]');
    // 引用記事は同じ投稿の内容なので、記事数ではなく所属で外枠の保持を判断する。
    const container = cell && [...cell.querySelectorAll('article')].every(a => a === source || source.contains(a)) ? cell : source;
    const clone = container.cloneNode(true);
    clone.style.width = `${options.width}px`;
    clone.style.boxSizing = 'border-box';
    clone.style.maxWidth = 'none';
    clone.style.position = 'relative';
    clone.style.transform = 'none';
    clone.style.top = 'auto';
    // 祖先が持つ色・余白などのCSS変数を、切り出した投稿へ引き継ぐ。
    const computed = getComputedStyle(container);
    for (const name of computed) if (name.startsWith('--')) clone.style.setProperty(name, computed.getPropertyValue(name));
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
  const notesIncluded = !!root.querySelector(`[data-postclip-note="${id}"]`);
  if (options.noteExpected && !notesIncluded) throw new Error('読み込んだコミュニティノートを撮影範囲に含められませんでした。もう一度作成してください。');
  return { warnings: [...new Set(warnings)], parentIncluded: selected.length > 1, notesIncluded, background };
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
  const capture = clone.querySelector('#postclip-capture');
  if (capture) clone.querySelector('body').replaceChildren(capture);
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://*.twimg.com https://*.twitter.com https://*.x.com; img-src data: https://*.twimg.com https://*.twitter.com https://*.x.com; font-src data: https://*.twimg.com https://*.twitter.com https://*.x.com; media-src https://*.twimg.com; base-uri 'none'; form-action 'none'";
  clone.querySelector('head').prepend(csp);
  return '<!doctype html>' + clone.outerHTML;
}

// 公式埋め込みの主投稿を照合し、本文や引用内のリンクを返信先と取り違えない。
function inspectEmbeddedParent(id) {
  // 許可した投稿URLだけを照合し、画像番号付きリンクも親候補から外す。
  const postLink = value => {
    try {
      const u = new URL(value, location.href);
      const m = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status|i\/status)\/(\d{1,25})\/?$/);
      if (u.protocol !== 'https:' || !['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(u.hostname) || u.username || u.password || u.port || !m) return null;
      return { id: m[1], url: `https://x.com${u.pathname}` };
    } catch { return null; }
  };
  const article = [...document.querySelectorAll('article')].find(a => !a.parentElement.closest('article'));
  if (!article) throw new Error('投稿の構造を確認できませんでした。');
  const ownLinks = [...article.querySelectorAll('a[href]')].filter(a =>
    a.closest('article') === article && !a.closest('[data-testid="tweetText"]') && !a.parentElement.closest('[role="link"]'));
  if (!ownLinks.some(a => postLink(a.href)?.id === id)) throw new Error('指定した投稿と表示内容が一致しませんでした。');
  const reply = ownLinks.filter(a => /^(?:返信先\s*[:：]|Replying to\b)/i.test(a.textContent.trim()));
  if (reply.length > 1) throw new Error('返信先を一意に確認できませんでした。');
  if (reply.length === 1) {
    const parent = postLink(reply[0].href);
    if (!parent || parent.id === id) throw new Error('返信先の投稿URLを確認できませんでした。');
    return { parentUrl: parent.url };
  }
  // 返信表示がリンク以外に変わった場合は先頭と決めつけず、取得を止める。
  const own = article.cloneNode(true);
  own.querySelectorAll('article,[role="link"],[data-testid="tweetText"]').forEach(node => node.remove());
  if (/(?:返信先\s*[:：]|Replying to\b)/i.test(own.textContent)) throw new Error('返信先はありますが、投稿URLを確認できませんでした。');
  return { parentUrl: null };
}

// 各投稿の静的DOMを古い順に同じ描画面へ並べ、文字を指定解像度で描き直す。
function mountThreadSnapshots(items, options) {
  const parser = new DOMParser();
  document.body.replaceChildren();
  for (const item of items) {
    const parsed = parser.parseFromString(item.snapshot, 'text/html');
    parsed.head.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => document.head.append(document.importNode(node, true)));
    const section = document.createElement('section');
    section.dataset.postclipId = item.post.id;
    section.style.cssText = `display:flow-root;width:${options.width}px;position:relative;`;
    // 投稿画面の場合は撮影対象だけを取り出し、周辺のナビゲーションを含めない。
    const body = options.mode === 'page' ? parsed.querySelector('#postclip-capture') : parsed.body;
    if (!body) throw new Error('投稿の撮影領域がありません。');
    while (body.firstChild) section.append(body.firstChild);
    document.body.append(section);
  }
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

module.exports = { inspectPost, inspectCommunityNote, revealPost, expandPost, isolatePost, settleAssets, measureCapture, snapshotEmbeddedFrame, wrapEmbedSnapshot, inspectEmbeddedParent, mountThreadSnapshots };
