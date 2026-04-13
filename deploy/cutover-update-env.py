#!/usr/bin/env python3
"""Replace DATABASE_URL in a shared .env (used by cutover-to-remote-db.sh)."""
import os
import pathlib
import urllib.parse

if "PW_FILE" in os.environ:
    pw = pathlib.Path(os.environ["PW_FILE"]).read_text().rstrip("\n")
else:
    pw = os.environ["PW"]
dbip = os.environ["DB_PRIVATE_IP"]
path = pathlib.Path(os.environ["ENV_FILE"])
url = f"postgres://chatapp:{urllib.parse.quote(pw, safe='')}@{dbip}:5432/chatapp_prod"
text = path.read_text()
out = []
found = False
for line in text.splitlines(keepends=True):
    if line.startswith("DATABASE_URL="):
        out.append("DATABASE_URL=" + url + "\n")
        found = True
    else:
        out.append(line)
if not found:
    out.append("DATABASE_URL=" + url + "\n")
path.write_text("".join(out))
print("Updated DATABASE_URL host ->", dbip)
