'use strict';

// t.coのHTML転送ページからURLだけを読み、転送用JavaScriptは実行しない。
function readShortRedirect(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = [...doc.querySelectorAll('meta[http-equiv]')].find(node => node.getAttribute('http-equiv').toLowerCase() === 'refresh');
  return meta?.getAttribute('content')?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*["']?(.*?)["']?\s*$/i)?.[1] || null;
}

// 撮影対象の本文・引用・Grok添付だけを調べ、メニューや返信一覧を展開対象から外す。
function inspectFullContent(id, conversation, action = 'inspect', key = '') {
  const target = id && document.querySelector(`[data-postclip-target="${id}"]`);
  const articles = [...document.querySelectorAll('article')].filter(a => !a.parentElement.closest('article'));
  const index = articles.indexOf(target);
  const selected = target ? (conversation === 'parent' && index > 0 ? [articles[index - 1], target] : [target]) : [document.querySelector('#postclip-capture')].filter(Boolean);
  const bodySelector = '[data-testid="tweetText"],[dir="auto"].whitespace-pre-wrap,.Tweet-text';
  const moreLabel = /^(?:さらに表示|もっと見る|Show more|Read more)$/i;
  const grokLabel = /^(?:Grokによる回答|(?:Response|Answer) by Grok)$/i;
  // 同じDOMを複製した後も、補完先と読み込んだ全文の対応を保つ。
  const mark = (node, attribute) => {
    if (!node.hasAttribute(attribute)) node.setAttribute(attribute, `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    return node.getAttribute(attribute);
  };
  // Xの共有URLと短縮URLだけを添付候補として扱う。
  const attachmentUrl = value => {
    try {
      const u = new URL(value, document.baseURI);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
      if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname) && /^\/i\/grok\/share\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) return u.href;
      if (u.hostname === 't.co' && /^\/[A-Za-z0-9]+$/.test(u.pathname)) return u.href;
    } catch {}
    return null;
  };
  // 非表示の見出しや三点メニューを、本文の省略として数えない。
  const visible = node => !node.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
  // 引用自身のURLだけを照合し、本文中のリンクを引用元と取り違えない。
  const postUrl = value => {
    if (!value) return null;
    try {
      const u = new URL(value, document.baseURI);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)) return null;
      const match = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status|i\/status)\/(\d+)(?:\/history)?\/?$/);
      return match ? u.origin + u.pathname.replace(/\/history\/?$/, '') : null;
    } catch { return null; }
  };
  // カードが属する投稿・引用の時刻リンクを確認し、別の投稿の共有先を混ぜない。
  const containingPostUrl = (card, source) => {
    let node = card;
    while (node && source.contains(node)) {
      if (node.matches('article,[role="link"],[data-slot="embedded-tweet-frame"]')) {
        const direct = postUrl(node.getAttribute('data-href') || node.getAttribute('href') || '');
        if (direct) return direct;
        const candidates = [];
        for (const link of node.querySelectorAll('a[href]')) {
          if (link.closest(bodySelector)) continue;
          if (node.matches('article') && link.closest('article') !== node) continue;
          const quote = link.parentElement.closest('[role="link"]');
          if (quote && quote !== node && node.contains(quote)) continue;
          const url = postUrl(link.href);
          if (url && link.querySelector('time')) return url;
          if (url && !candidates.includes(url)) candidates.push(url);
        }
        const markedId = node.getAttribute('data-postclip-target');
        const matched = markedId && candidates.find(url => new URL(url).pathname.match(/\/status\/(\d+)/)?.[1] === markedId);
        if (matched) return matched;
        if (candidates.length === 1) return candidates[0];
      }
      if (node === source) break;
      node = node.parentElement;
    }
    return null;
  };
  // カード内にtweetTextがあっても、Grokの見出しと添付の境界でカード全体を特定する。
  const findGrokCards = source => {
    const cards = [...source.querySelectorAll('[data-testid="card.wrapper"],[data-slot="grok-share-card"]')].filter(node => /(?:Grokによる回答|(?:Response|Answer) by Grok)/i.test(node.innerText || '') && !node.querySelector('article'));
    for (const label of source.querySelectorAll('div,span,p')) {
      if (!grokLabel.test(label.textContent.trim()) || label.closest('[data-postclip-full-resource]')) continue;
      let node = label.parentElement;
      while (node && node !== source && !node.matches('article')) {
        if (node.querySelector('article,time')) break;
        if (node.querySelector(bodySelector) || [...node.querySelectorAll('button,a,span,[role="button"]')].some(el => moreLabel.test(el.textContent.trim()))) {
          if (!cards.some(card => card.contains(node))) cards.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return cards.filter(node => !cards.some(other => other !== node && other.contains(node)));
  };
  // カード自身の描画データにある共有URLだけを集め、ページ全体の状態やログイン情報は返さない。
  const runtimeCardUrls = card => {
    const urls = new Set(), visited = new WeakSet();
    let remaining = 6000;
    // Reactの参照循環やDOM・関数をたどらず、表示用の値だけを調べる。
    const inspect = (value, depth = 0) => {
      if (remaining-- <= 0 || depth > 12 || value == null) return;
      if (typeof value === 'string') {
        if (value.length > 100000) return;
        for (const candidate of value.replace(/\\\//g, '/').match(/https:\/\/[^\s<>"'\\]+/g) || []) {
          const url = attachmentUrl(candidate);
          if (url) urls.add(url);
        }
        return;
      }
      if (typeof value !== 'object' || value instanceof Node || visited.has(value)) return;
      visited.add(value);
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (['_owner', '_store', 'return', 'stateNode', 'alternate', 'ref'].includes(name) || !('value' in descriptor)) continue;
        inspect(descriptor.value, depth + 1);
      }
    };
    for (const node of [card, ...card.querySelectorAll('*')]) {
      for (const name of Object.keys(node)) {
        const value = Object.getOwnPropertyDescriptor(node, name)?.value;
        if (name.startsWith('__reactProps$')) inspect(value);
        if (!/^__react(?:Fiber|InternalInstance)\$/.test(name)) continue;
        let fiber = value;
        for (let depth = 0; fiber && typeof fiber === 'object' && depth < 20; depth++) {
          const props = Object.getOwnPropertyDescriptors(fiber);
          const host = props.stateNode?.value;
          if (host instanceof Element && !card.contains(host)) break;
          inspect(props.memoizedProps?.value); inspect(props.pendingProps?.value);
          fiber = props.return?.value;
        }
      }
      if (remaining <= 0) break;
    }
    return [...urls];
  };
  const resources = [], controls = [], clipped = [], unresolved = [];
  for (const source of selected) {
    const owner = mark(source, 'data-postclip-content-owner');
    const grokCards = findGrokCards(source);
    // 引用内の添付は引用自身へ配置し、外側の親投稿の添付にしない。
    const resourceOwner = node => {
      for (let parent = node.parentElement; parent && source.contains(parent); parent = parent.parentElement) {
        if (parent.matches('article,[role="link"],[data-slot="embedded-tweet-frame"]') && !grokCards.includes(parent)) return mark(parent, 'data-postclip-content-owner');
        if (parent === source) break;
      }
      return owner;
    };
    const sourceResources = [];
    for (const link of source.querySelectorAll('a[href],[data-href]')) {
      if (link.closest('[data-postclip-full-resource]')) continue;
      const url = attachmentUrl(link.getAttribute('href') || link.getAttribute('data-href'));
      if (!url) continue;
      let card = grokCards.find(node => node.contains(link)) || link.closest('[data-testid="card.wrapper"],[data-slot="grok-share-card"]');
      const direct = /\/i\/grok\/share\//.test(url);
      if (!card && !direct) continue;
      if (card && card.querySelector('article')) card = null;
      const replace = !!card && !card.matches(bodySelector);
      const node = replace ? card : link;
      const resourceKey = mark(node, 'data-postclip-resource');
      if (!sourceResources.some(item => item.key === resourceKey || item.url === url)) sourceResources.push({ key: resourceKey, owner, url, replace, required: true });
    }
    // DOM内のリンクが省かれるカードは、この投稿自身の公開メタデータと対応付ける。
    if (source === target && !target.querySelector('[data-postclip-full-resource]')) {
      const description = document.querySelector('meta[property="og:description"]')?.content || '';
      const canonical = document.querySelector('meta[property="og:url"]')?.content || document.querySelector('link[rel="canonical"]')?.href || location.href;
      let matches = false;
      try { matches = new URL(canonical, document.baseURI).pathname.match(/\/status\/(\d+)(?:\/history)?\/?$/)?.[1] === id; } catch {}
      if (matches) for (const value of description.match(/https:\/\/[^\s<>"「」]+/g) || []) {
        const url = attachmentUrl(value);
        if (!url || sourceResources.some(item => item.url === url)) continue;
        const orphan = grokCards.find(node => !sourceResources.some(item => item.key === node.getAttribute('data-postclip-resource')));
        sourceResources.push({ key: orphan ? mark(orphan, 'data-postclip-resource') : `metadata-${sourceResources.length}`, owner, url, replace: !!orphan, required: !!orphan || /\/i\/grok\/share\//.test(url) });
      }
    }
    for (const item of sourceResources) {
      const node = source.querySelector(`[data-postclip-resource="${item.key}"]`) || source;
      item.postUrl = containingPostUrl(node, source);
      item.owner = resourceOwner(node);
      if (grokCards.includes(node)) {
        const firstLine = (node.innerText || '').trim().split('\n')[0].trim();
        item.question = grokLabel.test(firstLine) ? '' : firstLine;
        item.preview = node.querySelector(bodySelector)?.textContent.trim() || '';
      }
    }
    resources.push(...sourceResources);
    for (const card of grokCards) if (!sourceResources.some(item => item.replace && item.key === card.getAttribute('data-postclip-resource'))) {
      const firstLine = (card.innerText || '').trim().split('\n')[0].trim();
      const question = grokLabel.test(firstLine) ? '' : firstLine;
      const preview = card.querySelector(bodySelector)?.textContent.trim() || '';
      unresolved.push({ key: mark(card, 'data-postclip-resource'), owner: resourceOwner(card), postUrl: containingPostUrl(card, source), question, preview, candidates: runtimeCardUrls(card), replace: true });
    }
    for (const node of source.querySelectorAll('[data-testid="tweet-text-show-more-link"],button,a,[role="button"]')) {
      if (node.closest('[data-postclip-full-resource]') || node.hasAttribute('aria-haspopup') || !visible(node)) continue;
      if (!moreLabel.test((node.textContent || '').trim())) continue;
      if (grokCards.some(card => card.contains(node))) continue;
      const body = node.closest(bodySelector) || (node.parentElement.querySelector(bodySelector));
      if (!body && node.getAttribute('data-testid') !== 'tweet-text-show-more-link') continue;
      let href = node.tagName === 'A' ? node.href : null;
      if (href) {
        try {
          const u = new URL(href);
          if (u.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname) || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(u.pathname)) href = null;
        } catch { href = null; }
      }
      const controlKey = mark(node, 'data-postclip-expand');
      const bodyKey = body ? mark(body, 'data-postclip-body') : null;
      controls.push({ key: controlKey, bodyKey, url: href, label: node.textContent.trim(), text: body?.textContent.replace(moreLabel, '').trim() || '' });
      if (action === 'expand' && controlKey === key && !href) { node.scrollIntoView({ block: 'center' }); node.click(); return { clicked: true }; }
    }
    for (const body of source.querySelectorAll(bodySelector + ',[data-postclip-full-resource]')) {
      if (!visible(body)) continue;
      if (grokCards.some(card => card.contains(body))) continue;
      const style = getComputedStyle(body);
      const cut = ((parseInt(style.webkitLineClamp, 10) > 0 || ['hidden', 'clip'].includes(style.overflowY)) && body.scrollHeight > body.clientHeight + 2) || body.scrollWidth > body.clientWidth + 2;
      if (!cut) continue;
      const bodyKey = mark(body, 'data-postclip-body');
      clipped.push(bodyKey);
      if (controls.some(item => item.bodyKey === bodyKey) || body.matches('[data-postclip-full-resource]')) continue;
      const quote = body.closest('[role="link"],[data-slot="embedded-tweet-frame"]');
      if (!quote || !source.contains(quote)) continue;
      const url = containingPostUrl(body, quote);
      const ownerUrl = !url && source.matches('article') ? containingPostUrl(source, source) : null;
      if (!url && !ownerUrl) continue;
      const removeKeys = [...quote.querySelectorAll('span,button,a,[role="button"]')].filter(node => moreLabel.test(node.textContent.trim()) && !node.hasAttribute('aria-haspopup')).map(node => mark(node, 'data-postclip-expand'));
      controls.push({ key: `clipped-${bodyKey}`, bodyKey, url, ownerUrl, label: '引用の省略', text: body.textContent.trim(), removeKeys });
    }
  }
  // 引用元を読む際は、入れ子の添付ではなく取得する投稿自身の本文を検証する。
  if (conversation === 'body' && target) {
    const body = [...target.querySelectorAll(bodySelector)].find(node => node.closest('article') === target && !node.closest('[role="link"]'));
    const bodyKey = body && mark(body, 'data-postclip-body');
    return { controls: controls.filter(item => item.bodyKey === bodyKey), resources: [], clipped: clipped.filter(key => key === bodyKey), unresolved: [], pending: !body || !!body.querySelector('[role="progressbar"],[aria-busy="true"]'), signature: body?.innerText || '' };
  }
  return { controls, resources, clipped, unresolved, pending: selected.some(source => [...source.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible)), signature: selected.map(source => source.innerText).join('\n') };
}

// 投稿URLがHTMLにない引用を本文で一意に照合し、補助画面内でカード自身を開く。
function openQuotedPost(id, text) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) return false;
  // 省略記号を除いた本文の先頭で引用カードを照合する。
  const normalize = value => value.replace(/\s*(?:さらに表示|もっと見る|Show more|Read more)\s*$/i, '').replace(/[.…]+$/, '').replace(/\s+/g, '').slice(0, 80);
  const prefix = normalize(text);
  if (!prefix) return false;
  const matches = new Set();
  for (const body of article.querySelectorAll('[data-testid="tweetText"],[dir="auto"].whitespace-pre-wrap,.Tweet-text')) {
    const quote = body.closest('[role="link"],[data-slot="embedded-tweet-frame"]');
    if (quote && article.contains(quote) && normalize(body.textContent) === prefix) matches.add(quote);
  }
  if (matches.size !== 1) return false;
  const quote = [...matches][0];
  quote.scrollIntoView({ block: 'center' });
  quote.click();
  return true;
}

// 公開されたGrok共有ページから質問と回答を取り出し、実行コードを持ち込まないHTMLにする。
function readGrokContent(expectedPath) {
  if (location.pathname.replace(/\/$/, '') !== expectedPath.replace(/\/$/, '')) throw new Error('Grok回答の共有先が一致しません。');
  const main = document.querySelector('main');
  const heading = main?.querySelector('h1');
  const root = heading?.nextElementSibling;
  if (!root || !root.querySelector('p,[data-streamdown]')) return null;
  if (root.querySelector('[role="progressbar"],[aria-busy="true"]')) return null;
  const controls = [...root.querySelectorAll('button,a,[role="button"]')].filter(node => /^(?:さらに表示|もっと見る|Show more|Read more)$/i.test(node.textContent.trim()) && !node.hasAttribute('aria-haspopup'));
  if (controls.length) throw new Error('Grok共有ページにも省略が残っています。全文を確認できないため保存を止めました。');
  // 質問の吹き出しごとに次の回答を区切り、会話履歴をひとつの回答へ混ぜない。
  const bubbles = [...root.querySelectorAll('.items-end .whitespace-pre-wrap')];
  const questions = (bubbles.length ? bubbles : [...root.querySelectorAll('.whitespace-pre-wrap')])
    .filter(node => !node.closest('pre,code,[data-streamdown]') && !node.parentElement.closest('.whitespace-pre-wrap'));
  if (!questions.length) return null;
  const turns = [];
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i].textContent.trim();
    const range = document.createRange();
    range.setStartAfter(questions[i]);
    if (questions[i + 1]) range.setEndBefore(questions[i + 1]);
    else range.setEnd(root, root.childNodes.length);
    const clone = document.createElement('div');
    clone.append(range.cloneContents());
    if (!clone.querySelector('p,[data-streamdown]')) return null;
    clone.querySelectorAll('script,style,iframe,object,embed,form,input,button,svg,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
    for (const node of [...clone.querySelectorAll('*')]) {
      const link = node.tagName === 'A' ? node.href : null;
      const image = node.tagName === 'IMG' ? node.src : null;
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
      if (link && /^https:\/\//.test(link)) node.setAttribute('href', link);
      if (image && /^https:\/\/[^/]*\.(?:twimg|x|twitter)\.com\//.test(image)) node.setAttribute('src', image);
      if (!['DIV','SPAN','P','BR','A','IMG','STRONG','B','EM','I','S','U','UL','OL','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','CODE','TABLE','THEAD','TBODY','TR','TH','TD','HR','SUP','SUB'].includes(node.tagName)) node.replaceWith(...node.childNodes);
    }
    const text = clone.textContent.trim();
    if (text.length < 20 || !question) return null;
    if (text.length > 1000000) throw new Error('Grok回答が長すぎて一枚に保存できません。');
    turns.push({ question, html: clone.innerHTML, text });
  }
  return { title: heading.textContent.trim(), ...turns[turns.length - 1], turns, url: location.href };
}

// 別途開いた引用元から、投稿自身の展開済み本文だけを読み取る。
function readFullPostBody(id) {
  const article = document.querySelector(`[data-postclip-target="${id}"]`);
  if (!article) return null;
  const body = [...article.querySelectorAll('[data-testid="tweetText"],[dir="auto"].whitespace-pre-wrap')].find(node => node.closest('article') === article && !node.closest('[role="link"]'));
  if (!body) return null;
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script,style,iframe,object,embed,button').forEach(node => node.remove());
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    if (node.tagName === 'A') node.setAttribute('href', new URL(node.getAttribute('href'), document.baseURI).href);
  }
  return { html: clone.innerHTML, text: clone.textContent.trim() };
}

// 押されたGrokカードが属する表示済みの記事URLを、本文や引用のリンクと区別して返す。
function readGrokRequest(key) {
  const card = document.querySelector(`[data-postclip-expand-request="${key}"]`);
  if (!card || !/(?:Grokによる回答|(?:Response|Answer) by Grok)/i.test(card.innerText || '')) return null;
  let article = card.closest('article');
  while (article?.parentElement.closest('article')) article = article.parentElement.closest('article');
  if (!article) return null;
  const links = [...article.querySelectorAll('a[href]')].filter(link => {
    if (link.closest('article') !== article || link.closest('[data-testid="tweetText"],[dir="auto"].whitespace-pre-wrap,[data-slot="embedded-tweet-frame"]')) return false;
    const quote = link.parentElement.closest('[role="link"]');
    if (quote && article.contains(quote)) return false;
    try {
      const u = new URL(link.href);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname) && /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status|i\/status)\/\d+(?:\/history)?\/?$/.test(u.pathname);
    } catch { return false; }
  });
  const link = links.find(node => node.querySelector('time')) || (new Set(links.map(node => node.href)).size === 1 ? links[0] : null);
  return link?.href.replace(/\/history\/?$/, '') || null;
}

// 読み取った全文を撮影用の複製へ差し込み、元のX画面を切り貼りしない。
function applyFullContent(items) {
  for (const item of items) {
    if (item.kind === 'post') {
      const body = document.querySelector(`[data-postclip-body="${item.bodyKey}"]`);
      if (!body) throw new Error('引用本文の配置先を確認できませんでした。');
      body.innerHTML = item.content.html;
      body.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      body.style.setProperty('max-height', 'none', 'important');
      body.style.setProperty('overflow', 'visible', 'important');
      body.style.setProperty('overflow-wrap', 'anywhere', 'important');
      document.querySelector(`[data-postclip-expand="${item.key}"]`)?.remove();
      for (const key of item.removeKeys || []) document.querySelector(`[data-postclip-expand="${key}"]`)?.remove();
      continue;
    }
    const owner = document.querySelector(`[data-postclip-content-owner="${item.owner}"]`);
    if (!owner) throw new Error('Grok回答を含む投稿を確認できませんでした。');
    if ([...owner.querySelectorAll('[data-postclip-full-resource]')].some(node => node.getAttribute('data-postclip-full-resource') === item.content.url)) continue;
    const old = document.querySelector(`[data-postclip-resource="${item.key}"]`);
    const card = document.createElement('section');
    card.setAttribute('data-postclip-full-resource', item.content.url);
    card.style.cssText = 'box-sizing:border-box;border:1px solid #8899aa55;border-radius:16px;padding:14px;margin:12px 0;width:100%;max-width:100%;font-size:15px;line-height:1.65;overflow-wrap:anywhere;color:inherit;';
    const label = document.createElement('a');
    label.textContent = 'Grokによる回答 · 全文';
    label.href = item.content.url;
    label.style.cssText = 'display:block;font-size:13px;color:inherit;opacity:.75;margin-bottom:8px;';
    const question = document.createElement('div');
    question.textContent = item.content.question;
    question.style.cssText = 'font-weight:700;white-space:pre-wrap;margin-bottom:12px;';
    const answer = document.createElement('div');
    answer.className = 'postclip-grok-answer';
    answer.innerHTML = item.content.html;
    for (const node of answer.querySelectorAll('p,ul,ol,blockquote,pre,table')) node.style.cssText = 'margin:10px 0;max-width:100%;';
    for (const node of answer.querySelectorAll('ul,ol')) node.style.paddingInlineStart = '22px';
    for (const node of answer.querySelectorAll('ul')) node.style.listStyleType = 'disc';
    for (const node of answer.querySelectorAll('ol')) node.style.listStyleType = 'decimal';
    for (const node of answer.querySelectorAll('h1,h2,h3,h4,h5,h6')) node.style.cssText = 'font-weight:700;font-size:1.05em;margin:16px 0 8px;';
    for (const node of answer.querySelectorAll('pre')) node.style.whiteSpace = 'pre-wrap';
    for (const node of answer.querySelectorAll('img')) node.style.maxWidth = '100%';
    card.append(label, question, answer);
    if (item.replace) {
      if (!old || !owner.contains(old)) throw new Error('Grokカードの配置先が変わりました。再試行してください。');
      old.replaceWith(card);
    } else {
      const body = [...owner.querySelectorAll('[data-testid="tweetText"],[dir="auto"].whitespace-pre-wrap')].find(node => node.closest('article') === owner && !node.closest('[role="link"]'));
      if (body) body.after(card); else owner.append(card);
    }
  }
  return items.length;
}

module.exports = { readShortRedirect, inspectFullContent, openQuotedPost, readGrokContent, readFullPostBody, readGrokRequest, applyFullContent };
