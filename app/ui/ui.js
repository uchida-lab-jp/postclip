'use strict';
// IDから画面要素を参照する。
const $ = id => document.getElementById(id);
const api = window.postclip;
let busy = false, result = null;

// 入力中の設定をまとめる。
function options() { return { width: Number($('width').value), scale: Number($('scale').value), conversation: $('conversation').value, mode: $('mode').value, theme: $('theme').value, padding: Number($('padding').value), includeNotes: $('includeNotes').checked }; }

// 表示幅と解像度の違いを保存ピクセル数で示す。
function refreshControls() {
  const o = options();
  $('output-width').textContent = `横 ${((o.width + o.padding * 2) * o.scale).toLocaleString()}px`;
  document.querySelectorAll('[data-width]').forEach(button => button.classList.toggle('selected', Number(button.dataset.width) === o.width));
  $('theme').disabled = o.mode !== 'embed' || o.includeNotes;
  $('mode').disabled = o.includeNotes;
  $('mode-note').textContent = o.includeNotes || o.mode !== 'embed' ? '投稿全文をXの画面から取得します。色はX側の設定を使います。' : '公式埋め込みを使います。省略があれば投稿画面へ切り替えて全文を取得します。';
  $('setting-summary').textContent = `表示幅 ${o.width}px・${o.scale}倍・横 ${((o.width + o.padding * 2) * o.scale).toLocaleString()}px`;
  $('notes-note').textContent = o.includeNotes ? '表示されたノートも保存。ノートがない投稿もそのまま作成できます。' : 'ノートを含める場合はオンに。Xの投稿画面から撮影します。';
  $('conversation-note').textContent = o.conversation === 'thread' ? '公開投稿の親を最大20件まで。先頭からこの投稿まで順に保存します。' : o.conversation === 'parent' ? '表示できる直前の返信先を含めます。' : '指定した投稿だけを保存します。';
  if (result && !busy) $('preview-heading').textContent = '設定変更後は「画像を作成」で更新';
}

// 通知を読み上げ可能な領域へ表示する。
function status(message, kind = '', recovery = false) {
  $('recovery-actions').hidden = !recovery;
  $('status').hidden = !message;
  $('status').textContent = message;
  $('status').className = `status ${kind}`;
}

// 作成中の二重操作を防ぎ、キャンセルだけを操作可能にする。
function setBusy(value) {
  busy = value;
  $('recovery-open-x').disabled = value;
  document.body.classList.toggle('busy', value);
  $('capture-button').disabled = value;
  $('cancel').hidden = !value;
  $('busy-overlay').hidden = !value;
  $('progress-track').hidden = !value;
  $('download').disabled = value || !result;
  $('copy').disabled = value || !result;
  for (const element of $('capture-form').querySelectorAll('input,select,textarea,button')) if (element.id !== 'cancel') element.disabled = value;
  if (!value) { $('theme').disabled = $('mode').value !== 'embed' || $('includeNotes').checked; $('mode').disabled = $('includeNotes').checked; }
}

// 撮影結果を受け取り、保存前に全体を確認できるようにする。
async function capture(event, interactive = false) {
  event?.preventDefault();
  if (busy || !$('capture-form').reportValidity()) return;
  result = null;
  $('result').hidden = true; $('empty-state').hidden = false;
  $('result-image').removeAttribute('src');
  $('source').hidden = true; $('zoom-control').hidden = true;
  $('image-meta').textContent = '画像を作成しています…';
  $('progress-bar').style.width = '5%';
  $('preview-heading').textContent = '画像を作成しています';
  $('busy-message').textContent = '投稿を読み込んでいます…';
  status(''); setBusy(true);
  try {
    const response = await api.capture({ url: $('url').value, options: options(), interactive });
    if (!response.ok) { status(response.error, response.cancelled ? '' : 'error', response.recovery === true); $('preview-heading').textContent = response.cancelled ? 'キャンセルしました' : '画像を作成できませんでした'; $('image-meta').textContent = response.cancelled ? '「画像を作成」で再開できます' : '上の案内を確認してください'; return; }
    result = response;
    $('result-image').src = response.dataUrl;
    $('result-image').style.width = `${response.options.width + response.options.padding * 2}px`;
    $('result-caption').textContent = response.filename;
    $('result').hidden = false; $('empty-state').hidden = true;
    $('source').hidden = false; $('zoom-control').hidden = false;
    $('actual-size').checked = false; $('result').classList.remove('actual');
    $('preview-heading').textContent = response.notesIncluded ? 'コミュニティノートを含めて作成しました' : response.postCount ? `${response.postCount}件の投稿をまとめました` : '完成しました';
    $('image-meta').textContent = `${response.width.toLocaleString()} × ${response.height.toLocaleString()} px · PNG · ${(response.bytes / 1024 / 1024).toFixed(2)} MB`;
    $('stage').scrollTop = 0;
    const completeMessage = response.notesStatus === 'not-shown' ? '撮影時の投稿画面にノートの表示はありませんでした。下端まで確認して、PNGを保存してください。' : '下端まで確認して、PNGを保存してください。';
    const sourceMessage = response.usedOpenPage ? '開いているX画面から作成しました。' : '';
    status(sourceMessage + (response.warnings.length ? response.warnings.join('\n') : completeMessage), response.warnings.length ? 'warning' : '');
  } catch { status('処理に失敗しました。アプリを再起動して再試行してください。', 'error'); }
  finally { setBusy(false); }
}

// 保存・コピーなどの失敗も同じ通知領域へ返す。
async function action(fn, success) {
  try { const response = await fn(); if (response?.ok) status(typeof success === 'function' ? success(response) : success); else if (!response?.cancelled) status(response?.error || '操作に失敗しました。', 'error'); }
  catch { status('操作に失敗しました。もう一度お試しください。', 'error'); }
}

// 制限の確認と手動表示後の撮影を、詳細設定を探さず続けられるようにする。
async function openXForCapture() {
  if (busy) return;
  try {
    const response = await api.openX($('url').value);
    status(response.ok ? 'X画面を開きました。戻って「画像を作成」を押すと、表示中の同じ投稿を使います。' : response.error, response.ok ? '' : 'error');
  } catch { status('X画面を開けませんでした。もう一度お試しください。', 'error', true); }
}

// メイン画面を初期化し、キーボード操作も設定する。
async function init() {
  if (!api) { status('PostClipアプリから起動してください。HTMLファイル単体では動作しません。', 'error'); $('capture-button').disabled = true; return; }
  const settings = await api.settings();
  $('version').textContent = settings.version; $('help-version').textContent = settings.version;
  for (const [key, value] of Object.entries(settings.options)) if ($(key)) {
    if ($(key).type === 'checkbox') $(key).checked = value === true;
    else $(key).value = String(value);
  }
  refreshControls();
  $('capture-form').addEventListener('submit', capture);
  $('capture-form').addEventListener('input', refreshControls);
  $('width-presets').addEventListener('click', event => { if (event.target.dataset.width) { $('width').value = event.target.dataset.width; refreshControls(); } });
  $('paste').addEventListener('click', async () => { try { $('url').value = await api.paste(); $('url').focus(); } catch { status('貼り付けできませんでした。Ctrl + Vをお使いください。', 'error'); } });
  $('download').addEventListener('click', () => action(() => api.save(), r => `保存しました：${r.filename}`));
  $('copy').addEventListener('click', () => action(() => api.copy(), '画像をコピーしました。Ctrl + Vで貼り付けられます。'));
  $('cancel').addEventListener('click', () => api.cancel());
  $('open-x').addEventListener('click', openXForCapture);
  $('recovery-open-x').addEventListener('click', event => capture(event, true));
  $('source').addEventListener('click', () => api.openSource());
  $('actual-size').addEventListener('change', () => { $('result').classList.toggle('actual', $('actual-size').checked); $('result-image').style.width = $('actual-size').checked ? `${result.width}px` : `${result.options.width + result.options.padding * 2}px`; });
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('help-close').addEventListener('click', () => $('help-dialog').close());
  $('clear-login').addEventListener('click', async () => { $('help-dialog').close(); await action(() => api.clearLogin(), 'アプリ内のXログイン情報を削除しました。'); });
  api.onProgress(value => { $('busy-message').textContent = value.message; $('progress-bar').style.width = `${value.percent}%`; });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') capture(event); });
}
init().catch(() => status('初期化できませんでした。アプリを再起動してください。', 'error'));
