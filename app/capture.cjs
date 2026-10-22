'use strict';

const { BrowserWindow, net, session } = require('electron');
const { checkDimensions, isXNavigation, parsePostUrl } = require('./core.cjs');
const scripts = require('./page-scripts.cjs');
const contentScripts = require('./content-scripts.cjs');
const { postAccessError } = require('./post-access.cjs');
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

// 中断・期限切れのとき、全文取得用の通信と補助画面も閉じる。
function cleanupContent(job) {
  for (const cleanup of job?.contentCleanups || []) cleanup();
  job?.contentCleanups?.clear();
}

// 投稿に実在した短縮URLだけを解決し、X以外へ転送された先は開かない。
async function resolveGrokUrl(wc, value, job) {
  let url = new URL(value);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (job.cancelled) throw new Error('キャンセルしました。');
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return /^\/i\/grok\/share\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? url.href : null;
    if (url.hostname !== 't.co' || !/^\/[A-Za-z0-9]+$/.test(url.pathname)) return null;
    const location = await new Promise((resolve, reject) => {
      const request = net.request({ url: url.href, session: wc.session, method: 'GET', redirect: 'manual' });
      let settled = false;
      // 転送通知だけを受け取り、転送先への自動通信は許可しない。
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.contentCleanups.delete(cleanup);
        request.abort();
        if (error) reject(error); else resolve(result);
      };
      const cleanup = () => finish(new Error('キャンセルしました。'));
      (job.contentCleanups ||= new Set()).add(cleanup);
      const timer = setTimeout(() => finish(new Error('投稿の添付リンクを解決できませんでした。再試行してください。')), 15000);
      request.on('redirect', (_status, _method, next) => finish(null, next));
      request.on('response', response => {
        if (response.statusCode !== 200) { finish(new Error('投稿の添付リンクの転送先を確認できませんでした。')); return; }
        let bytes = 0;
        const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 262144) finish(new Error('添付リンクの転送ページが想定より大きいため停止しました。'));
          else chunks.push(chunk);
        });
        response.on('error', error => finish(error));
        response.on('end', async () => {
          if (settled) return;
          try {
            const next = await wc.executeJavaScript(expression(contentScripts.readShortRedirect, Buffer.concat(chunks).toString('utf8')));
            if (!next) throw new Error('投稿の添付リンクの転送先を確認できませんでした。');
            finish(null, next);
          } catch (error) { finish(error); }
        });
      });
      request.on('error', error => finish(error));
      request.end();
    });
    url = new URL(location, url);
  }
  throw new Error('添付リンクの転送が多すぎるため、全文を確認できませんでした。');
}

// 元の投稿を移動させず、通常は同じログイン状態、公開確認時は専用セッションで参照先を読む。
async function readSupplement(wc, url, job, read, sourceSession = wc.session) {
  if (job.cancelled) throw new Error('キャンセルしました。');
  if (!isXNavigation(url)) throw new Error('全文の参照先がXのURLではありません。');
  const win = new BrowserWindow({ show: false, width: 700, height: 1000, webPreferences: { session: sourceSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  secureRemote(win, 'page');
  const cleanup = () => { if (!win.isDestroyed()) win.destroy(); };
  (job.contentCleanups ||= new Set()).add(cleanup);
  try {
    await deadline(win.loadURL(url), 35000, '引用またはGrok回答の全文を読み込めませんでした。再試行してください。');
    return await read(win.webContents);
  } finally { cleanup(); job.contentCleanups.delete(cleanup); }
}

// 同じ共有URLの本文が安定したことを確認してから、質問と回答を返す。
async function loadGrokContent(wc, url, job) {
  const publicSession = session.fromPartition('postclip-public');
  // 公開された共有ページを優先し、ログイン中の画面構造に依存させない。
  const read = sourceSession => readSupplement(wc, url, job, async source => {
    let last = '', stable = 0;
    return waitUntil(async () => {
      const result = await source.executeJavaScript(expression(contentScripts.readGrokContent, new URL(url).pathname));
      if (!result) return false;
      const signature = result.question + result.text;
      stable = signature === last ? stable + 1 : 0;
      last = signature;
      return stable >= 4 ? result : false;
    }, job, 20000, 'Grok回答の全文を確認できませんでした。省略されたカードだけでは保存しません。');
  }, sourceSession);
  try { return await read(publicSession); }
  catch (error) {
    if (job.cancelled || wc.session === publicSession) throw error;
    return read(wc.session);
  }
}

// 質問または回答の先頭を照合し、カードに対応する共有回答を一意に選ぶ。
function matchingGrokContent(resource, answers) {
  const normalize = text => (text || '').replace(/\s+/g, '').replace(/[.…]+$/, '');
  const question = normalize(resource.question).slice(0, 60);
  const preview = normalize(resource.preview).slice(0, 60);
  // 会話に複数の回答がある場合も、カードに表示された質問・回答と対応付ける。
  const candidates = question.length >= 12 || preview.length >= 20 ? answers.flatMap(content => (content.turns || [content]).map(turn => ({ ...content, ...turn }))) : answers;
  const matches = candidates.filter(content => question.length >= 12 ? normalize(content.question).startsWith(question) : preview.length >= 20 ? normalize(content.text).startsWith(preview) : candidates.length === 1);
  return matches.length === 1 ? matches[0] : null;
}

// 表示データから得た共有候補を検証し、同じURLの全文取得を重複させない。
async function readGrokCandidates(wc, candidates, job) {
  const cache = job.fullContentCache ||= new Map();
  const results = [], seen = new Set();
  for (const candidate of candidates) {
    const url = cache.has(candidate) ? cache.get(candidate) : await resolveGrokUrl(wc, candidate, job);
    cache.set(candidate, url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const content = cache.get('content:' + url) || await loadGrokContent(wc, url, job);
    cache.set('content:' + url, content);
    results.push(content);
  }
  return results;
}

// カードの描画データを優先し、URLがない場合は同じ投稿の公開表示から共有先を取り直す。
async function recoverPublicGrok(wc, resource, job) {
  if (resource.candidates?.length) {
    const answers = await readGrokCandidates(wc, resource.candidates, job);
    const content = matchingGrokContent(resource, answers);
    if (content) return { ...resource, kind: 'grok', content };
  }
  if (!resource.postUrl) throw new Error('Grokカードが属する投稿URLを確認できませんでした。');
  const post = parsePostUrl(resource.postUrl);
  const cache = job.fullContentCache ||= new Map();
  const cacheKey = 'public-grok:' + post.id;
  if (!cache.has(cacheKey)) {
    job.report?.('Grokの共有先を元投稿の公開情報から確認しています…', 33);
    const answers = await readSupplement(wc, post.url, job, async source => {
      await waitUntil(async () => {
        const state = await source.executeJavaScript(expression(scripts.inspectPost, post.id));
        const error = postAccessError(state);
        if (error) throw error;
        return state.found;
      }, job, 20000, `投稿ID ${post.id} の公開表示からGrok共有先を確認できませんでした。`);
      const candidates = await waitUntil(async () => {
        const state = await source.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, 'none'));
        const ownsPost = item => { try { return parsePostUrl(item.postUrl).id === post.id; } catch { return false; } };
        const urls = [...state.resources.filter(ownsPost).map(item => item.url), ...state.unresolved.filter(ownsPost).flatMap(item => item.candidates || [])];
        return urls.length ? urls : false;
      }, job, 10000, `投稿ID ${post.id} の公開表示からGrok共有先を取得できませんでした。`);
      return readGrokCandidates(source, candidates, job);
    }, session.fromPartition('postclip-public'));
    cache.set(cacheKey, answers);
  }
  const content = matchingGrokContent(resource, cache.get(cacheKey));
  if (!content) throw new Error(`投稿ID ${post.id} の公開情報から、表示中のGrokカードに一致する共有回答を確認できませんでした。`);
  return { ...resource, kind: 'grok', content };
}

// URLを持たない引用カードは別画面で開き、元の表示を維持して実際の遷移先を得る。
async function resolveQuotedPost(wc, control, job) {
  const owner = parsePostUrl(control.ownerUrl);
  return readSupplement(wc, owner.url, job, async source => {
    await waitUntil(async () => {
      const state = await source.executeJavaScript(expression(scripts.inspectPost, owner.id));
      const error = postAccessError(state);
      if (error) throw error;
      return state.found;
    }, job, 20000, '引用を含む元投稿を確認できませんでした。');
    const opened = await source.executeJavaScript(expression(contentScripts.openQuotedPost, owner.id, control.text));
    if (!opened) throw new Error('省略された引用カードを元投稿内で一意に確認できませんでした。');
    return waitUntil(async () => {
      let post;
      try { post = parsePostUrl(source.getURL()); } catch { return false; }
      return post.id !== owner.id ? post.url : false;
    }, job, 8000, '引用カードを開いても引用元の投稿URLを取得できませんでした。');
  });
}

// リンク型の省略表示は引用元を別画面で読み、本文の先頭一致も確認する。
async function loadFullPostBody(wc, control, job) {
  const post = parsePostUrl(control.url);
  return readSupplement(wc, post.url, job, async source => {
    await waitUntil(async () => {
      const state = await source.executeJavaScript(expression(scripts.inspectPost, post.id));
      const error = postAccessError(state);
      if (error) throw error;
      return state.found;
    }, job, 20000, '引用元の全文を確認できませんでした。');
    const state = await source.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, 'body'));
    for (const more of state.controls.filter(item => !item.url)) {
      await source.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, 'body', 'expand', more.key));
      await delay(500, job);
    }
    const after = await source.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, 'body'));
    if (after.controls.length || after.clipped.length || after.pending) throw new Error('引用元にも省略が残っています。全文を確認できないため保存を止めました。');
    const result = await source.executeJavaScript(expression(contentScripts.readFullPostBody, post.id));
    const prefix = control.text.replace(/\s*(?:さらに表示|もっと見る|Show more|Read more)\s*$/i, '').replace(/[.…]+$/, '').replace(/\s+/g, '').slice(0, 80);
    if (!result || (prefix && !result.text.replace(/\s+/g, '').startsWith(prefix))) throw new Error('引用元の本文が元の表示と一致しませんでした。');
    return result;
  });
}

// 選んだ投稿・返信先・引用を繰り返し展開し、Grok共有先の全文も取得する。
async function completeContent(wc, post, options, job) {
  job.report?.('本文・引用・Grok回答の全文を取得しています…', 32);
  const supplements = [];
  const fetched = new Set();
  const attempts = new Map();
  let state;
  for (let step = 0; step < 40; step++) {
    if (job.cancelled) throw new Error('キャンセルしました。');
    state = await wc.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, options.conversation));
    const control = state.controls.find(item => !fetched.has(item.key));
    if (!control) break;
    if (control.url || control.ownerUrl) {
      if (!control.bodyKey) throw new Error('省略された引用の本文領域を確認できませんでした。');
      const url = control.url || await resolveQuotedPost(wc, control, job);
      const content = await loadFullPostBody(wc, { ...control, url }, job);
      supplements.push({ ...control, kind: 'post', content });
      fetched.add(control.key);
      continue;
    }
    const count = (attempts.get(control.key) || 0) + 1;
    attempts.set(control.key, count);
    if (count > 2) throw new Error('「さらに表示」を展開できませんでした。途中までの画像は保存しません。「Xを開いて再試行」で本文を確認してください。');
    const before = wc.getURL();
    await wc.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, options.conversation, 'expand', control.key));
    await waitUntil(async () => {
      if (wc.getURL() !== before) throw new Error('本文の展開で別のページに移りました。指定した投稿を開き直してください。');
      const next = await wc.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, options.conversation));
      return !next.controls.some(item => item.key === control.key) || next.signature !== state.signature;
    }, job, 8000, '「さらに表示」の読み込みが完了しませんでした。全文を取得できるまで画像の保存を止めました。');
  }
  state = await wc.executeJavaScript(expression(contentScripts.inspectFullContent, post.id, options.conversation));
  if (state.controls.some(item => !fetched.has(item.key))) throw new Error('本文の省略をすべて展開できませんでした。');
  for (const resource of state.unresolved) supplements.push(await recoverPublicGrok(wc, resource, job));
  const cache = job.fullContentCache ||= new Map();
  for (const resource of state.resources) {
    const url = cache.has(resource.url) ? cache.get(resource.url) : await resolveGrokUrl(wc, resource.url, job);
    cache.set(resource.url, url);
    if (!url) {
      if (resource.required) throw new Error('Grokカードの共有先を確認できませんでした。');
      continue;
    }
    const contentKey = 'content:' + url;
    const content = cache.get(contentKey) || await loadGrokContent(wc, url, job);
    cache.set(contentKey, content);
    const matched = matchingGrokContent(resource, [content]);
    if (!matched) throw new Error('Grok共有ページの質問・回答が表示中のカードと一致しませんでした。');
    supplements.push({ ...resource, kind: 'grok', content: matched });
  }
  return supplements;
}

// 実際の展開操作と描画のはみ出しを検査し、途中の内容を完成PNGにしない。
async function assertFullContent(wc, post) {
  const state = await wc.executeJavaScript(expression(contentScripts.inspectFullContent, null, 'none'));
  const problems = [];
  if (state.unresolved.length) problems.push(`Grokカードの共有先 ${state.unresolved.length}件`);
  if (state.controls.length) problems.push(`未展開の本文・引用 ${state.controls.length}件`);
  if (state.clipped.length) problems.push(`表示枠で切れている本文 ${state.clipped.length}件`);
  if (state.pending) problems.push('読み込み中の内容');
  if (problems.length) throw new Error(`全文表示を確認できませんでした${post ? `（投稿ID ${post.id}）` : ''}。${problems.join('、')}を確認してください。「Xを開いて再試行」で表示済みの投稿から作成できます。`);
}

// 表示中の対象記事とノートを確認し、撮影前の読込を完了させる。
async function preparePage(wc, post, options, job) {
  let blockedReason = '', blockedSince = 0;
  await waitUntil(async () => {
    const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
    const error = postAccessError(state);
    if (error) {
      if (blockedReason !== error.code) { blockedReason = error.code; blockedSince = Date.now(); }
      if (Date.now() - blockedSince >= 1000 && !(error.code === 'login' && state.pending)) throw error;
      return false;
    }
    blockedReason = '';
    return state.found;
  }, job, 25000, 'このページから対象の投稿を確認できませんでした。「Xを開いて再試行」で本文の表示を確認してください。');
  await wc.executeJavaScript(expression(scripts.revealPost, post.id, options.conversation));
  let lastSignature = null, stable = 0, seenNote = false;
  const notesStarted = Date.now();
  let noteState;
  await waitUntil(async () => {
    const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
    const error = postAccessError(state);
    if (error) throw error;
    if (!state.found) return false;
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
  await deadline(wc.executeJavaScript(expression(scripts.settleAssets, post.id, options.conversation)), 22000, '投稿内の画像の読み込みが終わりませんでした。もう一度作成してください。');
  noteState = await wc.executeJavaScript(expression(scripts.inspectCommunityNote, post.id));
  if (options.includeNotes && !noteState.found && (seenNote || noteState.hint || noteState.pending)) {
    throw new Error('コミュニティノートの表示が確定していません。少し待って、もう一度作成してください。');
  }
  const fullContent = job.openPageSnapshot?.id === post.id && wc.getURL().startsWith('data:') ? job.openPageSnapshot.fullContent : await completeContent(wc, post, options, job);
  return { ...noteState, fullContent: fullContent || [] };
}

// Xウィンドウで利用者が表示した同じ投稿だけを、再読込せず静的DOMへ保存する。
async function snapshotOpenPage(wc, post, options, job) {
  const fail = message => Object.assign(new Error(message), { recovery: true });
  if (!wc || wc.isDestroyed()) throw fail('先に「Xを開いて再試行」で投稿を開いてください。');
  let current;
  try { current = parsePostUrl(wc.getURL()); } catch {}
  if (current?.id !== post.id) throw fail('開いたX画面に指定した投稿を表示してください。別の投稿やログイン画面は撮影できません。');
  const noteState = await preparePage(wc, post, options, job);
  if (job.cancelled) throw new Error('キャンセルしました。');
  if (noteState.fullContent?.length) await wc.executeJavaScript(expression(contentScripts.applyFullContent, noteState.fullContent));
  // 待機中に別投稿へ移った場合も、入力した投稿との一致を確認する。
  if (parsePostUrl(wc.getURL()).id !== post.id) throw fail('X画面の投稿が変わりました。指定した投稿を開き直してください。');
  const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
  if (!state.found) throw postAccessError(state) || fail('対象の投稿を見失いました。X画面で表示を確認してください。');
  const snapshot = await wc.executeJavaScript(expression(scripts.snapshotEmbeddedFrame));
  if (!snapshot) throw fail('開いたX画面から投稿を取得できませんでした。');
  return { id: post.id, snapshot, fullContent: noteState.fullContent, notesExpected: options.includeNotes && noteState.found };
}

// X画面のGrok展開操作から全文取得を行い、同じ投稿のカードをその場で更新する。
async function expandOpenGrok(wc, post, job) {
  const sourceUrl = wc.getURL();
  const state = await wc.executeJavaScript(expression(scripts.inspectPost, post.id));
  if (!state.found) throw postAccessError(state) || new Error('表示中の投稿を確認できませんでした。');
  const items = await completeContent(wc, post, { conversation: 'none' }, job);
  if (job.cancelled || wc.getURL() !== sourceUrl) throw new Error('投稿画面が変わったため、全文の表示を中止しました。');
  if (!items.some(item => item.kind === 'grok')) throw new Error('この投稿のGrokカードを確認できませんでした。');
  await wc.executeJavaScript(expression(contentScripts.applyFullContent, items));
  return true;
}

// 通常の読込または利用者が開いた画面の複製から、同じ撮影処理へ進む。
async function loadPage(wc, post, options, job) {
  if (job.openPageSnapshot?.id === post.id) await loadSnapshot(wc, job.openPageSnapshot.snapshot);
  else await deadline(wc.loadURL(post.url), 45000, 'Xへの接続に時間がかかっています。少し待って再試行してください。');
  const noteState = await preparePage(wc, post, options, job);
  if (job.openPageSnapshot?.id === post.id && job.openPageSnapshot.notesExpected && !noteState.found) throw new Error('開いたX画面のコミュニティノートを撮影領域に含められませんでした。もう一度表示を確認してください。');
  await wc.executeJavaScript(expression(contentScripts.applyFullContent, noteState.fullContent));
  const result = await wc.executeJavaScript(expression(scripts.isolatePost, post.id, { ...options, noteExpected: options.includeNotes && noteState.found }));
  await assertFullContent(wc, post);
  return { ...result, notesStatus: result.notesIncluded ? 'included' : options.includeNotes ? 'not-shown' : 'unchecked' };
}

// Xの投稿をブラウザーの描画倍率で直接PNG化する。
async function renderPost(post, options, job, report) {
  job.report = report;
  // ノートを求めたときは埋め込みの省略に依存せず、Xの投稿画面を使う。
  if (options.mode === 'auto' || options.includeNotes || job.openPageSnapshot) options = { ...options, mode: 'page' };
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
      } catch (e) {
        if (job.cancelled) throw e;
        warnings.push('画像の読み込みを最後まで確認できませんでした。プレビューをご確認ください。');
      }
    }
    if (options.mode === 'embed') {
      const state = await wc.executeJavaScript(expression(contentScripts.inspectFullContent, null, 'none'));
      if (state.controls.length || state.resources.length || state.clipped.length || state.unresolved.length || state.pending) {
        report('省略された内容を投稿画面から全文取得しています…', 35);
        return await renderPost(post, { ...options, mode: 'page' }, job, report);
      }
    }
    await assertFullContent(wc);
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
  finally { job.abort = null; cleanupContent(job); }
}

module.exports = { capturePost, snapshotOpenPage, expandOpenGrok, expression, deadline, cleanupContent };
