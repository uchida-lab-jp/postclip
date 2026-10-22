'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// package.jsonのバージョンをREADMEの現行版・配布ZIP名へ反映する。
function syncVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('製品バージョンはX.Y.Z形式で指定してください。');
  const target = path.join(root, 'README.md');
  const before = fs.readFileSync(target, 'utf8');
  const after = before.replace(/^# PostClip \d+\.\d+\.\d+/m, `# PostClip ${version}`)
    .replace(/postclip-win-x64-v\d+\.\d+\.\d+(?:\.rev\d+)?\.zip/g, `postclip-win-x64-v${version}.zip`);
  if (after !== before) fs.writeFileSync(target, after);
}
syncVersion();
