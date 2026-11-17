# UI SC / UI Symbols

## UI SC

Noto Sans SC, renamed UI SC after subsetting. Licensed under SIL OFL 1.1; see OFL.txt.

Upstream: https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans

Rebuild with Python, fonttools 4.60.2, brotli 1.2.0 and zopfli 0.2.3.post1:

```sh
python scripts/build-ui-fonts.py /path/to/NotoSansSC-VF.ttf /path/to/OFL.txt
```

The shipped 400/500/600 files and character repertoire come from v1.34.1.
`manifest.json` records their SHA-256 hashes and the fixed subsetting input.
The macOS text styles preserve the fallback faces used by that release.

## UI Symbols

`ui-symbols-400.woff2` holds only the monochrome marks UI SC has no glyphs for —
the command chevrons (`▾ ▸ ▴ ⌄`), the key hints (`↵ ⌘ ↻ ⇕`), the run ticks
(`✓ ✗ ✕ ☑`), box-drawing and subscript marks. Without it each OS uses its own
symbol font (SF Symbols / Apple Symbols vs Segoe UI Symbol), which is visible in
chrome. Coloured emoji are excluded on purpose: they come from the bundled
`/fonts/noto-color-emoji` face instead.

Sources are four SIL OFL 1.1 Noto fonts (Math, Symbols 2, Symbols, Sans), each
subset to the codepoints it owns and merged in that priority order:

```sh
python scripts/build-ui-symbols.py \
  /path/to/NotoSansMath-Regular.ttf /path/to/NotoSansSymbols2-Regular.ttf \
  /path/to/NotoSansSymbols[\wght\].ttf /path/to/NotoSans[\wdth,wght\].ttf \
  web/public/fonts/noto-color-emoji/noto-color-emoji-400.woff2 \
  /path/to/notosansmath/OFL.txt /path/to/notosanssymbols2/OFL.txt \
  /path/to/notosanssymbols/OFL.txt /path/to/notosans/OFL.txt
```

It also backfills accented Latin (`U+0100-017F`), Greek (`U+0370-03FF`) and
Cyrillic (`U+0400-052F`) so model output in those scripts stays inside the bundle.

`symbols.json` records each upstream URL, its SHA-256 and the codepoints it
supplied. The build fails when a character `web/src` renders is covered by neither
UI SC, the emoji face, nor a symbol source (variation selectors and the two
private range literals are exempt).
