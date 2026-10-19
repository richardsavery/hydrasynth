#!/usr/bin/env python3
"""Merge laptop study ZIPs or folders of backups, retaining exact events and media.

Example: python tools/study_merge.py collected-laptops --output study-analysis
Repeated exports are safe: UUIDs deduplicate identical events and conflicts fail.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sqlite3
import sys
import uuid
import zipfile

from study_recording import ANALYSIS_COLUMNS, MEDIA_COLUMNS, SCHEMA_VERSION, SESSION_COLUMNS, canonical, csv_chunks, event_csv_rows, media_csv_rows


MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_LINE_BYTES = 2 * 1024 * 1024


def safe_name(name):
    path = PurePosixPath(name)
    if not isinstance(name, str) or not name or "\\" in name or path.is_absolute() or ".." in path.parts or ":" in name or path.as_posix() != name:
        raise ValueError("Study export contains an unsafe file path.")
    return name


def read_json(archive, name, maximum=32 * 1024 * 1024):
    info = archive.getinfo(name)
    if info.file_size > maximum:
        raise ValueError("Study export metadata exceeds the size limit.")
    return json.loads(archive.read(name))


def json_lines(archive, name):
    with archive.open(name) as source:
        while line := source.readline(MAX_LINE_BYTES + 1):
            if len(line) > MAX_LINE_BYTES:
                raise ValueError("Study export contains an oversized JSONL record.")
            if line.strip():
                yield json.loads(line)


def valid_uuid(value):
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def atomic_chunks(path, chunks):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as output:
            for chunk in chunks:
                output.write(chunk)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def collect_export_paths(inputs):
    """Find complete ZIPs once, including nested device folders copied from USB."""
    exports = set()
    for raw_path in inputs:
        path = Path(raw_path).expanduser()
        if not path.exists():
            raise ValueError(f"Study input does not exist: {path}")
        if path.is_dir():
            # In-progress archives end in .tmp or .partial and must never be read.
            exports.update(candidate.resolve() for candidate in path.rglob("*.zip") if candidate.is_file())
        elif path.is_file() and path.suffix.lower() == ".zip":
            exports.add(path.resolve())
        else:
            raise ValueError(f"Study input must be a ZIP file or folder: {path}")
    if not exports:
        raise ValueError("No completed study ZIP files were found in the supplied folders.")
    return sorted(exports, key=lambda path: str(path))


def merge_exports(paths, output):
    output = Path(output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    media_dir = output / "media"
    media_dir.mkdir(exist_ok=True, mode=0o700)
    database = sqlite3.connect(output / "combined.sqlite3")
    database.row_factory = sqlite3.Row
    database.executescript("""
        CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
            session_id TEXT, occurred_at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_session ON events(device_id,session_id,occurred_at);
        CREATE TABLE IF NOT EXISTS sessions (device_id TEXT NOT NULL,session_id TEXT NOT NULL,
            participant_code TEXT,body TEXT NOT NULL, PRIMARY KEY(device_id,session_id));
        CREATE TABLE IF NOT EXISTS exports (export_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, manifest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS assets (export_id TEXT NOT NULL,device_id TEXT NOT NULL,
            source_path TEXT NOT NULL,sha256 TEXT NOT NULL,local_path TEXT NOT NULL,
            PRIMARY KEY(export_id,source_path));
        CREATE TABLE IF NOT EXISTS media (media_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,
            session_id TEXT NOT NULL,local_path TEXT,body TEXT NOT NULL);
    """)
    stats = {"new_events": 0, "duplicate_events": 0, "new_exports": 0}
    try:
        with database:
            for raw_path in paths:
                with zipfile.ZipFile(raw_path) as archive:
                    names = archive.namelist()
                    if len(names) != len(set(names)):
                        raise ValueError("Study export has duplicate file names.")
                    for name in names:
                        safe_name(name)
                    manifest = read_json(archive, "manifest.json")
                    if not isinstance(manifest, dict) or manifest.get("format") != "hydra-study" or manifest.get("schema_version") != SCHEMA_VERSION:
                        raise ValueError("Unsupported study export format.")
                    device_id, export_id = manifest.get("device_id"), manifest.get("export_id")
                    if not valid_uuid(device_id) or not isinstance(export_id, str) or len(export_id) > 100:
                        raise ValueError("Invalid study export identity.")
                    manifest_text = canonical(manifest)
                    previous_export = database.execute("SELECT manifest FROM exports WHERE export_id=?", (export_id,)).fetchone()
                    if previous_export and previous_export[0] != manifest_text:
                        raise ValueError("An export ID was reused with different content.")
                    file_entries = manifest.get("files", [])
                    if not isinstance(file_entries, list):
                        raise ValueError("Invalid export file inventory.")
                    inventory = {}
                    for item in file_entries:
                        name = safe_name(item["path"])
                        if name in inventory:
                            raise ValueError("Duplicate export inventory entry.")
                        inventory[name] = item
                    if set(inventory) != set(names) - {"manifest.json"} or not {"events.jsonl", "sessions.jsonl"}.issubset(inventory):
                        raise ValueError("Study export file inventory is incomplete.")
                    for name, item in inventory.items():
                        info = archive.getinfo(name)
                        if info.file_size != item.get("bytes") or (name.startswith(("media/", "assets/")) and info.file_size > MAX_MEMBER_BYTES):
                            raise ValueError("Study export has an invalid or oversized file.")
                        hasher = hashlib.sha256()
                        is_asset = name.startswith(("media/", "assets/"))
                        temporary = media_dir / (".import-" + uuid.uuid4().hex) if is_asset else None
                        target = temporary.open("xb") if temporary else None
                        try:
                            with archive.open(name) as source:
                                while block := source.read(1024 * 1024):
                                    hasher.update(block)
                                    if target:
                                        target.write(block)
                            if target:
                                target.close()
                            checksum = hasher.hexdigest()
                            if checksum != item.get("sha256"):
                                raise ValueError("Study export file checksum does not match its manifest.")
                            if temporary:
                                suffix = PurePosixPath(name).suffix.lower()
                                destination = media_dir / (checksum + suffix)
                                if destination.exists():
                                    with destination.open("rb") as existing:
                                        existing_hash = hashlib.file_digest(existing, "sha256").hexdigest()
                                    if existing_hash != checksum:
                                        raise ValueError("An existing collected media file has changed.")
                                else:
                                    temporary.replace(destination)
                                database.execute("INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?)", (export_id, device_id, name, checksum, destination.relative_to(output).as_posix()))
                        finally:
                            if target and not target.closed:
                                target.close()
                            if temporary:
                                temporary.unlink(missing_ok=True)
                    event_count = 0
                    for event in json_lines(archive, "events.jsonl"):
                        if not isinstance(event, dict) or not valid_uuid(event.get("event_id")) or event.get("device_id") != device_id or not isinstance(event.get("payload"), dict):
                            raise ValueError("Invalid event identity or payload in study export.")
                        event_count += 1
                        body = canonical(event)
                        previous = database.execute("SELECT body FROM events WHERE event_id=?", (event["event_id"],)).fetchone()
                        if previous:
                            if previous[0] != body:
                                raise ValueError("An event UUID has conflicting content across study exports.")
                            stats["duplicate_events"] += 1
                            continue
                        database.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", (event["event_id"], device_id, event.get("session_id"), event["occurred_at"], event["type"], body))
                        stats["new_events"] += 1
                    if event_count != manifest.get("event_count"):
                        raise ValueError("Study export event count does not match its manifest.")
                    session_count = 0
                    for session in json_lines(archive, "sessions.jsonl"):
                        if not isinstance(session, dict) or session.get("device_id") != device_id or not isinstance(session.get("session_id"), str):
                            raise ValueError("Invalid session in study export.")
                        session_count += 1
                        previous = database.execute("SELECT body FROM sessions WHERE device_id=? AND session_id=?", (device_id, session["session_id"])).fetchone()
                        if previous:
                            old = json.loads(previous[0])
                            if old.get("participant_code") is not None and session.get("participant_code") is not None and old["participant_code"] != session["participant_code"]:
                                raise ValueError("A session has conflicting participant codes.")
                            if old.get("participant_code") and not session.get("participant_code"):
                                session = old
                        database.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)", (device_id, session["session_id"], session.get("participant_code"), canonical(session)))
                    if session_count != manifest.get("session_count"):
                        raise ValueError("Study export session count does not match its manifest.")
                    media_records = json_lines(archive, "media.jsonl") if "media.jsonl" in inventory else iter(manifest.get("media", []))
                    for item in media_records:
                        if not isinstance(item, dict) or not valid_uuid(item.get("media_id")) or item.get("device_id") != device_id:
                            raise ValueError("Invalid media identity in study export.")
                        source_path = safe_name(item["path"])
                        local = database.execute("SELECT local_path,sha256 FROM assets WHERE export_id=? AND source_path=?", (export_id, source_path)).fetchone()
                        if local and local["sha256"] != item.get("sha256"):
                            raise ValueError("Media metadata checksum does not match the collected file.")
                        body = canonical(item)
                        previous = database.execute("SELECT body FROM media WHERE media_id=?", (item["media_id"],)).fetchone()
                        if previous and previous[0] != body:
                            raise ValueError("A media UUID has conflicting content across study exports.")
                        if previous:
                            if local:
                                database.execute("UPDATE media SET local_path=? WHERE media_id=?", (local["local_path"], item["media_id"]))
                        else:
                            database.execute("INSERT INTO media VALUES (?,?,?,?,?)", (item["media_id"], device_id, item["session_id"], local["local_path"] if local else None, body))
                    database.execute("INSERT OR IGNORE INTO exports VALUES (?,?,?)", (export_id, device_id, manifest_text))
                    if not previous_export:
                        stats["new_exports"] += 1
        events = lambda: (json.loads(row[0]) for row in database.execute("SELECT body FROM events ORDER BY occurred_at,device_id,event_id"))
        sessions = (json.loads(row[0]) for row in database.execute("SELECT body FROM sessions ORDER BY device_id,session_id"))
        assets = (dict(row) for row in database.execute("SELECT * FROM assets ORDER BY device_id,source_path,export_id"))
        media_records = ({**json.loads(row["body"]), "local_path": row["local_path"]}
                         for row in database.execute("SELECT body,local_path FROM media ORDER BY device_id,session_id,media_id"))
        atomic_chunks(output / "events.jsonl", ((canonical(event) + "\n").encode("utf-8") for event in events()))
        atomic_chunks(output / "events.csv", csv_chunks(event_csv_rows(events()), ANALYSIS_COLUMNS))
        atomic_chunks(output / "sessions.csv", csv_chunks(sessions, SESSION_COLUMNS))
        atomic_chunks(output / "assets.csv", csv_chunks(assets, ["export_id", "device_id", "source_path", "sha256", "local_path"]))
        atomic_chunks(output / "media.csv", csv_chunks(media_csv_rows(media_records), MEDIA_COLUMNS + ["local_path"]))
        stats.update(total_events=database.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                     total_sessions=database.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], output=str(output))
        return stats
    finally:
        database.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exports", nargs="+", type=Path, help="Study ZIP files or folders to search recursively; unfinished .tmp/.partial files are ignored")
    parser.add_argument("--output", required=True, type=Path, help="Folder for combined.sqlite3, CSVs and collected media")
    args = parser.parse_args(argv)
    try:
        result = merge_exports(collect_export_paths(args.exports), args.output)
    except (OSError, ValueError, KeyError, sqlite3.Error, zipfile.BadZipFile) as error:
        print("Study merge failed: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
