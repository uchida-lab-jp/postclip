'use strict';
window.postclipState = { ready: false };
const params = new URLSearchParams(location.search);
const id = params.get('id');
const width = Number(params.get('width'));
const padding = Number(params.get('padding'));
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const root = document.getElementById('postclip-capture');
const mount = document.getElementById('mount');
root.style.width = `${width + padding * 2}px`;
root.style.padding = `${padding}px`;
root.style.background = theme === 'dark' ? '#15202b' : '#fff';
mount.style.width = `${width}px`;
const script = document.createElement('script');
script.src = 'https://platform.twitter.com/widgets.js';
script.async = true;
// 公式ウィジェットだけで投稿を描画し、失敗時は空画像を返さない。
script.onload = async () => {
  try {
    const element = await window.twttr.widgets.createTweet(id, mount, {
      width, theme, conversation: params.get('conversation') === 'true' ? 'all' : 'none', lang: 'ja', dnt: true, align: 'left'
    });
    if (!element) throw new Error('この投稿は埋め込み表示できません。投稿画面モードを試してください。');
    window.postclipState = { ready: true };
  } catch (error) { window.postclipState = { error: error.message || '投稿を表示できませんでした。' }; }
};
script.onerror = () => { window.postclipState = { error: 'Xに接続できませんでした。ネット接続を確認して再試行してください。' }; };
document.head.append(script);
