'use strict';
const { parsePostUrl } = require('./core.cjs');
const MAX_THREAD_POSTS = 20;

// 返信先のリンクだけを順にたどり、欠落や循環を成功扱いせず古い順に返す。
async function collectThread(post, load, job, report = () => {}) {
  const seen = new Set();
  const items = [];
  let current = post;
  while (current) {
    if (job.cancelled) throw new Error('キャンセルしました。');
    if (seen.has(current.id)) throw new Error('返信先のつながりを確認できませんでした。同じ投稿が繰り返されています。');
    if (items.length >= MAX_THREAD_POSTS) throw new Error(`親までの投稿が${MAX_THREAD_POSTS}件を超えます。途中までのURLに分けて作成してください。`);
    seen.add(current.id);
    report(`親の投稿をたどっています… ${items.length + 1}件目`, Math.min(45, 18 + items.length));
    let item;
    try { item = await load(current); }
    catch (error) {
      if (job.cancelled) throw new Error('キャンセルしました。');
      if (!items.length) throw error;
      throw new Error(`返信先の投稿（ID: ${current.id}）を取得できず、親までたどれませんでした。削除・非公開・通信状態をご確認ください。`);
    }
    if (job.cancelled) throw new Error('キャンセルしました。');
    items.push({ ...item, post: current });
    if (item.parentUrl === null) break;
    if (typeof item.parentUrl !== 'string') throw new Error('返信先のつながりを確認できませんでした。');
    current = parsePostUrl(item.parentUrl);
  }
  return items.reverse();
}

module.exports = { MAX_THREAD_POSTS, collectThread };
