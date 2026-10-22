'use strict';

// X側の表示状態を、利用者が次の操作を選べるエラーへ変換する。
function postAccessError(state) {
  const messages = {
    'app-only': 'Xが「このポストはXアプリでのみ表示できます」と案内しています。「Xを開いて再試行」で表示を確認してください。本文が表示されると自動で作成を続けます。ログイン後も同じ案内が出る場合は撮影できません。',
    sensitive: 'Xがセンシティブな内容の確認画面を表示しています。Xの確認画面で本文を表示すると、自動で作成を続けます。',
    login: 'Xへのログインが必要です。開いたX画面でログインすると、自動で作成を続けます。',
    unavailable: 'Xがこの投稿を表示できないと案内しています。削除・非公開・閲覧制限の可能性があります。「Xを開いて再試行」で投稿の状態を確認してください。'
  };
  const code = state.reason || (state.unavailable ? 'unavailable' : state.login ? 'login' : '');
  if (!messages[code]) return null;
  return Object.assign(new Error(messages[code]), { code, recovery: true });
}

module.exports = { postAccessError };
