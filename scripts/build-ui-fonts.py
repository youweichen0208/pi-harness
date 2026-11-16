"""Rebuild UI SC: fonttools[woff]==4.60.2; supply the pinned Noto Sans SC variable TTF.
Source: notofonts/noto-cjk f8d157532fbfaeda587e826d4cd5b21a49186f7c
Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf; license: Sans/LICENSE (SIL OFL 1.1).
"""
import hashlib
import json
from pathlib import Path
import re
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

root = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1])
license_path = Path(sys.argv[2])
out = root / "web/src/assets/fonts"
out.mkdir(parents=True, exist_ok=True)
public = root / "web/public/fonts/ui-sc"
# 2026-01-01T00:00:00Z in SFNT seconds (since 1904): a stable, plausible stamp.
FIXED_TIMESTAMP = 3850070400
characters = set()
# GB2312 level one and level two: every Han character in the Chinese input
# charset, so model output does not fall back to the local system CJK face.
for first in range(0xB0, 0xF8):
	for second in range(0xA1, 0xFF):
		try:
			characters.add(bytes([first, second]).decode("gb2312"))
		except UnicodeDecodeError:
			pass
assert len(characters) == 6763
# The generated manifest lists this very character set; never read the font
# directory back in or the subset grows on every run.
def sources():
	for path in (root / "web/src").rglob("*"):
		if out in path.parents or public in path.parents:
			continue
		if path.suffix in (".ts", ".tsx", ".css", ".json"):
			yield path
for path in sources():
	characters.update(re.findall(r"[\u3400-\u9fff]", path.read_text(encoding="utf8")))
# Symbols the UI renders in prose and chrome. Without them each OS picks its own
# system fallback (SF/Helvetica vs Segoe UI), which is the remaining visible
# cross-platform typography difference.
for start, end in [
	(0x20, 0x7F), (0xA0, 0x100), (0x370, 0x400), (0x400, 0x500), (0x2000, 0x2070),
	(0x2070, 0x20A0), (0x20A0, 0x20C0), (0x2100, 0x2150), (0x2150, 0x2190),
	(0x2190, 0x2200), (0x2200, 0x2300), (0x2300, 0x2400), (0x2460, 0x2500),
	(0x2500, 0x25A0), (0x25A0, 0x2600), (0x2600, 0x2700), (0x2700, 0x27C0),
	(0x3000, 0x3040), (0x3040, 0x3100), (0xFE10, 0xFE20), (0xFE30, 0xFE50),
	(0xFF00, 0xFFF0),
]:
	characters.update(chr(value) for value in range(start, end))
# Anything the source actually renders, including characters outside the ranges above.
for path in sources():
	characters.update(char for char in path.read_text(encoding="utf8") if ord(char) > 0x7F)
# The subsetter drops codepoints this face has no outline for, so record what the
# shipped files actually cover instead of what was requested.
instanced = instantiateVariableFont(TTFont(source), {"wght": 400}, inplace=True)
characters &= {chr(value) for value in instanced.getBestCmap()}
manifest = {"source": "https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf", "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "fonttools": "4.60.2", "characters": "".join(sorted(characters)), "files": {}}
for weight, style in [(400, "Regular"), (500, "Medium"), (600, "SemiBold")]:
	font = instantiateVariableFont(TTFont(source), {"wght": weight}, inplace=True)
	options = subset.Options()
	options.flavor = "woff2"
	options.layout_features = ["*"]
	subsetter = subset.Subsetter(options=options)
	subsetter.populate(unicodes=sorted(ord(char) for char in characters))
	subsetter.subset(font)
	for name_id, value in {1: "UI SC", 2: style, 4: f"UI SC {style}", 6: f"UI-SC-{style}", 16: "UI SC", 17: style}.items():
		font["name"].setName(value, name_id, 3, 1, 0x409)
	# Fixed SFNT timestamps keep rebuilds byte-identical, so the hashes recorded in
	# manifest.json stay meaningful. Saving must not refresh head.modified.
	font.recalcTimestamp = False
	font["head"].created = font["head"].modified = FIXED_TIMESTAMP
	font.flavor = "woff2"
	path = out / f"ui-sc-{weight}.woff2"
	font.save(path)
	assert path.stat().st_size <= 2048 * 1024, "Subset exceeds the font byte budget"
	manifest["files"][path.name] = {"weight": weight, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
(out / "OFL.txt").write_bytes(license_path.read_bytes())
public.mkdir(parents=True, exist_ok=True)
(public / "OFL.txt").write_bytes(license_path.read_bytes())
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print(json.dumps(manifest["files"], indent=2))
