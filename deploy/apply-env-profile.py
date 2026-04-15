#!/usr/bin/env python3
"""Merge and validate shared .env using a committed profile."""

from __future__ import annotations

import argparse
from pathlib import Path


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def merge_into_target(target: Path, required: dict[str, str], defaults: dict[str, str]) -> None:
    lines = []
    if target.exists():
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()

    positions: dict[str, int] = {}
    for idx, raw in enumerate(lines):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        content = line[7:].strip() if line.startswith("export ") else line
        if "=" not in content:
            continue
        key, _ = content.split("=", 1)
        positions[key.strip()] = idx

    def upsert(key: str, value: str) -> None:
        new_line = f"{key}={value}"
        pos = positions.get(key)
        if pos is None:
            positions[key] = len(lines)
            lines.append(new_line)
        else:
            lines[pos] = new_line

    for key, value in defaults.items():
        if key not in positions:
            upsert(key, value)
    for key, value in required.items():
        upsert(key, value)

    normalized = "\n".join(lines).rstrip() + "\n"
    target.write_text(normalized, encoding="utf-8")


def ensure_required(target: Path, required: dict[str, str]) -> None:
    current = parse_env_file(target)
    missing: list[str] = []
    wrong: list[str] = []
    for key, expected in required.items():
        if key not in current:
            missing.append(key)
        elif current[key] != expected:
            wrong.append(f"{key} (expected {expected}, got {current[key]})")
    if missing or wrong:
        details: list[str] = []
        if missing:
            details.append("missing: " + ", ".join(missing))
        if wrong:
            details.append("mismatch: " + ", ".join(wrong))
        raise SystemExit("env profile validation failed: " + " | ".join(details))


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply env profile to target .env")
    parser.add_argument("--target", required=True)
    parser.add_argument("--required", required=True)
    parser.add_argument("--defaults")
    args = parser.parse_args()

    target = Path(args.target)
    required_file = Path(args.required)
    defaults_file = Path(args.defaults) if args.defaults else None

    required = parse_env_file(required_file)
    defaults = parse_env_file(defaults_file) if defaults_file else {}
    if not required:
        raise SystemExit(f"required profile is empty: {required_file}")

    merge_into_target(target, required=required, defaults=defaults)
    ensure_required(target, required=required)
    print(f"env profile applied: {target}")


if __name__ == "__main__":
    main()
