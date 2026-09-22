'use strict';

const { BrowserWindow } = require('electron');
const { checkDimensions, isXNavigation } = require('./core.cjs');
const scripts = require('./page-scripts.cjs');
const { restrictNetwork } = require('./network.cjs');
const { installLocalPage } = require('./local-page.cjs');

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

// Xの投稿をブラウザーの描画倍率で直接PNG化する。
async function renderPost(post, options, job, report) {
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
  try {
    // 初期フレームの生成前にDPIを変更すると、一部環境でChromiumが落ちる。
    await deadline(win.loadURL('about:blank'), 15000, '撮影画面を開始できませんでした。再試行してください。');
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: options.width, height: 1000, deviceScaleFactor: options.scale, mobile: false });
    await wc.debugger.sendCommand('Emulation.setScrollbarsHidden', { hidden: true });
    report('Xから投稿を読み込んでいます…', 18);
    if (options.mode === 'embed') {
      installLocalPage(wc.session);
      const query = new URLSearchParams({ id: post.id, width: String(options.width), theme: options.theme, conversation: String(options.conversation), padding: String(options.padding) });
      await deadline(win.loadURL(`postclip://capture/embed.html?${query}`), 20000, '表示画面を開けませんでした。');
      await waitUntil(async () => {
        const state = await wc.executeJavaScript('window.postclipState');
        if (state?.error) throw new Error(state.error);
        return state?.ready;
      }, job);
      // Chromiumの子フレームはDPR=1のままの場合があるため、DOMとCSSを
      // 最上位フレームに写し、文字を指定倍率で再描画する（画像拡大はしない）。
      let snapshot;
      for (const frame of wc.mainFrame.framesInSubtree) {
        if (!/^https:\/\/platform\.(twitter|x)\.com\//.test(frame.url)) continue;
        snapshot = await frame.executeJavaScript(expression(scripts.snapshotEmbeddedFrame));
        if (snapshot) break;
      }
      if (!snapshot) throw new Error('投稿の描画領域を取得できませんでした。投稿画面モードを試してください。');
      await deadline(win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(snapshot)}`), 20000, '投稿の再描画に時間がかかっています。再試行してください。');
      await wc.executeJavaScript(expression(scripts.wrapEmbedSnapshot, options));
    } else {
      await deadline(win.loadURL(post.url), 45000, 'Xへの接続に時間がかかっています。少し待って再試行してください。');
      await waitUntil(async () => {
        const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
        if (state.unavailable) throw new Error('この投稿は表示できません。削除・非公開・閲覧制限の可能性があります。');
        if (state.login) throw new Error('Xへのログインが必要です。「Xを開く」でログインしてから、もう一度作成してください。');
        return state.found;
      }, job, 45000, '投稿画面を読み込めませんでした。「Xを開く」で表示とログインを確認するか、かんたんモードをお使いください。');
      const expanded = await wc.executeJavaScript(expression(scripts.expandPost, post.id));
      if (expanded) { await delay(1200, job); await wc.executeJavaScript(expression(scripts.inspectPost, post.id)); }
      await delay(700, job);
      const result = await wc.executeJavaScript(expression(scripts.isolatePost, post.id, options));
      warnings.push(...result.warnings);
      parentIncluded = result.parentIncluded;
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
    return { png, width, height, warnings: [...new Set(warnings)], parentIncluded };
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
