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
VERSION_SUFFIX = re.compile(r"(?:-v\d+(?:\.\d+)*|\.rev\d+)", re.IGNORECASE)


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


# 内部は固定名とし、明示した配布ZIPだけに実バージョンを許可する。
def write_zip(target, entries, allowed_versioned=()):
    with ZipFile(target, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in sorted(entries.items()):
            parts = PurePosixPath(name)
            if parts.is_absolute() or ".." in parts.parts:
                raise RuntimeError(f"内部パスが不正です: {name}")
            if VERSION_SUFFIX.search(name) and name not in allowed_versioned:
                raise RuntimeError(f"内部ファイル名が規約に合いません: {name}")
            archive.write(path, name, compress_type=ZIP_STORED if path.suffix == ".zip" else ZIP_DEFLATED)
    with ZipFile(target) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"ZIPの検証に失敗しました: {bad}")
        if len(archive.namelist()) != len(entries):
            raise RuntimeError("ZIP内のファイル数が一致しません。")
    print(f"Verified {target.name}: {len(entries)} files, {target.stat().st_size:,} bytes")


# 製品ZIPに実バージョンを付け、ソースと掲載素材をseller-kitへ収める。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--revision", type=int, help="同じ製品版の再出力時にseller-kitへ付ける番号")
    args = parser.parse_args()
    if args.revision is not None and args.revision < 2:
        parser.error("--revisionは2以上を指定してください。")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("製品バージョンをmajor.minor.patch形式で指定してください。")
    runtime = ROOT / "dist/PostClip-win32-x64"
    check_build(runtime, version)
    for image_name in ["booth-cover.png", "booth-guide.png", "postclip-screen.png"]:
        image_header = (ROOT / "booth" / image_name).read_bytes()[:24]
        if image_header[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"掲載画像はPNGで保存してください: {image_name}")
        width, height = struct.unpack(">II", image_header[16:24])
        if width != height:
            raise RuntimeError(f"掲載画像は正方形にしてください: {image_name}")
        print(f"Square image verified: {image_name}, {width} x {height}")
    suffix = f".rev{args.revision}" if args.revision is not None else ""
    seller_name = f"postclip-seller-kit-v{version}{suffix}.zip"

    windows = output / f"postclip-v{version}.zip"
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

    source = output / "postclip.zip"
    source_files = [ROOT / name for name in [
        "package.json", "package-lock.json", "README.md", "LICENSE-PostClip.txt", ".gitignore",
    ]]
    for folder in ["app", "tests", "scripts", "docs", "booth"]:
        source_files.extend(path for path in (ROOT / folder).rglob("*")
                            if path.is_file() and "__pycache__" not in path.parts
                            and path.name != "SHA256.txt")
    write_zip(source, {"postclip/" + path.relative_to(ROOT).as_posix(): path
                       for path in source_files})

    with tempfile.TemporaryDirectory(prefix="postclip-package-") as staging:
        stage = Path(staging)
        readme = stage / "README.txt"
        readme.write_text(f"""PostClip {version} — BOOTH公開者向けセット

価格は0円、体験版はありません。

【同梱物】
配布用/{windows.name} : BOOTHへ登録するWindows x64用アプリ
ソース/postclip.zip : postclip/ の中に開発ソース・テスト・ビルド手順・掲載素材
掲載素材/ : 商品名、商品説明、タグ候補、公開手順、紹介画像
検証メモ.txt : 実施済みの確認と未確認の範囲
SHA256.txt : 同梱ファイルの照合用ハッシュ

【公開するには】
1. 「掲載素材/公開手順.txt」を開きます。
2. BOOTHには「配布用/{windows.name}」を登録します。
3. 商品名・説明・画像を設定し、価格を0円にします。

seller-kit全体は制作者向けです。
商品が登録済みの場合は、掲載画像や配布ZIPのうち更新対象を差し替えてください。
Windows実機での起動は未検証です。詳しくは検証メモをご覧ください。

【ファイル名の規則】
外側のZIPは {seller_name} です。
配布する製品ZIPは {windows.name} です。-vの後ろは実バージョンです。
ソースZIPは postclip.zip、展開時の最上位フォルダーは postclip/ です。
アプリ内部・掲載素材・ソース内部のファイル名は番号なしの固定名です。
同じアプリ版の再出力では、指定された場合だけseller-kitの末尾に.rev番号を付けます。
アプリの実バージョンは {version} です。
本体・公開素材・ソースはこのZIP一本にまとめて渡します。

【先頭サムネイル】
掲載素材/booth-cover.png は正方形です。
商品一覧での見やすさを優先し、キャッチコピー・短い説明・無料表示に絞っています。
細かな仕様と操作手順は、2枚目以降の画像と商品説明に掲載します。

【掲載画像のサイズ】
booth-cover.png、booth-guide.png、postclip-screen.pngは、いずれも1:1の正方形です。
postclip-screen.pngは、架空投稿を読み込んだ実際のアプリ画面を撮影した画像です。
""", encoding="utf-8")
        contents = {
            "README.txt": readme,
            "配布用/" + windows.name: windows,
            "ソース/postclip.zip": source,
            "検証メモ.txt": ROOT / "booth/検証メモ.txt",
        }
        for name in ["商品名.txt", "商品説明.txt", "タグ候補.txt", "公開手順.txt",
                     "booth-cover.png", "booth-guide.png", "postclip-screen.png"]:
            contents["掲載素材/" + name] = ROOT / "booth" / name
        manifest = stage / "SHA256.txt"
        manifest.write_text("".join(f"{sha256(path)}  {name}\n" for name, path in sorted(contents.items())),
                            encoding="utf-8")
        contents["SHA256.txt"] = manifest
        seller = output / seller_name
        write_zip(seller, {"PostClip-seller-kit/" + name: path for name, path in contents.items()},
                  allowed_versioned={"PostClip-seller-kit/配布用/" + windows.name})
        print(f"Deliver only: {seller}")


if __name__ == "__main__":
    main()
