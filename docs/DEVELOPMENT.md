# PostClip 開発メモ

対象はWindows x64。UIはローカルHTML/CSS/JavaScript、デスクトップ実行基盤はElectronです。

## 必要なもの

- Node.js 22.12以上（利用するElectronとpackagerのenginesも確認）
- npm
- インターネット接続（開発依存関係とElectronバイナリーの取得）

利用者向けのWindows ZIPには実行基盤を同梱するため、利用者にNode.jsやPythonの導入は必要ありません。

## 開発とビルド

```sh
npm ci
npx install-electron
npm start
npm test
npm run test:electron
npm run test:ui
npm run test:thread
npm run build:win
```

Electron 44ではバイナリー導入を`npx install-electron`で明示的に実行します。Windows配布フォルダーは`dist/PostClip-win32-x64`です。EXE名とアイコン・バージョン情報も設定します。コード署名は行いません。

## 配布パッケージ

Windowsビルド後に、Python 3の標準ライブラリーで公開用セットを作成します。Pythonが必要なのはこの開発用の梱包処理だけで、利用者には不要です。

```sh
python scripts/package-release.py --revision 2
```

今回の完成品は`dist/postclip-seller-kit-v1.1.0.rev2.zip`です。ファイル名とライセンス配置を統一した再出力のため、アプリの実バージョンは1.1.0を維持します。バージョンは`package.json`から取得します。通常の製品版は`--revision`を省略し、`postclip-seller-kit-v実バージョン.zip`として出力します。同じアプリ版を再出力するときは、必要に応じて`--revision N`でseller-kit名だけを区別します。

本体・説明書・BOOTH掲載素材・ソースをすべて含め、seller-kitのZIPを1本だけ渡します。体験版はありません。

ZIP内は`PostClip-seller-kit/`を起点に、`配布用/postclip-win-x64-v1.1.0.zip`、`ソース/postclip-source-v1.1.0.zip`、`掲載素材/`、`README.txt`、`検証メモ.txt`、`SHA256.txt`を収めます。

- 配布する製品ZIPには対象OS・CPUと実バージョンを付けます。製品ZIP内のルートは`PostClip/`、中のファイル名・フォルダー名は固定名です。
- ソースZIPは`postclip-source-v実バージョン.zip`、その最上位フォルダーは`postclip/`に固定します。Gitリポジトリーへそのまま配置できる構成です。
- 掲載素材などの内部ファイル名に版番号は付けません。
- 同一アプリ版の再出力で区別が必要な場合だけ、指定された`.rev2`などをseller-kit名に付けます。

梱包処理は、ビルド済みアプリと開発ソースの一致、バージョン、掲載画像3枚がすべて正方形であること、内部ファイル名、ZIPの整合性を確認します。アプリの変更時にはテストとWindowsビルドを先に実施してください。

## BOOTHアプリの共通命名規則

| 用途 | 標準ファイル名 |
| --- | --- |
| Windows x64のZIP配布 | `app-win-x64-vX.Y.Z.zip` |
| ソース | `app-source-vX.Y.Z.zip` |
| 制作者向け全部入り | `app-seller-kit-vX.Y.Z.zip` |
| 将来のWindows x64インストーラー | `app-win-x64-setup-vX.Y.Z.exe` |

`app`を各アプリの識別名、`X.Y.Z`を実バージョンに置き換えます。PostClipのソースZIP内のルートは`postclip/`、配布ZIP内のルートは`PostClip/`です。同じチャットで修正品を再出力するときは、同名ファイルの取り違えを避けるため外側のseller-kitに`.revN`を付け、中の配布用・ソースZIPは上記の標準名を使います。

PostClipは設定・ログイン情報を`%APPDATA%\PostClip`へ保存するZIP展開型アプリです。完全ポータブルと誤解されないよう、配布名に`portable`は付けません。インストーラーは現時点では同梱しません。

## ライセンスの配置

ソースの`LICENSE`はPostClip自作部分のMIT本文です。Windowsの梱包時に同じ内容を`PostClip/LICENSE-PostClip.txt`へコピーし、Electron由来の`PostClip/LICENSE`と`PostClip/LICENSES.chromium.html`はそのまま保持します。`app.asar`内にもソースと同じ`LICENSE`を含めます。

梱包処理は、ソースとアプリ内部のREADME・LICENSE・実装の一致、Electron / Chromiumの表記の存在とPostClipのLICENSEによる上書きがないことを確認します。`SHA256.txt`は新しいZIP名と実際の内容から毎回生成します。

## 掲載画像

`booth/booth-cover.png`は、商品一覧のサムネイルに使う正方形の完成画像です。大きなキャッチコピー、URLを貼るだけという短い説明、無料表示に絞ります。細かな仕様や注意事項は2枚目以降と商品説明に掲載します。

`booth/cover.html`でサムネイル、`booth/guide.html`で操作説明画像を確認できます。制作条件は`booth/thumbnail-prompt.txt`と`booth/guide-prompt.txt`に記載しています。どちらも完成PNGを保持します。

画面紹介画像は`electron scripts/render-assets.cjs`で作成します。独立した設定領域で実際のアプリを起動し、通信を架空投稿に置き換え、1254×1254pxの正方形で撮影します。利用者の設定には触れず、先頭画像と操作説明画像を上書きしません。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| app/main.cjs | ウィンドウ、IPC、保存、設定 |
| app/capture.cjs | 埋め込み / 投稿画面の撮影、キャンセル、画素数検証 |
| app/thread.cjs | 返信先の順次取得、20件上限、循環・欠落・キャンセル判定 |
| app/page-scripts.cjs | 対象投稿特定、DOMの複製、画像待機、高さ測定 |
| app/network.cjs | X配信元以外の外部通信を遮断 |
| app/core.cjs | URL・設定・サイズの検証 |
| app/preload.cjs | 必要最小限の操作のみをUIへ公開 |
| app/ui/ | 日本語UI |
| tests/ | 入力検証、実ブラウザー撮影、IPC・保存操作の検証 |

## 高精細化の要点

CDPで`deviceScaleFactor`を設定しても、外部の埋め込みiframeがDPR=1のままになる場合があります。画像サイズだけが3倍になると、文字が拡大されてぼやけます。

PostClipは埋め込みのDOMとCSSOMを読み取り、実行スクリプトを取り除いた静的な描画へ移します。CSSを保ったまま最上位フレームで描き直すことで、文字を指定倍率で描画します。出来上がったPNGを後から拡大する処理はありません。PNGヘッダーの寸法も検証します。

撮影ウィンドウは画面に表示しないoffscreenモードです。初期のabout:blankフレームを生成した後にDPIを変更します。画像とフォントの読込を待ち、高さの変化が落ち着いてから撮影します。動画は停止します。

## テスト

`npm test`：URLのドメイン偽装・不正入力・設定範囲・画素数上限・ネットワーク許可先。

`npm run test:electron`：ネットワークを架空投稿に差し替え、実際のElectronでPNGを生成。返信先有無、縦長投稿、余白、ダークテーマ、画像欠落、本文省略、キャンセルを検証。

`npm run test:ui`：実際のローカルUIとIPCで、画像作成、保存したPNGのバイト一致、保存キャンセル、クリップボード、URL貼付、ヘルプ、最小サイズでのレイアウトを検証。保存ダイアログだけをテスト用の保存先に差し替えます。

GUIテストはデスクトップ画面が必要です。Linuxのコンテナーで検証する場合はXvfbなどの仮想画面が必要になる場合があります。開発環境用の`--no-sandbox`、`--ignore-certificate-errors`、プロキシ指定などを製品コードや配布用起動方法に追加しないでください。

テスト結果は`qa/`へ出力します。実際のXの投稿を確認する場合は、`POSTCLIP_LIVE=1`と`POSTCLIP_LIVE_URL`環境変数に投稿URLを指定して撮影テストを実行します。取得できない投稿やログイン状態のテストを架空投稿テストと混同しないでください。

## 保守上の注意

- Xの画面構造が変わった場合は、実在する投稿を使ってセレクターを再確認してください。
- 投稿IDをJavaScriptのNumberへ変換しないでください。
- 外部ページはNode.js無効・sandbox有効・contextIsolation有効を維持してください。
- IPCの送信元検証とURL制限を外さないでください。
- 外部通信の許可先を広げる際は、何のための送信かを確認してください。
- 投稿本文やCookieをログへ保存する実装は追加していません。
- Electron 44のクリップボードはPromiseとClipboardItemを使用します。旧writeImage/readImage APIとは異なります。

## 参照した公式資料

- https://docs.x.com/x-for-websites/embedded-posts/overview
- https://docs.x.com/x-for-websites/embedded-posts/guides/embedded-tweet-parameter-reference
- https://www.electronjs.org/docs/latest/api/web-contents
- https://www.electronjs.org/docs/latest/api/clipboard
- https://www.electronjs.org/docs/latest/tutorial/security
- https://chromedevtools.github.io/devtools-protocol/tot/Page/

依存関係の正確なバージョンはpackage-lock.jsonを参照してください。

## 親までの取得

`conversation`は`none` / `parent` / `thread`です。旧boolean設定は`true → parent`、`false → none`へ移行します。threadでは公式埋め込みを`conversation: none`で表示し、主投稿の「返信先:」リンクだけを次の親として読みます。本文中のリンク、引用のリンク、別枝の記事をたどりません。各親を個別に表示し、スクリプトを除いたDOMを先頭から同じ描画面へ並べます。投稿画面モードでも公開埋め込みで親子関係を確認した後、各投稿ページの対象記事だけを撮影します。

構造が判別できない、途中の親が取得できない、同じIDを繰り返す、20件を超える、画像上限を超える場合は完成PNGを返しません。threadの全体制限時間は6分です。検証は`npm run test:thread`、実URLは`POSTCLIP_LIVE_URL`を指定して同じスクリプトを実行します。
