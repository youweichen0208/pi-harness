"""Rebuild UI SC: fonttools[woff]==4.60.2; supply the pinned Noto Sans SC variable TTF.
Source: notofonts/noto-cjk f8d157532fbfaeda587e826d4cd5b21a49186f7c
Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf; license: Sans/LICENSE (SIL OFL 1.1).
"""
import hashlib
import json
from pathlib import Path
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
# Preserve the v1.34.1 repertoire so previously system-rendered glyphs keep
# the same shapes. The manifest is also the input to rebuild this pinned set.
manifest = json.loads((out / "manifest.json").read_text(encoding="utf8"))
assert hashlib.sha256(source.read_bytes()).hexdigest() == manifest["sourceSha256"], "Unexpected upstream font"
characters = manifest["characters"]
manifest["files"] = {}
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
	assert path.stat().st_size <= 650 * 1024, "Subset exceeds the font byte budget"
	manifest["files"][path.name] = {"weight": weight, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
(out / "OFL.txt").write_bytes(license_path.read_bytes())
public.mkdir(parents=True, exist_ok=True)
(public / "OFL.txt").write_bytes(license_path.read_bytes())
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print(json.dumps(manifest["files"], indent=2))
