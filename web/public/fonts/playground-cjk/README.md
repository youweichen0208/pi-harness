# PI Playground CJK

The regular and italic faces preserve the Chinese code and comment glyphs from Sarasa Mono SC 1.0.37 used by the v1.34.1 Mac editor. Both are renamed subsets distributed under the bundled SIL Open Font License. The build uses GB2312 Han characters and the CJK portion of the bundled UI character list. The complete Sarasa face can supply additional characters when installed locally.

Download and extract [Sarasa-SuperTTC-1.0.37.7z](https://github.com/be5invis/Sarasa-Gothic/releases/download/v1.0.37/Sarasa-SuperTTC-1.0.37.7z) (archive SHA-256 `bda22d32a7cb6585fadd412bb68c008e75e88375a533347bc659c53a478ff0d2`). The builder verifies the SHA-256 of the extracted TTC. From the repository root, run:

```sh
uv run --no-project --python 3.11 --with fonttools==4.68.0 --with brotli==1.2.1 python scripts/build-playground-fonts.py /path/to/Sarasa-SuperTTC.ttc
```
