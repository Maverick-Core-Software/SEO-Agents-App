"""Copy VITE_SUPABASE_* into marketing-control/.env without printing values."""
from pathlib import Path

DEST = Path(__file__).resolve().parents[2] / "marketing-control" / ".env"
SOURCES = [
    Path(r"C:\Workspace\Active\MCC\.env"),
    Path(r"C:\Workspace\Active\SEO-Agents-App\.env"),
]
ALIASES = {
    "VITE_SUPABASE_URL": ("VITE_SUPABASE_URL", "SUPABASE_URL"),
    "VITE_SUPABASE_ANON_KEY": ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
}


def parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key:
            out[key] = val
    return out


def main() -> None:
    found: dict[str, tuple[str, str]] = {}
    used_sources: list[str] = []
    for src in SOURCES:
        parsed = parse_env(src)
        if not parsed:
            continue
        used_sources.append(src.name + (" (exists)" if src.is_file() else ""))
        for dest_key, aliases in ALIASES.items():
            if dest_key in found:
                continue
            for alias in aliases:
                val = parsed.get(alias, "")
                if val:
                    found[dest_key] = (alias, val)
                    break

    lines = [
        "# local only — gitignored. copied for Phase-1 live reads.",
        "VITE_SEO_STATUS_URL=http://127.0.0.1:8790/seo/status",
    ]
    for dest_key in ALIASES:
        pair = found.get(dest_key)
        lines.append(f"{dest_key}={pair[1] if pair else ''}")

    DEST.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"dest_exists={DEST.is_file()}")
    print(f"dest_bytes={DEST.stat().st_size}")
    print(f"keys_set={sorted(found)}")
    print(f"keys_missing={[k for k in ALIASES if k not in found]}")
    print(f"source_files_seen={ [str(p) for p in SOURCES if p.is_file()] }")
    for dest_key, pair in found.items():
        print(f"{dest_key}_from_alias={pair[0]} length={len(pair[1])}")


if __name__ == "__main__":
    main()
