'use strict';

const DEFAULTS = Object.freeze({ width: 400, scale: 3, theme: 'light', conversation: 'parent', mode: 'embed', padding: 0, includeNotes: true });
const SETTINGS_VERSION = 2;
const MAX_PIXELS = 30_000_000;

// 投稿URLを検証し、追跡用パラメーターを含まない正規URLに揃える。
function parsePostUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Xの投稿URLを入力してください。');
  const input = value.trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); }
  catch { throw new Error('投稿URLの形式を確認してください。'); }
  const hosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
  if (!['https:', 'http:'].includes(u.protocol) || !hosts.has(u.hostname.toLowerCase()) || u.username || u.password || u.port) {
    throw new Error('x.com または twitter.com の投稿URLを指定してください。');
  }
  const match = u.pathname.match(/^\/(?:([A-Za-z0-9_]{1,15})\/status|i\/web\/status|i\/status)\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
  if (!match || /^0+$/.test(match[2])) throw new Error('プロフィールではなく、/status/ を含む投稿URLを指定してください。');
  const user = match[1] || 'i';
  return { id: match[2], user, url: `https://x.com/${user}/status/${match[2]}` };
}

// 画面から渡される設定を許可した範囲と値だけに制限する。
function validateOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定を読み取れませんでした。');
  const width = Number(value.width ?? DEFAULTS.width);
  const scale = Number(value.scale ?? DEFAULTS.scale);
  const padding = Number(value.padding ?? DEFAULTS.padding);
  if (!Number.isInteger(width) || width < 320 || width > 550) throw new Error('表示幅は320〜550pxの整数で指定してください。');
  if (![1, 2, 3].includes(scale)) throw new Error('解像度は1倍・2倍・3倍から選んでください。');
  if (![0, 16, 24].includes(padding)) throw new Error('余白の設定が正しくありません。');
  const mode = value.mode ?? DEFAULTS.mode;
  const theme = value.theme ?? DEFAULTS.theme;
  if (!['embed', 'page'].includes(mode) || !['light', 'dark'].includes(theme)) throw new Error('表示方法の設定が正しくありません。');
  // 1.0.0のチェックボックス設定も、意味を変えずに引き継ぐ。
  const legacy = value.conversation ?? DEFAULTS.conversation;
  const conversation = legacy === true ? 'parent' : legacy === false ? 'none' : legacy;
  if (!['none', 'parent', 'thread'].includes(conversation)) throw new Error('含める投稿の設定が正しくありません。');
  const includeNotes = value.includeNotes ?? DEFAULTS.includeNotes;
  if (typeof includeNotes !== 'boolean') throw new Error('コミュニティノートの設定が正しくありません。');
  return { width, scale, padding, mode, theme, conversation, includeNotes };
}

// 旧版の設定を初回だけノートありへ移行し、その後の利用者の選択を保持する。
function restoreOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定を読み取れませんでした。');
  return validateOptions({ ...value, includeNotes: value.settingsVersion === SETTINGS_VERSION ? value.includeNotes : true });
}

// 巨大な画像によるメモリー不足を避け、途中切れのまま成功扱いにしない。
function checkDimensions(width, height, scale) {
  if (![width, height, scale].every(Number.isFinite) || width < 1 || height < 40) throw new Error('投稿の表示サイズを取得できませんでした。');
  if (height * scale > 30000 || width * height * scale * scale > MAX_PIXELS) {
    throw new Error('投稿が長いため画像サイズの上限を超えます。解像度を1倍または2倍に下げてください。');
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

// 保存名に投稿IDと取得時刻を含め、異なる画像の上書きを避ける。
function makeFilename(post, options, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
  return `postclip-${post.user}-${post.id}-${options.width}px-${options.scale}x-${stamp}.png`;
}

// Xの閲覧ウィンドウで許可するページ遷移だけを判定する。
function isXNavigation(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(u.hostname);
  } catch { return false; }
}

module.exports = { DEFAULTS, SETTINGS_VERSION, MAX_PIXELS, parsePostUrl, validateOptions, restoreOptions, checkDimensions, makeFilename, isXNavigation };
