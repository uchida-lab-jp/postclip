'use strict';
const path = require('node:path');
const { version } = require('../package.json');

// 依存関係を除いたアプリとChromiumをWindows配布フォルダーへまとめる。
async function build() {
  const { packager } = await import('@electron/packager');
  const paths = await packager({
    dir: path.resolve(__dirname, '..'), out: path.resolve(__dirname, '..', 'dist'),
    name: 'PostClip', executableName: 'PostClip', platform: 'win32', arch: 'x64',
    electronVersion: require('electron/package.json').version, asar: true, prune: true, overwrite: true,
    icon: path.resolve(__dirname, '..', 'app', 'assets', 'icon.ico'),
    appVersion: version, buildVersion: version, appCopyright: 'PostClip contributors',
    win32metadata: { CompanyName: 'PostClip', ProductName: 'PostClip', FileDescription: 'PostClip - X post capture', OriginalFilename: 'PostClip.exe' },
    ignore: [/^\/tests(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/dist(?:\/|$)/, /^\/qa(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/booth(?:\/|$)/, /^\/assets-output(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/package-lock\.json$/, /^\/LICENSE-PostClip\.txt$/, /\.log$/]
  });
  process.stdout.write(paths.join('\n') + '\n');
}
build().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
