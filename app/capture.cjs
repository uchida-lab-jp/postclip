'use strict';

const { BrowserWindow } = require('electron');
const { checkDimensions, isXNavigation } = require('./core.cjs');
const scripts = require('./page-scripts.cjs');
const { restrictNetwork } = require('./network.cjs');
const { installLocalPage } = require('./local-page.cjs');
const { collectThread } = require('./thread.cjs');

// ページ内で実行する固定関数に、検証済みの値をJSONとして渡す。
function expression(fn, ...args) { return `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`; }

// 待機中もキャンセルを反映する。
async function delay(ms, job) {
  await new Promise(resolve => setTimeout(resolve, ms));
  if (job.cancelled) throw new Error('キャンセルしました。');
}

// 終了しない通信や評価を制限時間で打ち切る。
async function deadline(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

// ページ内の読込状態を一定間隔で確認する。
async function waitUntil(check, job, timeout = 45000, message = 'Xから投稿を読み込めませんでした。通信状態やURLを確認し、投稿画面モードも試してください。') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (job.cancelled) throw new Error('キャンセルしました。');
    const result = await check();
    if (result) return result;
    await delay(250, job);
  }
  throw new Error(message);
}

// 外部ページからファイルアクセスや別サイトへの遷移を許可しない。
function secureRemote(win, mode) {
  restrictNetwork(win.webContents.session);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (mode === 'embed' || !isXNavigation(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (mode === 'page' && !isXNavigation(url)) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
}

// 公式埋め込みを表示し、必要なときだけ返信先を調べて静的DOMを取り出す。
async function loadEmbedded(wc, post, options, job, conversation, inspectParent) {
  installLocalPage(wc.session);
  const query = new URLSearchParams({ id: post.id, width: String(options.width), theme: options.theme, conversation: String(conversation), padding: '0' });
  await deadline(wc.loadURL(`postclip://capture/embed.html?${query}`), 60000, 'Xの埋め込み表示を読み込めませんでした。接続を確認して再試行してください。');
  await waitUntil(async () => {
    const state = await wc.executeJavaScript('window.postclipState');
    if (state?.error) throw new Error(state.error);
    return state?.ready;
  }, job);
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (!/^https:\/\/platform\.(twitter|x)\.com\//.test(frame.url)) continue;
    const snapshot = await frame.executeJavaScript(expression(scripts.snapshotEmbeddedFrame));
    if (!snapshot) continue;
    const relation = inspectParent ? await frame.executeJavaScript(expression(scripts.inspectEmbeddedParent, post.id)) : {};
    return { snapshot, ...relation };
  }
  throw new Error('投稿の描画領域を取得できませんでした。投稿画面モードを試してください。');
}

// 子フレームの低いDPIを引き継がず、同じDOMとCSSを最上位で再描画する。
async function loadSnapshot(wc, snapshot) {
  if (!snapshot) throw new Error('投稿の描画内容を取得できませんでした。');
  await deadline(wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(snapshot)}`), 20000, '投稿の再描画に時間がかかっています。再試行してください。');
}

// 投稿画面を表示し、本文を展開して必要な記事だけを撮影領域へ移す。
async function loadPage(wc, post, options, job) {
  await deadline(wc.loadURL(post.url), 45000, 'Xへの接続に時間がかかっています。少し待って再試行してください。');
  await waitUntil(async () => {
    const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
    if (state.unavailable) throw new Error('この投稿は表示できません。削除・非公開・閲覧制限の可能性があります。');
    if (state.login) throw new Error('Xへのログインが必要です。「Xを開く」でログインしてから、もう一度作成してください。');
    return state.found;
  }, job, 45000, '投稿画面を読み込めませんでした。「Xを開く」で表示とログインを確認するか、かんたんモードをお使いください。');
  const expanded = await wc.executeJavaScript(expression(scripts.expandPost, post.id));
  if (expanded) { await delay(1200, job); await wc.executeJavaScript(expression(scripts.inspectPost, post.id)); }
  await wc.executeJavaScript(expression(scripts.revealPost, post.id, options.conversation));
  let lastSignature = null, stable = 0, seenNote = false;
  const notesStarted = Date.now();
  let noteState;
  await waitUntil(async () => {
    await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
    const note = await wc.executeJavaScript(expression(scripts.inspectCommunityNote, post.id));
    noteState = note;
    seenNote ||= note.found || note.hint;
    const signature = note.signature || '';
    stable = signature === lastSignature ? stable + 1 : 0;
    lastSignature = signature;
    if (stable < 4) return false;
    if (!options.includeNotes) return true;
    if (note.found && !note.pending) return true;
    return !seenNote && !note.pending && Date.now() - notesStarted >= 5000;
  }, job, options.includeNotes ? 15000 : 3500, 'コミュニティノートの読み込みを確認できませんでした。「Xを開く」で表示を確認してから、もう一度作成してください。');
  await wc.executeJavaScript(expression(scripts.settleAssets));
  noteState = await wc.executeJavaScript(expression(scripts.inspectCommunityNote, post.id));
  if (options.includeNotes && !noteState.found && (seenNote || noteState.hint || noteState.pending)) {
    throw new Error('コミュニティノートの表示が確定していません。少し待って、もう一度作成してください。');
  }
  const result = await wc.executeJavaScript(expression(scripts.isolatePost, post.id, { ...options, noteExpected: options.includeNotes && noteState.found }));
  return { ...result, notesStatus: result.notesIncluded ? 'included' : options.includeNotes ? 'not-shown' : 'unchecked' };
}

// Xの投稿をブラウザーの描画倍率で直接PNG化する。
async function renderPost(post, options, job, report) {
  // ノートを求めたときは埋め込みの省略に依存せず、Xの投稿画面を使う。
  if (options.includeNotes) options = { ...options, mode: 'page' };
  const outerWidth = options.width + options.padding * 2;
  const win = new BrowserWindow({ show: false, width: outerWidth, height: 1000, useContentSize: true, backgroundColor: options.theme === 'dark' ? '#15202b' : '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
      partition: options.mode === 'page' ? 'persist:postclip-x' : 'postclip-embed', webSecurity: true } });
  job.window = win;
  win.once('closed', () => { if (job.cancelled) job.abort?.(); });
  secureRemote(win, options.mode);
  const wc = win.webContents;
  const warnings = [];
  let parentIncluded = null;
  let postCount = null;
  let notesIncluded = false;
  let notesStatus = 'unchecked';
  try {
    // 初期フレームの生成前にDPIを変更すると、一部環境でChromiumが落ちる。
    await deadline(win.loadURL('about:blank'), 15000, '撮影画面を開始できませんでした。再試行してください。');
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: options.width, height: 1000, deviceScaleFactor: options.scale, mobile: false });
    await wc.debugger.sendCommand('Emulation.setScrollbarsHidden', { hidden: true });
    report(options.includeNotes ? '投稿とコミュニティノートを読み込んでいます…' : 'Xから投稿を読み込んでいます…', 18);
    if (options.conversation === 'thread') {
      let items = await collectThread(post, current => loadEmbedded(wc, current, options, job, false, true), job, report);
      if (options.mode === 'page') {
        const pages = [];
        for (const [index, item] of items.entries()) {
          report(`投稿画面を読み込んでいます… ${index + 1} / ${items.length}件`, 45 + Math.floor(index / items.length * 9));
          const state = await loadPage(wc, item.post, { ...options, conversation: 'none', padding: 0 }, job);
          warnings.push(...state.warnings);
          if (item.post.id === post.id) { notesIncluded = state.notesIncluded; notesStatus = state.notesStatus; }
          pages.push({ ...item, snapshot: await wc.executeJavaScript(expression(scripts.snapshotEmbeddedFrame)) });
        }
        items = pages;
      }
      await loadSnapshot(wc, items[0].snapshot);
      await wc.executeJavaScript(expression(scripts.mountThreadSnapshots, items, options));
      await wc.executeJavaScript(expression(scripts.wrapEmbedSnapshot, options));
      postCount = items.length;
      parentIncluded = items.length > 1;
    } else if (options.mode === 'embed') {
      const item = await loadEmbedded(wc, post, options, job, options.conversation === 'parent', false);
      await loadSnapshot(wc, item.snapshot);
      await wc.executeJavaScript(expression(scripts.wrapEmbedSnapshot, options));
    } else {
      const result = await loadPage(wc, post, options, job);
      warnings.push(...result.warnings);
      parentIncluded = result.parentIncluded;
      notesIncluded = result.notesIncluded;
      notesStatus = result.notesStatus;
    }
    report('文字と画像の表示を整えています…', 55);
    const frames = [wc.mainFrame, ...wc.mainFrame.framesInSubtree.filter(f => f !== wc.mainFrame)];
    for (const frame of frames) {
      try {
        const state = await deadline(frame.executeJavaScript(expression(scripts.settleAssets)), 12500, '画像の読み込みが終わりませんでした。');
        if (state.missing) warnings.push('一部の画像を読み込めませんでした。プレビューを確認し、必要なら再作成してください。');
        if (state.fonts !== 'loaded') warnings.push('一部のフォントが読み込み中です。必要なら再作成してください。');
        if (state.more) warnings.push(options.mode === 'embed' ? 'X側に「もっと見る」などの省略表示があります。全文が必要な場合は投稿画面モードで確認してください。' : '本文・返信先・引用に省略表示が残っている可能性があります。');
      } catch (e) {
        if (job.cancelled) throw e;
        warnings.push('画像の読み込みを最後まで確認できませんでした。プレビューをご確認ください。');
      }
    }
    // 余白を含む出力幅に揃えても本文のCSS幅は維持する。
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: outerWidth, height: 1000, deviceScaleFactor: options.scale, mobile: false });
    let box;
    let stable = 0;
    for (let i = 0; i < 20 && stable < 3; i++) {
      const next = await wc.executeJavaScript(expression(scripts.measureCapture));
      stable = box && Math.abs(box.height - next.height) < 0.5 ? stable + 1 : 0;
      box = next;
      await delay(150, job);
    }
    if (stable < 3) throw new Error('投稿の高さがまだ変化しています。少し待って再作成してください。');
    const dims = checkDimensions(outerWidth, box.height, options.scale);
    report('高解像度のPNGを作成しています…', 88);
    const result = await deadline(wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: dims.width, height: dims.height, scale: 1 }
    }), 20000, '画像の作成に時間がかかっています。解像度を下げて再試行してください。');
    if (job.cancelled) throw new Error('キャンセルしました。');
    const png = Buffer.from(result.data, 'base64');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (width !== dims.width * options.scale || height !== dims.height * options.scale) throw new Error('画像の解像度を検証できませんでした。もう一度作成してください。');
    return { png, width, height, warnings: [...new Set(warnings)], parentIncluded, postCount, notesIncluded, notesStatus };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    job.window = null;
  }
}

// ブラウザーを閉じた際に未完了の読込Promiseが残っても、キャンセルを即座に返す。
async function capturePost(post, options, job, report) {
  if (job.cancelled) throw new Error('キャンセルしました。');
  const cancelled = new Promise((_, reject) => { job.abort = () => reject(new Error('キャンセルしました。')); });
  try { return await Promise.race([renderPost(post, options, job, report), cancelled]); }
  finally { job.abort = null; }
}

module.exports = { capturePost, expression, deadline };
