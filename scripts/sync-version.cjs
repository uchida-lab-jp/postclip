'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// package.jsonを唯一の版番号として、現行の説明書と配布ファイル参照へ反映する。
function syncVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('製品バージョンはX.Y.Z形式で指定してください。');
  for (const file of ['README.md', 'docs/はじめに.txt', 'docs/DEVELOPMENT.md', 'booth/公開手順.txt', 'booth/検証メモ.txt', 'booth/商品説明.txt']) {
    const target = path.join(root, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = before.replace(/^(# )?PostClip \d+\.\d+\.\d+/m, (_match, prefix = '') => `${prefix}PostClip ${version}`)
      .replace(/postclip-(win-x64|source|seller-kit)-v\d+\.\d+\.\d+(?:\.rev\d+)?\.zip/g, (_match, kind) => `postclip-${kind}-v${version}.zip`);
    if (after !== before) fs.writeFileSync(target, after);
  }
}
syncVersion();
