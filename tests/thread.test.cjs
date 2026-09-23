'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectThread, MAX_THREAD_POSTS } = require('../app/thread.cjs');
const { parsePostUrl } = require('../app/core.cjs');
// テスト用の投稿IDから正規URLを作る。
const post = id => parsePostUrl(`https://x.com/demo/status/${id}`);

test('4件の返信を先頭から順に並べ、桁数の大きいIDも保持する', async () => {
  const ids = ['2097324064218153346','2097324059659026479','2097324054529327143','2097324049374593042'];
  const requests = [];
  const result = await collectThread(post(ids[0]), async p => {
    requests.push(p.id);
    const next = ids[ids.indexOf(p.id) + 1];
    return { parentUrl: next ? post(next).url : null, snapshot: p.id };
  }, {});
  assert.deepEqual(requests, ids);
  assert.deepEqual(result.map(item => item.post.id), [...ids].reverse());
});
test('親のない投稿は1件で完了する', async () => {
  const result = await collectThread(post('100'), async () => ({parentUrl:null}), {});
  assert.equal(result.length, 1);
});
test('消えた親・循環・不正URL・不明な関係は途中成功にしない', async () => {
  await assert.rejects(collectThread(post('200'), async p => {
    if (p.id === '100') throw new Error('unavailable');
    return {parentUrl:post('100').url};
  }, {}), /親までたどれません/);
  await assert.rejects(collectThread(post('200'), async () => ({parentUrl:post('200').url}), {}), /繰り返/);
  await assert.rejects(collectThread(post('200'), async () => ({parentUrl:'https://example.com/'}), {}));
  await assert.rejects(collectThread(post('200'), async () => ({}), {}), /つながり/);
});
test('上限を超える連鎖と取得中のキャンセルで追加通信を止める', async () => {
  let calls = 0;
  await assert.rejects(collectThread(post('100'), async () => ({parentUrl:post(String(101 + calls++)).url}), {}), /20件/);
  assert.equal(calls, MAX_THREAD_POSTS);
  const job = {cancelled:false};
  calls = 0;
  await assert.rejects(collectThread(post('200'), async () => { calls++; job.cancelled=true; return {parentUrl:post('100').url}; }, job), /キャンセル/);
  assert.equal(calls, 1);
});
