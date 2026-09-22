'use strict';
const installed = new WeakSet();

// Xの表示に必要な配信元だけを許可し、第三者の解析・診断送信を遮断する。
function allowedRequest(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'postclip:') return u.hostname === 'capture' && ['/embed.html', '/embed.js', '/embed.css'].includes(u.pathname);
    if (['file:', 'data:', 'blob:', 'about:'].includes(u.protocol)) return true;
    if (u.protocol !== 'https:') return false;
    return ['x.com', 'twitter.com', 'twimg.com'].some(domain => u.hostname === domain || u.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

// 撮影とログインのセッションに同じ通信制限を適用する。
function restrictNetwork(session) {
  if (installed.has(session)) return;
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url) }));
  installed.add(session);
}

module.exports = { allowedRequest, restrictNetwork };
