'use strict';
// IDから画面要素を参照する。
const $ = id => document.getElementById(id);
const api = window.postclip;
let busy = false, result = null;

// 入力中の設定をまとめる。
function options() { return { width: Number($('width').value), scale: Number($('scale').value), conversation: $('conversation').checked, mode: $('mode').value, theme: $('theme').value, padding: Number($('padding').value) }; }

// 表示幅と解像度の違いを保存ピクセル数で示す。
function refreshControls() {
  const o = options();
  $('output-width').textContent = `横 ${((o.width + o.padding * 2) * o.scale).toLocaleString()}px`;
  document.querySelectorAll('[data-width]').forEach(button => button.classList.toggle('selected', Number(button.dataset.width) === o.width));
  $('theme').disabled = o.mode === 'page';
  $('mode-note').textContent = o.mode === 'page' ? '必要に応じて下の「Xを開く」でログイン。色はX側の設定を使います。' : '公開投稿向け。ログイン不要で利用できます。';
  if (result && !busy) $('preview-heading').textContent = '設定変更後は「画像を作成」で更新';
}

// 通知を読み上げ可能な領域へ表示する。
function status(message, kind = '') {
  $('status').hidden = !message;
  $('status').textContent = message;
  $('status').className = `status ${kind}`;
}

// 作成中の二重操作を防ぎ、キャンセルだけを操作可能にする。
function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  $('capture-button').disabled = value;
  $('cancel').hidden = !value;
  $('busy-overlay').hidden = !value;
  $('progress-track').hidden = !value;
  $('download').disabled = value || !result;
  $('copy').disabled = value || !result;
  for (const element of $('capture-form').querySelectorAll('input,select,textarea,button')) if (element.id !== 'cancel') element.disabled = value;
  if (!value) $('theme').disabled = $('mode').value === 'page';
}

// 撮影結果を受け取り、保存前に全体を確認できるようにする。
async function capture(event) {
  event?.preventDefault();
  if (busy || !$('capture-form').reportValidity()) return;
  result = null;
  $('result').hidden = true; $('empty-state').hidden = false;
  $('result-image').removeAttribute('src');
  $('source').hidden = true; $('zoom-control').hidden = true;
  $('image-meta').textContent = '画像を作成しています…';
  $('progress-bar').style.width = '5%';
  $('busy-message').textContent = '投稿を読み込んでいます…';
  status(''); setBusy(true);
  try {
    const response = await api.capture({ url: $('url').value, options: options() });
    if (!response.ok) { status(response.error, response.cancelled ? '' : 'error'); $('image-meta').textContent = response.cancelled ? 'キャンセルしました' : 'URLと表示方法を確認してください'; return; }
    result = response;
    $('result-image').src = response.dataUrl;
    $('result-image').style.width = `${response.options.width + response.options.padding * 2}px`;
    $('result-caption').textContent = response.filename;
    $('result').hidden = false; $('empty-state').hidden = true;
    $('source').hidden = false; $('zoom-control').hidden = false;
    $('actual-size').checked = false; $('result').classList.remove('actual');
    $('preview-heading').textContent = '完成しました';
    $('image-meta').textContent = `${response.width.toLocaleString()} × ${response.height.toLocaleString()} px · PNG · ${(response.bytes / 1024 / 1024).toFixed(2)} MB`;
    $('stage').scrollTop = 0;
    status(response.warnings.length ? response.warnings.join('\n') : '下端まで確認して、PNGを保存してください。', response.warnings.length ? 'warning' : '');
  } catch { status('処理に失敗しました。アプリを再起動して再試行してください。', 'error'); }
  finally { setBusy(false); }
}

// 保存・コピーなどの失敗も同じ通知領域へ返す。
async function action(fn, success) {
  try { const response = await fn(); if (response?.ok) status(typeof success === 'function' ? success(response) : success); else if (!response?.cancelled) status(response?.error || '操作に失敗しました。', 'error'); }
  catch { status('操作に失敗しました。もう一度お試しください。', 'error'); }
}

// メイン画面を初期化し、キーボード操作も設定する。
async function init() {
  if (!api) { status('PostClipアプリから起動してください。HTMLファイル単体では動作しません。', 'error'); $('capture-button').disabled = true; return; }
  const settings = await api.settings();
  $('version').textContent = settings.version; $('help-version').textContent = settings.version;
  for (const [key, value] of Object.entries(settings.options)) if ($(key)) { if (key === 'conversation') $(key).checked = value; else $(key).value = String(value); }
  refreshControls();
  $('capture-form').addEventListener('submit', capture);
  $('capture-form').addEventListener('input', refreshControls);
  $('width-presets').addEventListener('click', event => { if (event.target.dataset.width) { $('width').value = event.target.dataset.width; refreshControls(); } });
  $('paste').addEventListener('click', async () => { try { $('url').value = await api.paste(); $('url').focus(); } catch { status('貼り付けできませんでした。Ctrl + Vをお使いください。', 'error'); } });
  $('download').addEventListener('click', () => action(() => api.save(), r => `保存しました：${r.filename}`));
  $('copy').addEventListener('click', () => action(() => api.copy(), '画像をコピーしました。Ctrl + Vで貼り付けられます。'));
  $('cancel').addEventListener('click', () => api.cancel());
  $('open-x').addEventListener('click', () => action(() => api.openX($('url').value), 'Xを開きました。ログインが終わったらこの画面で作成してください。'));
  $('source').addEventListener('click', () => api.openSource());
  $('actual-size').addEventListener('change', () => { $('result').classList.toggle('actual', $('actual-size').checked); $('result-image').style.width = $('actual-size').checked ? `${result.width}px` : `${result.options.width + result.options.padding * 2}px`; });
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('help-close').addEventListener('click', () => $('help-dialog').close());
  $('clear-login').addEventListener('click', async () => { $('help-dialog').close(); await action(() => api.clearLogin(), 'アプリ内のXログイン情報を削除しました。'); });
  api.onProgress(value => { $('busy-message').textContent = value.message; $('progress-bar').style.width = `${value.percent}%`; });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') capture(event); });
}
init().catch(() => status('初期化できませんでした。アプリを再起動してください。', 'error'));
