"""Build the offline, unpacked extension download from the reviewed source files."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
files = ("manifest.json", "activity.js", "worker.js", "options.html", "options.js")
with ZipFile(root / "frontend/public/focusdesk-chatgpt.zip", "w") as output:
    for name in files:
        info = ZipInfo(name)
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        info.create_system = 3
        output.writestr(info, (root / "extensions/chatgpt-activity" / name).read_bytes())
