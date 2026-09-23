'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePostUrl, validateOptions, checkDimensions, makeFilename, isXNavigation } = require('../app/core.cjs');
const { allowedRequest } = require('../app/network.cjs');

test('投稿IDの精度を保ち、追跡パラメーターと画像番号を除去する', () => {
  const p = parsePostUrl(' https://x.com/hinabe_ch/status/2101958052673212917/photo/1?s=20&t=secret ');
  assert.equal(p.id, '2101958052673212917');
  assert.equal(p.url, 'https://x.com/hinabe_ch/status/2101958052673212917');
});
test('旧ドメイン・スキーム省略・i/web形式に対応する', () => {
  assert.equal(parsePostUrl('mobile.twitter.com/test/status/123').url, 'https://x.com/test/status/123');
  assert.equal(parsePostUrl('https://x.com/i/web/status/123').url, 'https://x.com/i/status/123');
});
test('任意URL・偽装ドメイン・認証情報・不正投稿IDを拒否する', () => {
  for (const u of ['file:///etc/passwd', 'https://x.com.evil.test/a/status/123', 'https://x.com@evil.test/a/status/123', 'https://u:p@x.com/a/status/123', 'https://x.com:8443/a/status/123', 'javascript:alert(1)', 'https://x.com/a', 'https://x.com/a/status/000', 'https://x.com/a/status/123<script>', 'https://x.com/a/status/123/other', 'https://127.0.0.1/a/status/123']) assert.throws(() => parsePostUrl(u), u);
});
test('設定範囲と不正な型を拒否する', () => {
  for (const o of [{width:319}, {width:551}, {width:400.1}, {width:'NaN'}, {scale:4}, {padding:23}, {mode:'file'}, {theme:'evil'}, {conversation:'unknown'}, {conversation:1}, []]) assert.throws(() => validateOptions(o));
  assert.deepEqual(validateOptions({}), {width:400,scale:3,padding:0,mode:'embed',theme:'light',conversation:'parent'});
});
test('縦長画像の上限超過を検出し、画質を下げれば許容する', () => {
  assert.throws(() => checkDimensions(550,10000,3));
  assert.deepEqual(checkDimensions(550,10000,1), {width:550,height:10000});
  assert.throws(() => checkDimensions(400,0,3));
});
test('保存ファイル名は安全な投稿情報と設定を含む', () => {
  const name = makeFilename(parsePostUrl('x.com/demo/status/123'),validateOptions({}),new Date('2026-09-22T12:34:56Z'));
  assert.equal(name,'postclip-demo-123-400px-3x-20260922-123456.png');
});
test('ログイン用ウィンドウの遷移をXのHTTPSだけに限定する', () => {
  assert.equal(isXNavigation('https://x.com/i/flow/login'),true);
  for (const u of ['https://evil.x.com/', 'http://x.com/', 'file:///tmp/a', 'https://google.com/', 'https://x.com:123/']) assert.equal(isXNavigation(u),false);
});
test('第三者の診断・解析送信を許可せず、Xの画像配信だけを許可する', () => {
  assert.equal(allowedRequest('postclip://capture/embed.html?id=200'),true);
  assert.equal(allowedRequest('postclip://capture/private.txt'),false);
  for (const u of ['https://x.com/i/api/graphql/test', 'https://platform.twitter.com/widgets.js', 'https://pbs.twimg.com/media/test', 'file:///local/embed.html']) assert.equal(allowedRequest(u), true);
  for (const u of ['https://o123.ingest.sentry.io/api/1/envelope/', 'https://o123.ingest.us.sentry.io/api/1/envelope/', 'https://x.com.evil.test/', 'https://analytics.example.com/', 'http://x.com/', 'https://127.0.0.1/']) assert.equal(allowedRequest(u), false);
});

test('1.0.0の返信設定を引き継ぎ、親までの選択を保持する', () => {
  assert.equal(validateOptions({conversation:true}).conversation,'parent');
  assert.equal(validateOptions({conversation:false}).conversation,'none');
  assert.equal(validateOptions({conversation:'thread'}).conversation,'thread');
});
