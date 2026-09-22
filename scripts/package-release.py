"""PostClipの本体・公開素材・ソースを、実バージョン付きのZIP一本にまとめる。"""

import argparse
import hashlib
import json
import re
import struct
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
REVISION = re.compile(r"-v\d+(?:\.\d+)*", re.IGNORECASE)


# ファイルを分割して読み込み、配布物の照合用ハッシュを計算する。
def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# ビルド済みEXEの対象環境と、同梱されたアプリの内容を確認する。
def check_build(runtime, version):
    exe = runtime / "PostClip.exe"
    with exe.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise RuntimeError("PostClip.exeがWindows実行ファイルではありません。")
        stream.seek(0x3C)
        offset = struct.unpack("<I", stream.read(4))[0]
        stream.seek(offset)
        if stream.read(6) != b"PE\x00\x00\x64\x86":
            raise RuntimeError("PostClip.exeがWindows x64向けではありません。")
    sources = ["README.md"] + [
        str(path.relative_to(ROOT)).replace("\\", "/")
        for path in sorted((ROOT / "app").rglob("*")) if path.is_file()
    ]
    script = r"""
import fs from 'node:fs';
import path from 'node:path';
import { extractFile, listPackage } from '@electron/asar';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const packed = JSON.parse(extractFile(input.archive, 'package.json'));
if (packed.version !== input.version) throw new Error('Rebuild required: app version mismatch');
const sourcePackage = JSON.parse(fs.readFileSync(path.join(input.root, 'package.json'), 'utf8'));
// packagerが取り除く開発専用の項目以外は、package.jsonも一致させる。
for (const key of new Set([...Object.keys(sourcePackage), ...Object.keys(packed)])) {
  if (['scripts', 'devDependencies', 'private'].includes(key)) continue;
  if (JSON.stringify(sourcePackage[key]) !== JSON.stringify(packed[key])) throw new Error('Rebuild required: package.json ' + key);
}
for (const file of input.sources) {
  const local = fs.readFileSync(path.join(input.root, file));
  if (!local.equals(extractFile(input.archive, file))) throw new Error('Rebuild required: ' + file);
}
for (const file of listPackage(input.archive)) {
  if (/^\/(qa|tests|scripts|booth|docs|dist)(\/|$)/.test(file)) throw new Error('Unexpected development file: ' + file);
}
console.log('Bundled app matches source: ' + input.version + ' (' + input.sources.length + ' files)');
"""
    subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps({"root": str(ROOT), "archive": str(runtime / "resources/app.asar"),
                          "version": version, "sources": sources}),
        text=True, check=True, cwd=ROOT,
    )


# 内部ファイル名を検査し、入れ子のZIPは再圧縮せずにまとめる。
def write_zip(target, entries):
    with ZipFile(target, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in sorted(entries.items()):
            parts = PurePosixPath(name)
            if parts.is_absolute() or ".." in parts.parts or REVISION.search(name):
                raise RuntimeError(f"内部ファイル名が規約に合いません: {name}")
            archive.write(path, name, compress_type=ZIP_STORED if path.suffix == ".zip" else ZIP_DEFLATED)
    with ZipFile(target) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"ZIPの検証に失敗しました: {bad}")
        if len(archive.namelist()) != len(entries):
            raise RuntimeError("ZIP内のファイル数が一致しません。")
    print(f"Verified {target.name}: {len(entries)} files, {target.stat().st_size:,} bytes")


# 本体ZIP、ソースZIP、BOOTH掲載素材を固定名でseller-kitへ収める。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    output = parser.parse_args().output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("製品バージョンをmajor.minor.patch形式で指定してください。")
    runtime = ROOT / "dist/PostClip-win32-x64"
    check_build(runtime, version)

    windows = output / "postclip-windows.zip"
    runtime_entries = {
        "PostClip/" + path.relative_to(runtime).as_posix(): path
        for path in runtime.rglob("*") if path.is_file()
    }
    runtime_entries.update({
        "PostClip/はじめに.txt": ROOT / "docs/はじめに.txt",
        "PostClip/README.md": ROOT / "README.md",
        "PostClip/LICENSE-PostClip.txt": ROOT / "LICENSE-PostClip.txt",
    })
    write_zip(windows, runtime_entries)

    source = output / "postclip-source.zip"
    source_files = [ROOT / name for name in [
        "package.json", "package-lock.json", "README.md", "LICENSE-PostClip.txt", ".gitignore",
    ]]
    for folder in ["app", "tests", "scripts", "docs", "booth"]:
        source_files.extend(path for path in (ROOT / folder).rglob("*")
                            if path.is_file() and "__pycache__" not in path.parts
                            and path.name != "SHA256.txt")
    write_zip(source, {"postclip-source/" + path.relative_to(ROOT).as_posix(): path
                       for path in source_files})

    with tempfile.TemporaryDirectory(prefix="postclip-package-") as staging:
        stage = Path(staging)
        readme = stage / "README.txt"
        readme.write_text(f"""PostClip {version} — BOOTH公開者向けセット

価格は0円、体験版はありません。

【同梱物】
配布用/postclip-windows.zip : BOOTHへ登録するWindows x64用アプリ
ソース/postclip-source.zip : 開発ソース・テスト・ビルド手順・画像テンプレート
掲載素材/ : 商品名、商品説明、タグ候補、公開手順、紹介画像
検証メモ.txt : 実施済みの確認と未確認の範囲
SHA256.txt : 同梱ファイルの照合用ハッシュ

【公開するには】
1. 「掲載素材/公開手順.txt」を開きます。
2. BOOTHには「配布用/postclip-windows.zip」を登録します。
3. 商品名・説明・画像を設定し、価格を0円にします。

seller-kit全体は制作者向けです。
実際のBOOTHへの出品操作はまだ行っていません。
Windows実機での起動は未検証です。詳しくは検証メモをご覧ください。

【ファイル名の規則】
外側のZIPは postclip-seller-kit-v{version}.zip です。
-vの後ろはアプリの実バージョンです。リビジョン管理はしません。
ZIP内のファイル名・フォルダー名は番号の付かない固定名です。
本体・公開素材・ソースはこのZIP一本にまとめて渡します。
""", encoding="utf-8")
        contents = {
            "README.txt": readme,
            "配布用/postclip-windows.zip": windows,
            "ソース/postclip-source.zip": source,
            "検証メモ.txt": ROOT / "booth/検証メモ.txt",
        }
        for name in ["商品名.txt", "商品説明.txt", "タグ候補.txt", "公開手順.txt",
                     "booth-cover.png", "booth-guide.png", "postclip-screen.png"]:
            contents["掲載素材/" + name] = ROOT / "booth" / name
        manifest = stage / "SHA256.txt"
        manifest.write_text("".join(f"{sha256(path)}  {name}\n" for name, path in sorted(contents.items())),
                            encoding="utf-8")
        contents["SHA256.txt"] = manifest
        seller = output / f"postclip-seller-kit-v{version}.zip"
        write_zip(seller, {"PostClip-seller-kit/" + name: path for name, path in contents.items()})
        print(f"Deliver only: {seller}")


if __name__ == "__main__":
    main()
