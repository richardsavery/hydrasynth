# Portable recordings

This folder contains gzip-compressed JSONL recordings used by Hydra Signal Lab.
The dashboard reads them directly; do not decompress them before use.

The compressed copies keep a fresh macOS clone self-contained without adding
the roughly 95 MB raw dataset to Git. The dashboard also continues to accept
plain `.jsonl`, `.jsonl.txt`, and `.ndjson` files when an external recordings
folder is selected with `RECORDINGS_DIR` or `RAPP_RECORDINGS_DIR`.

Raw captures and `recordings/incoming/` are intentionally ignored. New portable
fixtures should be compressed before they are committed:

```sh
gzip -9 recording.jsonl
```

Dataset provenance: `RAPP-Realtime-Viz/viz_student_pack/recordings`.
