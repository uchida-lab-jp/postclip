'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, ClipboardItem, shell, session, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { DEFAULTS, SETTINGS_VERSION, parsePostUrl, validateOptions, restoreOptions, makeFilename, isXNavigation } = require('./core.cjs');
const { capturePost, deadline } = require('./capture.cjs');
const { restrictNetwork } = require('./network.cjs');

app.setName('PostClip');
let mainWindow, loginWindow, currentJob, latest;
const uiPath = path.join(__dirname, 'ui', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;

// 操作元がローカルのメイン画面であることを毎回確認する。
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error('この操作は許可されていません。');
  }
}

// ファイルを一時ファイル経由で置き換え、書込み中断による破損を避ける。
async function atomicWrite(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

// 設定だけを保存し、投稿URLや画像の履歴はディスクに保存しない。
async function saveSettings(options) {
  await atomicWrite(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify({ ...options, settingsVersion: SETTINGS_VERSION }, null, 2));
}

// 旧設定のノート既定値を一度だけ更新し、破損した設定は安全な初期値に戻す。
async function readSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    const options = restoreOptions(stored);
    if (stored.settingsVersion !== SETTINGS_VERSION) await saveSettings(options).catch(() => {});
    return options;
  }
  catch { return { ...DEFAULTS }; }
}

// 処理状況をメイン画面だけに通知する。
function progress(message, percent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('capture-progress', { message, percent });
}

// 現在の撮影処理をキャンセルし、専用ブラウザーを閉じる。
function cancelCapture() {
  if (!currentJob) return;
  currentJob.cancelled = true;
  currentJob.abort?.();
  if (currentJob.window && !currentJob.window.isDestroyed()) currentJob.window.destroy();
}

// X専用ウィンドウで利用者が通常のログインを行えるようにする。
async function openX(value) {
  let url = 'https://x.com/';
  if (value?.trim()) { try { url = parsePostUrl(value).url; } catch {} }
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); await loginWindow.loadURL(url); return; }
  loginWindow = new BrowserWindow({ width: 1000, height: 840, title: 'PostClip — X', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { partition: 'persist:postclip-x', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, target) => { if (!isXNavigation(target)) event.preventDefault(); });
  loginWindow.webContents.on('will-redirect', (event, target) => { if (!isXNavigation(target)) event.preventDefault(); });
  loginWindow.on('closed', () => { loginWindow = null; });
  await deadline(loginWindow.loadURL(url), 45000, 'Xへの接続に時間がかかっています。ウィンドウで表示状態をご確認ください。');
}

// IPCは操作ごとの専用入口だけを公開する。
function installHandlers() {
  ipcMain.handle('settings', async event => { trusted(event); return { options: await readSettings(), version: app.getVersion(), platform: process.platform }; });
  ipcMain.handle('paste-url', async event => { trusted(event); return (await clipboard.readText()).slice(0, 2048); });
  ipcMain.handle('capture', async (event, input) => {
    trusted(event);
    if (currentJob) return { ok: false, error: '作成中です。完了するまでお待ちください。' };
    let job;
    try {
      const post = parsePostUrl(input?.url);
      const options = validateOptions(input?.options);
      job = { cancelled: false, window: null };
      currentJob = job;
      latest = null;
      const result = await deadline(capturePost(post, options, job, progress), options.conversation === 'thread' ? 360000 : 110000, '処理が制限時間を超えました。ネット接続を確認して再試行してください。');
      if (job.cancelled) throw new Error('キャンセルしました。');
      latest = { ...result, post, options, filename: makeFilename(post, options) };
      await saveSettings(options).catch(() => { result.warnings.push('設定を保存できませんでした。画像は保存できます。'); });
      return { ok: true, dataUrl: `data:image/png;base64,${result.png.toString('base64')}`, width: result.width, height: result.height,
        bytes: result.png.length, warnings: result.warnings, postCount: result.postCount, notesIncluded: result.notesIncluded, notesStatus: result.notesStatus, filename: latest.filename, source: post.url, options };
    } catch (error) {
      return { ok: false, cancelled: Boolean(job?.cancelled), error: job?.cancelled ? 'キャンセルしました。' : friendlyError(error) };
    } finally {
      if (job?.window && !job.window.isDestroyed()) job.window.destroy();
      if (currentJob === job) currentJob = null;
    }
  });
  ipcMain.handle('cancel', event => { trusted(event); cancelCapture(); return true; });
  ipcMain.handle('save-png', async event => {
    trusted(event);
    const snapshot = latest;
    if (!snapshot) return { ok: false, error: '先に画像を作成してください。' };
    try {
      const result = await dialog.showSaveDialog(mainWindow, { title: 'PNG画像を保存', defaultPath: path.join(app.getPath('downloads'), snapshot.filename), filters: [{ name: 'PNG画像', extensions: ['png'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      const destination = /\.png$/i.test(result.filePath) ? result.filePath : `${result.filePath}.png`;
      await atomicWrite(destination, snapshot.png);
      return { ok: true, filename: path.basename(destination) };
    } catch { return { ok: false, error: '保存できませんでした。保存先の空き容量と書込み権限をご確認ください。' }; }
  });
  ipcMain.handle('copy-image', async event => {
    trusted(event);
    if (!latest) return { ok: false, error: '先に画像を作成してください。' };
    try { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([latest.png], { type: 'image/png' }) })]); return { ok: true }; }
    catch { return { ok: false, error: 'コピーできませんでした。PNG保存をご利用ください。' }; }
  });
  ipcMain.handle('open-x', async (event, value) => { trusted(event); try { await openX(typeof value === 'string' ? value : ''); return { ok: true }; } catch (e) { return { ok: false, error: friendlyError(e) }; } });
  ipcMain.handle('open-source', async event => { trusted(event); if (latest) await shell.openExternal(latest.post.url); return true; });
  ipcMain.handle('clear-x-data', async event => {
    trusted(event);
    if (currentJob) return { ok: false, error: '画像の作成が終わってから操作してください。' };
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['キャンセル', 'ログイン情報を削除'], defaultId: 0, cancelId: 0,
      message: 'PostClip内のXログイン情報を削除しますか？', detail: '通常のブラウザーのログイン状態には影響しません。' });
    if (answer.response !== 1) return { ok: false, cancelled: true };
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy();
    try {
      const s = session.fromPartition('persist:postclip-x');
      await s.clearStorageData(); await s.clearCache();
      return { ok: true };
    } catch { return { ok: false, error: '削除に失敗しました。アプリを再起動して再試行してください。' }; }
  });
}

// ブラウザーの内部エラーを利用者が対処できる説明へ置き換える。
function friendlyError(error) {
  const message = String(error?.message || '画像を作成できませんでした。');
  if (/ERR_|Failed to load|net::|GUEST_VIEW_MANAGER|Execution context was destroyed|Object has been destroyed/.test(message)) return 'Xの表示を読み込めませんでした。接続を確認し、必要なら「Xを開く」でログインしてください。';
  return message.slice(0, 400);
}

// ローカルUIを安全なウィンドウで開く。
async function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1230, height: 900, minWidth: 920, minHeight: 680, backgroundColor: '#f6f7f3', title: 'PostClip',
    autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('closed', () => { cancelCapture(); if (loginWindow && !loginWindow.isDestroyed()) loginWindow.destroy(); mainWindow = null; latest = null; });
  await mainWindow.loadFile(uiPath);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    for (const name of ['persist:postclip-x', 'postclip-embed']) {
      const s = session.fromPartition(name);
      restrictNetwork(s);
      s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.on('will-download', event => event.preventDefault());
    }
    installHandlers();
    await createMainWindow();
  }).catch(error => { dialog.showErrorBox('PostClipを起動できませんでした', friendlyError(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', cancelCapture);
}
