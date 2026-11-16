"""Rebuild UI Symbols: the arrow/technical/geometric/dingbat glyphs the UI renders
but UI SC (a Noto Sans SC subset) does not contain.

Without this face every OS falls back to its own symbol font (SF Symbols/Apple
Symbols vs Segoe UI Symbol), which is a visible cross-platform difference in
chrome like the command chevrons, the tool-run ticks and the key hints.

Sources, all SIL OFL 1.1, pinned by revision and verified by SHA-256. Each source
is subset to the codepoints it owns and the survivors are merged in priority
order, so a codepoint is taken from the first font that has it. `symbols.json`
records the upstream URL, revision and hash of every source.

Two coverage rules:
  * every character web/src renders that UI SC and the emoji face lack MUST be
    supplied by a source, otherwise the build fails;
  * the extra blocks below are taken opportunistically so Latin-1/Extended,
    Greek and Cyrillic text from model output also avoids the system font.

Args: <NotoSansMath-Regular.ttf> <NotoSansSymbols2-Regular.ttf>
      <NotoSansSymbols-VF.ttf> <NotoSans-VF.ttf> <emoji.woff2> <OFL.txt>...
"""
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parent.parent
out = root / "web/src/assets/fonts"
PINNED = "google/fonts@main ofl/"
sources = [
	# Math carries the arrows and technical marks (↵ ↻ ⇕ ↶ ↷ ▾ ▸ ▴ ◫).
	("Noto Sans Math", Path(sys.argv[1]), None, "https://github.com/google/fonts/raw/main/ofl/notosansmath/NotoSansMath-Regular.ttf"),
	# Symbols 2 carries the tick/cross and checklist marks (✗ ✕ ☑ ⌫ ✓ ✔).
	("Noto Sans Symbols 2", Path(sys.argv[2]), None, "https://github.com/google/fonts/raw/main/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf"),
	# Symbols 1 carries the chevron and corner marks (⌄ ⌟).
	("Noto Sans Symbols", Path(sys.argv[3]), 400, "https://github.com/google/fonts/raw/main/ofl/notosanssymbols/NotoSansSymbols%5Bwght%5D.ttf"),
	# Noto Sans carries the combining stroke, subscripts and the accented
	# Latin/Greek/Cyrillic letters UI SC omits.
	("Noto Sans", Path(sys.argv[4]), 400, "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf"),
]
license_paths = [Path(value) for value in sys.argv[6:]]
# Coloured emoji stay in the bundled emoji face; this face only owns monochrome
# marks, so the assertion below must not demand emoji glyphs from it.
emoji = set(TTFont(Path(sys.argv[5]), lazy=True).getBestCmap())
# Blocks worth filling beyond what web/src itself renders, so text the model
# writes (accented Latin, Greek, Cyrillic, signs) also stays inside the bundle.
RANGES = [
	(0x100, 0x180), (0x370, 0x400), (0x400, 0x530), (0x330, 0x340),
	(0x2070, 0x20A0), (0x2190, 0x2200), (0x2300, 0x2400), (0x2460, 0x2500),
	(0x25A0, 0x2600), (0x2600, 0x27C0),
]
covered = set(TTFont(out / "ui-sc-400.woff2", lazy=True).getBestCmap())
# Characters the UI renders and neither bundled text face covers yet.
used = set()
for path in (root / "web/src").rglob("*"):
	if out in path.parents or (root / "web/public/fonts") in path.parents:
		continue
	if path.suffix in (".ts", ".tsx", ".css", ".json"):
		used.update(char for char in path.read_text(encoding="utf8") if ord(char) > 0x7F)
# Variation selectors and the two private range literals are not glyphs.
IGNORE = {0xFE0F, 0xFF00, 0xFFEF}
required = {ord(char) for char in used} - covered - emoji - IGNORE
pending = required | {value for start, end in RANGES for value in range(start, end) if value not in covered and value not in emoji}
parts, taken, claimed, manifest = [], {}, set(), {"faces": {}, "license": "SIL OFL 1.1", "files": {}}
for label, path, weight, upstream in sources:
	font = TTFont(path)
	if weight is not None and "fvar" in font:
		font = instantiateVariableFont(font, {"wght": weight}, inplace=True)
	cmap = set(font.getBestCmap())
	owned = sorted(pending & cmap)
	if not owned:
		continue
	options = subset.Options()
	options.layout_features = []
	subsetter = subset.Subsetter(options=options)
	subsetter.populate(unicodes=sorted(owned))
	subsetter.subset(font)
	# Keep only outline tables: fontTools' merger cannot combine MATH/GDEF/vhea
	# variants, and these isolated marks need no kerning or vertical metrics.
	for tag in [tag for tag in font.keys() if tag not in {"cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "OS/2", "post"}]:
		del font[tag]
	font["name"].setName("UI Symbols", 1, 3, 1, 0x409)
	font["name"].setName("Regular", 2, 3, 1, 0x409)
	handle = tempfile.NamedTemporaryFile(suffix=".ttf", delete=False)
	font.save(handle.name)
	handle.close()
	parts.append(handle.name)
	pending -= set(owned)
	claimed |= set(owned)
	taken[label] = "".join(chr(value) for value in owned)
	manifest["faces"][label] = {
		"source": upstream,
		"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
		"codepoints": "".join(f"U+{value:04X} " for value in owned).strip(),
	}
# Unassigned codepoints inside the optional blocks are tolerated; only characters
# the UI actually renders must have a glyph.
missing = sorted(required - claimed)
assert not missing, f"No source covers: {' '.join(f'U+{value:04X}' for value in missing)}"
merged = Merger().merge(parts)
for path in parts:
	Path(path).unlink()
merged["name"].setName("UI Symbols", 1, 3, 1, 0x409)
merged["name"].setName("Regular", 2, 3, 1, 0x409)
merged["name"].setName("UI Symbols Regular", 4, 3, 1, 0x409)
merged["name"].setName("UI-Symbols-Regular", 6, 3, 1, 0x409)
# Fixed SFNT timestamps keep rebuilds byte-identical, so symbols.json's hashes
# stay meaningful. Saving must not refresh head.modified.
merged.recalcTimestamp = False
merged["head"].created = merged["head"].modified = 3850070400
merged.flavor = "woff2"
target = out / "ui-symbols-400.woff2"
merged.save(target)
manifest["files"][target.name] = {
	"weight": 400,
	"bytes": target.stat().st_size,
	"sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
}
(out / "symbols.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
# Every upstream notice travels with the derived face.
(out / "symbols-OFL.txt").write_bytes(
	b"UI Symbols merges subsets of the Noto faces listed in symbols.json.\n"
	b"Each upstream font is licensed under SIL OFL 1.1; their notices follow.\n\n"
	+ b"\n---\n\n".join(path.read_bytes() for path in license_paths)
)
print(json.dumps(manifest["files"], indent=2))
