"""Build the Playground's GB2312 and UI character subsets from Sarasa Mono SC 1.0.37."""
import hashlib
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1])
with source.open("rb") as file:
	if hashlib.file_digest(file, "sha256").hexdigest() != "c66ea03101e8615e3205dc383323f7a3c3100ef783f228b3d877d38ce84ff314":
		raise ValueError("Expected Sarasa-SuperTTC.ttc from v1.0.37")
characters = json.loads((root / "web/src/assets/fonts/manifest.json").read_text())["characters"]
# Keep CJK punctuation, kana, ideographs and full-width forms. Latin code and
# emoji must still reach JetBrains Mono and the platform's emoji font.
# GB2312 covers common Chinese comments beyond the interface's smaller subset.
gb2312 = b"".join(bytes((lead, trail)) for lead in range(0xB0, 0xF8) for trail in range(0xA1, 0xFF))
characters += gb2312.decode("gb2312", errors="ignore")
codepoints = {ord(ch) for ch in characters if 0x3000 <= ord(ch) <= 0x9FFF or 0xFF00 <= ord(ch) <= 0xFFEF}
output = root / "web/public/fonts/playground-cjk"
for index, style in [(205, "Regular"), (253, "Italic")]:
	font = TTFont(source, fontNumber=index, recalcTimestamp=False)
	assert font["name"].getDebugName(6) == "Sarasa-Mono-SC-" + style
	subsetter = subset.Subsetter()
	subsetter.populate(unicodes=codepoints)
	subsetter.subset(font)
	family = "PI Playground CJK"
	names = {1: family, 2: style, 3: family + "-" + style, 4: family + " " + style, 6: "PIPlaygroundCJK-" + style, 16: family, 17: style}
	for record in list(font["name"].names):
		if record.nameID in names:
			font["name"].setName(names[record.nameID], record.nameID, record.platformID, record.platEncID, record.langID)
	font.flavor = "woff2"
	font.save(output / ("playground-cjk-" + style.lower() + ".woff2"))
