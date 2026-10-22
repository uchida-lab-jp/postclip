'use strict';
const { ipcRenderer } = require('electron');
let expanding = false;

// Grokカードの展開操作だけを受け取り、投稿本文や引用の「さらに表示」はXに任せる。
function grokControl(event) {
  if (!event.isTrusted) return null;
  const node = event.composedPath().find(item => item instanceof Element && /^(?:さらに表示|もっと見る|Show more|Read more)$/i.test(item.textContent.trim()));
  if (!node) return null;
  let card = node.parentElement;
  while (card && !card.matches('article,main,body')) {
    if (card.hasAttribute('data-postclip-full-resource')) return null;
    if (card.querySelector('article,time')) return null;
    if (/(?:Grokによる回答|(?:Response|Answer) by Grok)/i.test(card.innerText || '')) return card;
    card = card.parentElement;
  }
  return null;
}

// クリック元の同じ投稿だけをメイン処理で再検証し、取得中・失敗の理由をカードに表示する。
async function expandClickedGrok(event) {
  const card = grokControl(event);
  if (!card) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (expanding) return;
  expanding = true;
  card.querySelectorAll('[data-postclip-grok-status]').forEach(node => node.remove());
  const status = document.createElement('div');
  status.setAttribute('data-postclip-grok-status', 'true');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:14px;line-height:1.5;padding:8px 0;white-space:normal';
  status.textContent = 'Grokの全文を取得しています…';
  card.append(status);
  const key = `grok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  card.setAttribute('data-postclip-expand-request', key);
  try {
    const result = await ipcRenderer.invoke('expand-open-grok', key);
    if (result.pending) status.textContent = '画像の作成に合わせてGrokの全文を取得しています…';
    else if (result.ok) status.remove();
    else status.textContent = result.error;
  } catch {
    status.textContent = 'Grokの全文を取得できませんでした。もう一度「さらに表示」を押してください。';
  } finally { expanding = false; }
}
document.addEventListener('click', expandClickedGrok, true);
