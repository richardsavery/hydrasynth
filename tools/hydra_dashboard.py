#!/usr/bin/env python3
"""Local telemetry and sonification dashboards with a Unix command broker."""

from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass, field
import ipaddress
import json
import math
import mimetypes
import os
from pathlib import Path
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from recording_library import RecordingLibrary, default_recordings_directory


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DASHBOARD_DIR = PROJECT_ROOT / "dashboard"
CATALOG_PATH = PROJECT_ROOT / "data" / "hydrasynth_parameters.json"
DEFAULT_HYDRACTL = PROJECT_ROOT / "build" / "hydractl"
EVENT_HISTORY_LIMIT = 80
STDERR_HISTORY_LIMIT = 16
LOGICAL_NRPN_LIMIT = 512
PENDING_REQUEST_LIMIT = 16
REQUEST_TIMEOUT_SECONDS = 5.0
SERVICE_READY_TIMEOUT_SECONDS = 8.0
NRPN_TRANSPORT_CCS = {6, 38, 96, 97, 98, 99}
BROKER_REQUEST_LIMIT = 16 * 1024
BROKER_RESPONSE_LIMIT = 2 * 1024 * 1024
BROKER_CONNECTION_LIMIT = 8
HYDRACTL_JSON_LINE_LIMIT = 16 * 1024
DEFAULT_BROKER_SOCKET = Path(f"/tmp/hydrasynth-dashboard-{os.getuid()}.sock")
DEFAULT_BROKER_TOKEN = Path(f"/tmp/hydrasynth-dashboard-{os.getuid()}.token")
BROKER_READ_ONLY_OPERATIONS = {"ping", "status", "capabilities", "state"}
SIGNAL_LAB_REQUEST_LIMIT = 64 * 1024
SIGNAL_LAB_ACTIVE_SECONDS = 2.5
SIGNAL_LAB_CC_LIMIT = 64

DEMO_CONTROLS = (
    ("osc1-level", 44),
    ("osc2-level", 46),
    ("osc3-level", 48),
    ("noise-level", 3),
    ("ringmod-level", 9),
    ("filter1-cutoff", 74),
    ("filter1-resonance", 71),
    ("filter1-drive", 50),
    ("filter2-cutoff", 55),
    ("filter2-resonance", 56),
    ("env-attack", 81),
    ("env-decay", 82),
    ("env-sustain", 83),
    ("env-release", 84),
    ("delay-feedback", 14),
    ("delay-time", 15),
    ("delay-mix", 92),
    ("reverb-time", 65),
    ("reverb-tone", 67),
    ("reverb-mix", 91),
    ("macro1", 16),
    ("macro2", 17),
    ("macro3", 18),
    ("macro4", 19),
    ("macro5", 20),
    ("macro6", 21),
    ("macro7", 22),
    ("macro8", 23),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def integer(value: Any) -> int | None:
    number = finite_number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def response_payload(message: dict[str, Any]) -> dict[str, Any]:
    return {
        key: copy.deepcopy(value)
        for key, value in message.items()
        if key not in {"v", "type", "id", "ok"}
    }


def preferred_control_name(names: list[str], number: int) -> str:
    if not names:
        return f"CC {number}"
    unique = sorted(set(names))
    return max(
        unique,
        key=lambda name: (
            name.startswith(("filter1-", "filter2-", "osc")),
            len(name),
            name,
        ),
    )


class ParameterCatalog:
    def __init__(self, document: dict[str, Any]) -> None:
        self.document = document
        self.cc_by_number: dict[int, dict[str, Any]] = {}
        self.nrpn_by_number: dict[int, list[dict[str, Any]]] = {}
        for entry in document.get("cc_parameters", []):
            if not isinstance(entry, dict):
                continue
            number = integer(entry.get("number"))
            if number is not None and 0 <= number <= 127:
                self.cc_by_number[number] = entry
        for entry in document.get("nrpn_parameters", []):
            if not isinstance(entry, dict):
                continue
            address = entry.get("address")
            number = integer(address.get("number")) if isinstance(address, dict) else None
            if number is not None and 0 <= number <= 16383:
                self.nrpn_by_number.setdefault(number, []).append(entry)

    @classmethod
    def load(cls, path: Path = CATALOG_PATH) -> "ParameterCatalog":
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or document.get("schema_version") != 1:
            raise ValueError(f"unsupported parameter catalog: {path}")
        return cls(document)

    def summary(self) -> dict[str, Any]:
        specification = self.document.get("specification", {})
        compatibility = self.document.get("compatibility", {})
        return {
            "available": True,
            "endpoint": "/api/catalog",
            "schema_version": self.document.get("schema_version"),
            "catalog_version": self.document.get("catalog_version"),
            "counts": copy.deepcopy(self.document.get("counts", {})),
            "document_version": (
                specification.get("document_version")
                if isinstance(specification, dict)
                else None
            ),
            "firmware_version": (
                specification.get("firmware_version")
                if isinstance(specification, dict)
                else None
            ),
            "compatibility": copy.deepcopy(compatibility),
        }

    def _entry_range(
        self, entry: dict[str, Any], fallback_bits: int
    ) -> tuple[int, int, bool]:
        value_spec = entry.get("value")
        if not isinstance(value_spec, dict):
            return 0, (1 << fallback_bits) - 1, False
        minimum = integer(value_spec.get("raw_min"))
        maximum = integer(value_spec.get("raw_max"))
        if minimum is not None and maximum is not None and maximum > minimum:
            return minimum, maximum, True
        items = value_spec.get("items")
        if value_spec.get("kind") == "enum_reference":
            rhythm_lists = self.document.get("rhythm_lists")
            enum_name = value_spec.get("enum")
            enum_spec = (
                rhythm_lists.get(enum_name)
                if isinstance(rhythm_lists, dict) and isinstance(enum_name, str)
                else None
            )
            items = enum_spec.get("items") if isinstance(enum_spec, dict) else None
        item_values = [
            value
            for value in (
                integer(item.get("value"))
                for item in items if isinstance(item, dict)
            )
            if value is not None
        ] if isinstance(items, list) else []
        if item_values and max(item_values) > min(item_values):
            return min(item_values), max(item_values), True
        return 0, (1 << fallback_bits) - 1, False

    def _display_value(
        self, entry: dict[str, Any], value: int
    ) -> tuple[Any, str | None, dict[str, Any]]:
        value_spec = entry.get("value")
        if not isinstance(value_spec, dict):
            return value, None, {}
        kind = value_spec.get("kind")
        metadata: dict[str, Any] = {}

        if kind == "context_dependent":
            dependency = value_spec.get("dependency")
            if isinstance(dependency, str):
                metadata["dependency"] = dependency
            metadata["context_dependent"] = True
            return None, None, metadata

        items = value_spec.get("items")
        if kind == "enum_reference":
            enum_name = value_spec.get("enum")
            rhythm_lists = self.document.get("rhythm_lists")
            enum_spec = (
                rhythm_lists.get(enum_name)
                if isinstance(rhythm_lists, dict) and isinstance(enum_name, str)
                else None
            )
            items = enum_spec.get("items") if isinstance(enum_spec, dict) else None
            if isinstance(enum_name, str):
                metadata["enum"] = enum_name
        if isinstance(items, list):
            for item in items:
                if (
                    isinstance(item, dict)
                    and integer(item.get("value")) == value
                    and isinstance(item.get("label"), str)
                ):
                    return item["label"], item["label"], metadata
            metadata["display_unmapped"] = True
            return value, None, metadata

        if kind == "bipolar":
            raw_min = finite_number(value_spec.get("raw_min"))
            raw_center = finite_number(value_spec.get("raw_center"))
            raw_max = finite_number(value_spec.get("raw_max"))
            display_min = finite_number(value_spec.get("display_min"))
            display_center = finite_number(value_spec.get("display_center"))
            display_max = finite_number(value_spec.get("display_max"))
            if None not in {
                raw_min,
                raw_center,
                raw_max,
                display_min,
                display_center,
                display_max,
            }:
                if value <= raw_center and raw_center > raw_min:
                    fraction = (value - raw_min) / (raw_center - raw_min)
                    display = display_min + fraction * (display_center - display_min)
                elif raw_max > raw_center:
                    fraction = (value - raw_center) / (raw_max - raw_center)
                    display = display_center + fraction * (display_max - display_center)
                else:
                    display = display_center
                rounded = round(display)
                return (
                    int(rounded) if abs(display - rounded) < 1e-9 else display,
                    None,
                    metadata,
                )

        if kind == "signed_wrap":
            pivot = integer(value_spec.get("pivot"))
            subtract = integer(value_spec.get("subtract_above_pivot"))
            if pivot is not None and subtract is not None:
                return value - subtract if value > pivot else value, None, metadata

        if kind == "curve":
            anchors = [
                anchor
                for anchor in value_spec.get("anchors", [])
                if (
                    isinstance(anchor, dict)
                    and finite_number(anchor.get("raw")) is not None
                    and finite_number(anchor.get("display")) is not None
                )
            ]
            anchors.sort(key=lambda anchor: float(anchor["raw"]))
            for anchor in anchors:
                if value == integer(anchor.get("raw")):
                    display = anchor["display"]
                    label = (
                        anchor.get("label")
                        if isinstance(anchor.get("label"), str)
                        else None
                    )
                    return display, label, metadata
            for lower, upper in zip(anchors, anchors[1:]):
                lower_raw = float(lower["raw"])
                upper_raw = float(upper["raw"])
                if lower_raw <= value <= upper_raw and upper_raw > lower_raw:
                    fraction = (value - lower_raw) / (upper_raw - lower_raw)
                    display = float(lower["display"]) + fraction * (
                        float(upper["display"]) - float(lower["display"])
                    )
                    rounded = round(display)
                    return (
                        int(rounded) if abs(display - rounded) < 1e-9 else display,
                        None,
                        metadata,
                    )

        display_encoding = value_spec.get("display_encoding")
        if (
            isinstance(display_encoding, dict)
            and display_encoding.get("kind") == "signed_7bit"
        ):
            threshold = integer(display_encoding.get("subtract_if_above"))
            subtract = integer(display_encoding.get("subtract"))
            if threshold is not None and subtract is not None:
                return value - subtract if value > threshold else value, None, metadata

        return value, None, metadata

    def _decoded_entry(
        self,
        entry: dict[str, Any],
        *,
        channel: int,
        number: int,
        raw_value: int,
        decoded_value: int,
        source: str,
        age: float | None,
        raw_resolution_bits: int,
        encoding: dict[str, Any],
    ) -> dict[str, Any]:
        value_spec = entry.get("value")
        value_spec = value_spec if isinstance(value_spec, dict) else {}
        resolution_bits = integer(value_spec.get("resolution_bits"))
        if resolution_bits is None or not 1 <= resolution_bits <= 14:
            resolution_bits = raw_resolution_bits
        minimum, maximum, range_authoritative = self._entry_range(
            entry, resolution_bits
        )
        if value_spec.get("kind") == "packed_index":
            segments = [
                segment
                for segment in value_spec.get("segments", [])
                if (
                    isinstance(segment, dict)
                    and integer(segment.get("offset")) is not None
                )
            ]
            if segments:
                minimum = min(int(segment["offset"]) for segment in segments)
                maximum = max(int(segment["offset"]) + 127 for segment in segments)
                range_authoritative = True
        denominator = maximum - minimum
        normalized = (
            max(0.0, min(1.0, (decoded_value - minimum) / denominator))
            if range_authoritative and denominator > 0
            else None
        )
        display_value, display_label, display_metadata = self._display_value(
            entry, decoded_value
        )
        catalog_id = entry.get("id")
        record = {
            "key": f"nrpn:{channel}:{number}:{catalog_id}",
            "kind": "nrpn",
            "channel": channel,
            "parameter": number,
            "number": number,
            "name": entry.get("name", f"NRPN {number}"),
            "aliases": [entry["name"]] if isinstance(entry.get("name"), str) else [],
            "group": entry.get("group", "NRPN"),
            "value": decoded_value,
            "raw_value": raw_value,
            "min": minimum,
            "max": maximum,
            "normalized": normalized,
            "resolution_bits": resolution_bits,
            "raw_resolution_bits": raw_resolution_bits,
            "source": source,
            "age": age,
            "catalog_id": catalog_id,
            "catalog_ids": [catalog_id] if isinstance(catalog_id, str) else [],
            "catalog_ambiguous": False,
            "decode_status": "decoded",
            "value_kind": value_spec.get("kind", "raw"),
            "encoding": encoding,
            "range_authoritative": range_authoritative,
            "display_value": display_value,
        }
        if display_label is not None:
            record["display_label"] = display_label
        record.update(display_metadata)
        return record

    def decode_nrpn(
        self,
        *,
        channel: int,
        number: int,
        raw_value: int,
        source: str,
        age: float | None,
        resolution_bits: int,
    ) -> list[dict[str, Any]]:
        entries = self.nrpn_by_number.get(number, [])
        if not entries:
            natural_value = raw_value >> 7 if resolution_bits == 7 else raw_value
            natural_maximum = 127 if resolution_bits == 7 else 16383
            return [
                {
                    "key": f"nrpn:{channel}:{number}:unmapped",
                    "kind": "nrpn",
                    "channel": channel,
                    "parameter": number,
                    "number": number,
                    "name": f"Unmapped NRPN {number}",
                    "aliases": [],
                    "group": "NRPN",
                    "value": natural_value,
                    "raw_value": raw_value,
                    "min": 0,
                    "max": natural_maximum,
                    "normalized": natural_value / natural_maximum,
                    "resolution_bits": resolution_bits,
                    "raw_resolution_bits": resolution_bits,
                    "source": source,
                    "age": age,
                    "catalog_ids": [],
                    "catalog_ambiguous": False,
                    "decode_status": "unmapped_address",
                    "value_kind": "raw",
                    "encoding": {"kind": "raw_14bit"},
                    "range_authoritative": False,
                    "display_value": natural_value,
                }
            ]
        kinds = {
            entry.get("value", {}).get("kind")
            for entry in entries
            if isinstance(entry.get("value"), dict)
        }
        if (
            resolution_bits == 7
            and kinds.intersection({"selected_byte", "packed_index"})
        ):
            # These encodings split a discriminator and payload across the two
            # Data Entry bytes. The service emits the MSB as an interim 7-bit
            # event, which is not yet a meaningful logical catalog value.
            return []
        selector = raw_value >> 7
        payload = raw_value & 0x7F
        matches: list[dict[str, Any]]
        decoded_value = raw_value
        encoding: dict[str, Any] = {"kind": "raw_14bit"}

        if kinds == {"selected_byte"}:
            matches = [
                entry
                for entry in entries
                if selector
                in [
                    value
                    for value in (
                        integer(candidate)
                        for candidate in entry.get("value", {}).get(
                            "selector_values", []
                        )
                    )
                    if value is not None
                ]
            ]
            decoded_value = payload
            encoding = {
                "kind": "selected_byte",
                "selector": selector,
                "payload": payload,
            }
        elif kinds == {"packed_index"}:
            matches = []
            decoded_by_id: dict[str, int] = {}
            for entry in entries:
                value_spec = entry.get("value", {})
                for segment in value_spec.get("segments", []):
                    if (
                        isinstance(segment, dict)
                        and integer(segment.get("prefix")) == selector
                        and integer(segment.get("offset")) is not None
                    ):
                        matches.append(entry)
                        entry_id = entry.get("id")
                        if isinstance(entry_id, str):
                            decoded_by_id[entry_id] = int(segment["offset"]) + payload
                        break
            if len(matches) == 1 and isinstance(matches[0].get("id"), str):
                decoded_value = decoded_by_id[matches[0]["id"]]
            encoding = {
                "kind": "packed_index",
                "prefix": selector,
                "payload": payload,
            }
        else:
            matches = entries

        if len(matches) == 1:
            return [
                self._decoded_entry(
                    matches[0],
                    channel=channel,
                    number=number,
                    raw_value=raw_value,
                    decoded_value=decoded_value,
                    source=source,
                    age=age,
                    raw_resolution_bits=resolution_bits,
                    encoding=encoding,
                )
            ]

        candidate_ids = [
            entry["id"]
            for entry in matches
            if isinstance(entry.get("id"), str)
        ]
        candidate_names = [
            entry["name"]
            for entry in matches
            if isinstance(entry.get("name"), str)
        ]
        discriminator = (
            f"selector:{selector}"
            if kinds == {"selected_byte"}
            else f"prefix:{selector}" if kinds == {"packed_index"} else "address"
        )
        ambiguous = len(matches) > 1
        return [
            {
                "key": f"nrpn:{channel}:{number}:{discriminator}:"
                f"{'ambiguous' if ambiguous else 'unmapped'}",
                "kind": "nrpn",
                "channel": channel,
                "parameter": number,
                "number": number,
                "name": (
                    f"Ambiguous NRPN {number} {discriminator.replace(':', ' ')}"
                    if ambiguous
                    else f"Unmapped NRPN {number} {discriminator.replace(':', ' ')}"
                ),
                "aliases": [],
                "group": "NRPN",
                "value": decoded_value,
                "raw_value": raw_value,
                "min": 0,
                "max": 127 if kinds <= {"selected_byte", "packed_index"} else 16383,
                "normalized": (
                    decoded_value / 127.0
                    if kinds <= {"selected_byte", "packed_index"}
                    else raw_value / 16383.0
                ),
                "resolution_bits": 7 if kinds == {"selected_byte"} else resolution_bits,
                "raw_resolution_bits": resolution_bits,
                "source": source,
                "age": age,
                "catalog_ids": candidate_ids,
                "catalog_ambiguous": ambiguous,
                "decode_status": (
                    "ambiguous_discriminator" if ambiguous else "unmapped_discriminator"
                ),
                "value_kind": next(iter(kinds), "raw"),
                "encoding": encoding,
                "range_authoritative": False,
                "display_value": decoded_value,
                "candidate_names": candidate_names,
            }
        ]


def build_parameters(
    state: dict[str, Any],
    capabilities: dict[str, Any],
    catalog: ParameterCatalog | None = None,
) -> list[dict[str, Any]]:
    names_by_cc: dict[int, list[str]] = {}
    for control in capabilities.get("timbre_controls", []):
        if not isinstance(control, dict):
            continue
        number = integer(control.get("number", control.get("cc")))
        name = control.get("name")
        if (
            number is None
            or not 0 <= number <= 127
            or not isinstance(name, str)
            or not name
        ):
            continue
        names_by_cc.setdefault(number, []).append(name)

    takeover = finite_number(state.get("takeover_seconds")) or 0.0
    parameters: list[dict[str, Any]] = []
    for item in state.get("cc", []):
        if not isinstance(item, dict):
            continue
        channel = integer(item.get("channel"))
        number = integer(item.get("number", item.get("cc")))
        value = integer(item.get("value"))
        if (
            channel is None
            or number is None
            or value is None
            or not 1 <= channel <= 16
            or not 0 <= number <= 127
            or not 0 <= value <= 127
        ):
            continue
        age = finite_number(item.get("age"))
        source = item.get("source") if isinstance(item.get("source"), str) else "unknown"
        names = names_by_cc.get(number, [])
        catalog_entry = catalog.cc_by_number.get(number) if catalog else None
        catalog_name = (
            catalog_entry.get("name")
            if isinstance(catalog_entry, dict)
            and isinstance(catalog_entry.get("name"), str)
            else None
        )
        catalog_group = (
            catalog_entry.get("group")
            if isinstance(catalog_entry, dict)
            and isinstance(catalog_entry.get("group"), str)
            else None
        )
        if catalog_name:
            names = [catalog_name, *names]
        parameter = {
            "key": f"cc:{channel}:{number}",
            "kind": "cc",
            "channel": channel,
            "number": number,
            "name": preferred_control_name(names, number),
            "aliases": sorted(set(names)),
            "group": catalog_group,
            "value": value,
            "max": 127,
            "normalized": value / 127.0,
            "source": source,
            "age": max(0.0, age) if age is not None else None,
            "transport": number in NRPN_TRANSPORT_CCS,
        }
        reported_takeover = finite_number(item.get("takeover_remaining"))
        if reported_takeover is not None:
            parameter["takeover_remaining"] = max(0.0, reported_takeover)
        elif source == "user" and age is not None:
            parameter["takeover_remaining"] = max(0.0, takeover - age)
        parameters.append(parameter)

    nrpn_items = state.get("nrpn_logical")
    if not isinstance(nrpn_items, list):
        nrpn_items = []
        for raw_item in state.get("nrpn", []):
            if not isinstance(raw_item, dict):
                continue
            channel = integer(raw_item.get("channel"))
            number = integer(raw_item.get("parameter", raw_item.get("number")))
            value = integer(raw_item.get("value"))
            bits = integer(raw_item.get("resolution_bits")) or 14
            source = (
                raw_item.get("source")
                if isinstance(raw_item.get("source"), str)
                else "unknown"
            )
            age = finite_number(raw_item.get("age"))
            decoded = (
                catalog.decode_nrpn(
                    channel=channel,
                    number=number,
                    raw_value=value,
                    source=source,
                    age=age,
                    resolution_bits=bits,
                )
                if (
                    catalog is not None
                    and channel is not None
                    and number is not None
                    and value is not None
                    and 1 <= channel <= 16
                    and 0 <= number <= 16383
                    and 0 <= value <= 16383
                    and bits in {7, 14}
                )
                else []
            )
            nrpn_items.extend(decoded or [raw_item])

    for item in nrpn_items:
        if not isinstance(item, dict):
            continue
        channel = integer(item.get("channel"))
        number = integer(item.get("parameter", item.get("number")))
        value = integer(item.get("value"))
        bits = integer(item.get("resolution_bits")) or 14
        if (
            channel is None
            or number is None
            or value is None
            or not 1 <= channel <= 16
            or not 0 <= number <= 16383
            or not 0 <= value <= 16383
            or not 1 <= bits <= 14
        ):
            continue
        age = finite_number(item.get("age"))
        source = item.get("source") if isinstance(item.get("source"), str) else "unknown"
        catalog_entries = catalog.nrpn_by_number.get(number, []) if catalog else []
        catalog_names = [
            entry["name"]
            for entry in catalog_entries
            if isinstance(entry.get("name"), str)
        ]
        catalog_groups = sorted(
            {
                entry["group"]
                for entry in catalog_entries
                if isinstance(entry.get("group"), str)
            }
        )
        catalog_maxima = [
            integer(entry.get("value", {}).get("raw_max"))
            for entry in catalog_entries
            if isinstance(entry.get("value"), dict)
        ]
        catalog_maxima = [
            maximum
            for maximum in catalog_maxima
            if maximum is not None and maximum > 0
        ]
        supplied_max = integer(item.get("max"))
        display_max = (
            supplied_max
            if supplied_max is not None and supplied_max > 0
            else max(catalog_maxima) if catalog_maxima else 16383
        )
        supplied_min = integer(item.get("min"))
        display_min = supplied_min if supplied_min is not None else 0
        supplied_normalized = finite_number(item.get("normalized"))
        denominator = display_max - display_min
        normalized = (
            supplied_normalized
            if supplied_normalized is not None
            else (
                (value - display_min) / denominator
                if denominator > 0
                else 0.0
            )
        )
        supplied_name = (
            item.get("name") if isinstance(item.get("name"), str) else None
        )
        supplied_aliases = [
            alias
            for alias in item.get("aliases", [])
            if isinstance(alias, str)
        ]
        supplied_group = (
            item.get("group") if isinstance(item.get("group"), str) else None
        )
        catalog_ids = [
            catalog_id
            for catalog_id in item.get("catalog_ids", [])
            if isinstance(catalog_id, str)
        ]
        catalog_id = (
            item.get("catalog_id")
            if isinstance(item.get("catalog_id"), str)
            else None
        )
        if catalog_id and catalog_id not in catalog_ids:
            catalog_ids.insert(0, catalog_id)
        parameter = {
            "key": (
                item.get("key")
                if isinstance(item.get("key"), str)
                else f"nrpn:{channel}:{number}"
            ),
            "kind": "nrpn",
            "channel": channel,
            "parameter": number,
            "number": number,
            "name": supplied_name or (
                catalog_names[0] if len(catalog_names) == 1 else f"NRPN {number}"
            ),
            "aliases": supplied_aliases or (
                catalog_names if len(catalog_names) == 1 else []
            ),
            "group": supplied_group or (
                catalog_groups[0] if len(catalog_groups) == 1 else "NRPN"
            ),
            "value": value,
            "min": display_min,
            "max": display_max,
            "normalized": max(0.0, min(1.0, normalized)),
            "resolution_bits": bits,
            "source": source,
            "age": max(0.0, age) if age is not None else None,
            "catalog_ids": catalog_ids or [
                entry.get("id")
                for entry in catalog_entries
                if isinstance(entry.get("id"), str)
            ],
            "catalog_ambiguous": bool(
                item.get("catalog_ambiguous", len(catalog_entries) > 1)
            ),
        }
        if catalog_id:
            parameter["catalog_id"] = catalog_id
        for metadata_key in (
            "raw_value",
            "raw_resolution_bits",
            "decode_status",
            "value_kind",
            "encoding",
            "range_authoritative",
            "display_value",
            "display_label",
            "display_unmapped",
            "context_dependent",
            "dependency",
            "enum",
            "candidate_names",
        ):
            if metadata_key in item:
                parameter[metadata_key] = copy.deepcopy(item[metadata_key])
        reported_takeover = finite_number(item.get("takeover_remaining"))
        if reported_takeover is not None:
            parameter["takeover_remaining"] = max(0.0, reported_takeover)
        elif source == "user" and age is not None:
            parameter["takeover_remaining"] = max(0.0, takeover - age)
        parameters.append(parameter)

    return sorted(
        parameters,
        key=lambda item: (
            item["kind"] != "cc",
            item["channel"],
            item["number"],
            item["key"],
        ),
    )


class SnapshotStore:
    """Thread-safe reduction of service messages into browser snapshots."""

    def __init__(
        self, mode: str, catalog: ParameterCatalog | None = None
    ) -> None:
        self.lock = threading.RLock()
        self.mode = mode
        self.catalog = catalog
        self.session_id = uuid.uuid4().hex
        self.ready: dict[str, Any] = {}
        self.status: dict[str, Any] = {}
        self.capabilities: dict[str, Any] = {}
        self.state: dict[str, Any] = {
            "uptime": 0.0,
            "event_sequence": 0,
            "takeover_seconds": 3.0,
            "patch": None,
            "cc": [],
            "nrpn": [],
            "active_notes": [],
        }
        self.events: deque[dict[str, Any]] = deque(maxlen=EVENT_HISTORY_LIMIT)
        self.stderr_tail: deque[str] = deque(maxlen=STDERR_HISTORY_LIMIT)
        self.logical_nrpn: dict[str, dict[str, Any]] = {}
        self.parameter_updated_at: dict[str, float] = {}
        self.parameter_event_sequence: dict[str, int] = {}
        self.takeover_until: dict[str, float] = {}
        self.notes_event_sequence: int | None = None
        self.patch_event_sequence: int | None = None
        self.service_running = mode == "demo"
        self.event_sequence: int | None = None
        self.accepted_state_sequence: int | None = None
        self.sequence_gap = False
        self.parse_errors = 0
        self.request_timeouts = 0
        self.pending_requests = 0
        self.error: str | None = None
        self.updated_at = utc_now()

    def set_process_started(self) -> None:
        with self.lock:
            self.service_running = True
            self.error = None
            self.updated_at = utc_now()

    def set_process_stopped(self, return_code: int | None) -> None:
        with self.lock:
            self.service_running = False
            if self.mode != "demo" and self.error is None:
                suffix = "" if return_code is None else f" (exit {return_code})"
                self.error = f"Hydrasynth service stopped{suffix}"
            self.updated_at = utc_now()

    def set_error(self, message: str) -> None:
        with self.lock:
            self.error = message
            self.updated_at = utc_now()

    def add_stderr(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        with self.lock:
            self.stderr_tail.append(line)
            self.updated_at = utc_now()

    def add_parse_error(self, line: str) -> None:
        with self.lock:
            self.parse_errors += 1
            preview = line.strip()
            if len(preview) > 180:
                preview = preview[:177] + "..."
            self.stderr_tail.append(f"Invalid service JSON: {preview}")
            self.updated_at = utc_now()

    def set_pending_requests(self, count: int) -> None:
        with self.lock:
            bounded = max(0, count)
            if bounded != self.pending_requests:
                self.pending_requests = bounded
                self.updated_at = utc_now()

    def add_request_timeout(self, operation: str) -> None:
        with self.lock:
            self.request_timeouts += 1
            self.stderr_tail.append(f"Timed out waiting for {operation} response")
            self.updated_at = utc_now()

    @staticmethod
    def _parameter_key(kind: str, channel: int, number: int) -> str:
        prefix = "nrpn-raw" if kind == "nrpn" else kind
        return f"{prefix}:{channel}:{number}"

    def _takeover_seconds_locked(self) -> float:
        value = finite_number(self.state.get("takeover_seconds"))
        if value is None:
            value = finite_number(self.status.get("takeover_seconds"))
        return max(0.0, value or 0.0)

    def _record_takeover_locked(
        self, key: str, item: dict[str, Any], now: float
    ) -> None:
        reported = finite_number(item.get("takeover_remaining"))
        if reported is not None:
            self.takeover_until[key] = now + max(0.0, reported)
            return
        source = item.get("source")
        if source != "user":
            return
        age = max(0.0, finite_number(item.get("age")) or 0.0)
        self.takeover_until[key] = now + max(
            0.0, self._takeover_seconds_locked() - age
        )

    @staticmethod
    def _valid_parameter_item(
        kind: str, item: dict[str, Any]
    ) -> tuple[int, int, int] | None:
        channel = integer(item.get("channel"))
        number = integer(
            item.get("number", item.get("cc"))
            if kind == "cc"
            else item.get("parameter", item.get("number"))
        )
        value = integer(item.get("value"))
        maximum_number = 127 if kind == "cc" else 16383
        maximum_value = 127 if kind == "cc" else 16383
        if (
            channel is None
            or number is None
            or value is None
            or not 1 <= channel <= 16
            or not 0 <= number <= maximum_number
            or not 0 <= value <= maximum_value
        ):
            return None
        return channel, number, value

    def _upsert_state_parameter_locked(
        self,
        kind: str,
        item: dict[str, Any],
        *,
        now: float,
        sequence: int | None,
    ) -> str | None:
        valid = self._valid_parameter_item(kind, item)
        if valid is None:
            return None
        channel, number, _value = valid
        key = self._parameter_key(kind, channel, number)
        collection_name = "cc" if kind == "cc" else "nrpn"
        collection = self.state.setdefault(collection_name, [])
        if not isinstance(collection, list):
            collection = []
            self.state[collection_name] = collection
        replacement = copy.deepcopy(item)
        replacement["channel"] = channel
        if kind == "cc":
            replacement["number"] = number
        else:
            replacement["parameter"] = number
            bits = integer(replacement.get("resolution_bits"))
            replacement["resolution_bits"] = bits if bits in {7, 14} else 14
        replacement["age"] = 0.0
        for index, current in enumerate(collection):
            if not isinstance(current, dict):
                continue
            current_valid = self._valid_parameter_item(kind, current)
            if (
                current_valid is not None
                and current_valid[0] == channel
                and current_valid[1] == number
            ):
                collection[index] = replacement
                break
        else:
            collection.append(replacement)
        self.parameter_updated_at[key] = now
        if sequence is not None:
            self.parameter_event_sequence[key] = sequence
        self._record_takeover_locked(key, replacement, now)
        return key

    def _decode_nrpn_locked(
        self,
        raw_item: dict[str, Any],
        *,
        now: float,
        sequence: int | None,
    ) -> None:
        if self.catalog is None:
            return
        valid = self._valid_parameter_item("nrpn", raw_item)
        if valid is None:
            return
        channel, number, raw_value = valid
        bits = integer(raw_item.get("resolution_bits")) or 14
        if bits not in {7, 14}:
            bits = 14
        source = (
            raw_item.get("source")
            if isinstance(raw_item.get("source"), str)
            else "unknown"
        )
        age = finite_number(raw_item.get("age"))
        records = self.catalog.decode_nrpn(
            channel=channel,
            number=number,
            raw_value=raw_value,
            source=source,
            age=max(0.0, age) if age is not None else None,
            resolution_bits=bits,
        )
        for record in records:
            key = record["key"]
            reported_takeover = finite_number(raw_item.get("takeover_remaining"))
            if reported_takeover is not None:
                record["takeover_remaining"] = max(0.0, reported_takeover)
            self.logical_nrpn.pop(key, None)
            self.logical_nrpn[key] = record
            self.parameter_updated_at[key] = now - max(0.0, age or 0.0)
            if sequence is not None:
                self.parameter_event_sequence[key] = sequence
            self._record_takeover_locked(key, record, now)
            while len(self.logical_nrpn) > LOGICAL_NRPN_LIMIT:
                oldest_key = next(iter(self.logical_nrpn))
                self.logical_nrpn.pop(oldest_key, None)
                self.parameter_updated_at.pop(oldest_key, None)
                self.parameter_event_sequence.pop(oldest_key, None)
                self.takeover_until.pop(oldest_key, None)

    def _clear_parameter_state_locked(self) -> None:
        self.state["cc"] = []
        self.state["nrpn"] = []
        self.logical_nrpn.clear()
        self.parameter_updated_at.clear()
        self.parameter_event_sequence.clear()
        self.takeover_until.clear()

    def _reduce_event_locked(
        self, message: dict[str, Any], sequence: int | None
    ) -> None:
        event = message.get("event")
        now = time.monotonic()
        if event == "cc":
            item = {
                key: copy.deepcopy(message[key])
                for key in (
                    "channel",
                    "number",
                    "value",
                    "source",
                    "takeover_remaining",
                )
                if key in message
            }
            self._upsert_state_parameter_locked(
                "cc", item, now=now, sequence=sequence
            )
        elif event == "nrpn":
            item = {
                key: copy.deepcopy(message[key])
                for key in (
                    "channel",
                    "parameter",
                    "value",
                    "resolution_bits",
                    "source",
                    "takeover_remaining",
                )
                if key in message
            }
            self._upsert_state_parameter_locked(
                "nrpn", item, now=now, sequence=sequence
            )
            self._decode_nrpn_locked(item, now=now, sequence=sequence)
        elif event in {"note_on", "note_off"}:
            channel = integer(message.get("channel"))
            note = integer(message.get("note"))
            if (
                channel is not None
                and note is not None
                and 1 <= channel <= 16
                and 0 <= note <= 127
            ):
                notes = self.state.setdefault("active_notes", [])
                if not isinstance(notes, list):
                    notes = []
                    self.state["active_notes"] = notes
                match = next(
                    (
                        item
                        for item in notes
                        if (
                            isinstance(item, dict)
                            and integer(item.get("channel")) == channel
                            and integer(item.get("note")) == note
                        )
                    ),
                    None,
                )
                count = integer(match.get("count")) if match is not None else 0
                count = max(0, count or 0)
                count += 1 if event == "note_on" else -1
                if match is not None:
                    notes.remove(match)
                if count > 0:
                    notes.append({"channel": channel, "note": note, "count": count})
                if sequence is not None:
                    self.notes_event_sequence = sequence
        elif event == "patch":
            bank = message.get("bank")
            number = integer(message.get("number"))
            if isinstance(bank, str) and number is not None:
                self.state["patch"] = {"bank": bank, "number": number}
                self._clear_parameter_state_locked()
                if sequence is not None:
                    self.patch_event_sequence = sequence
        elif event == "automation_blocked":
            channel = integer(message.get("channel"))
            number = integer(message.get("number"))
            retry_ms = finite_number(message.get("retry_after_ms"))
            if (
                channel is not None
                and number is not None
                and retry_ms is not None
                and 1 <= channel <= 16
                and 0 <= number <= 127
            ):
                key = self._parameter_key("cc", channel, number)
                self.takeover_until[key] = max(
                    self.takeover_until.get(key, 0.0),
                    now + max(0.0, retry_ms) / 1000.0,
                )

    def _reconcile_parameter_list_locked(
        self,
        kind: str,
        incoming: Any,
        *,
        now: float,
        response_sequence: int | None,
    ) -> list[dict[str, Any]]:
        incoming_items = [
            item
            for item in incoming if isinstance(item, dict)
        ] if isinstance(incoming, list) else []
        collection_name = "cc" if kind == "cc" else "nrpn"
        existing_items = self.state.get(collection_name, [])
        existing_by_key: dict[str, dict[str, Any]] = {}
        if isinstance(existing_items, list):
            for item in existing_items:
                if not isinstance(item, dict):
                    continue
                valid = self._valid_parameter_item(kind, item)
                if valid is not None:
                    existing_by_key[
                        self._parameter_key(kind, valid[0], valid[1])
                    ] = item
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in incoming_items:
            valid = self._valid_parameter_item(kind, item)
            if valid is None:
                continue
            key = self._parameter_key(kind, valid[0], valid[1])
            seen.add(key)
            event_sequence = self.parameter_event_sequence.get(key)
            if (
                response_sequence is not None
                and event_sequence is not None
                and event_sequence > response_sequence
                and key in existing_by_key
            ):
                result.append(existing_by_key[key])
                continue
            accepted = copy.deepcopy(item)
            age = max(0.0, finite_number(accepted.get("age")) or 0.0)
            self.parameter_updated_at[key] = now - age
            self._record_takeover_locked(key, accepted, now)
            result.append(accepted)
        for key, item in existing_by_key.items():
            event_sequence = self.parameter_event_sequence.get(key)
            if (
                key not in seen
                and response_sequence is not None
                and event_sequence is not None
                and event_sequence > response_sequence
            ):
                result.append(item)
                seen.add(key)
                continue
            if key not in seen:
                self.parameter_updated_at.pop(key, None)
                self.parameter_event_sequence.pop(key, None)
                self.takeover_until.pop(key, None)
        return result

    def _accept_state_locked(self, incoming: dict[str, Any]) -> None:
        now = time.monotonic()
        response_sequence = integer(incoming.get("event_sequence"))
        incoming_patch = copy.deepcopy(incoming.get("patch"))
        patch_event_newer = (
            response_sequence is not None
            and self.patch_event_sequence is not None
            and self.patch_event_sequence > response_sequence
        )
        patch_changed = (
            not patch_event_newer
            and incoming_patch != self.state.get("patch")
            and incoming_patch is not None
        )
        if patch_changed:
            self._clear_parameter_state_locked()

        if patch_event_newer:
            current_cc = self.state.get("cc")
            current_nrpn = self.state.get("nrpn")
            cc_items = (
                copy.deepcopy(current_cc) if isinstance(current_cc, list) else []
            )
            nrpn_items = (
                copy.deepcopy(current_nrpn)
                if isinstance(current_nrpn, list)
                else []
            )
        else:
            cc_items = self._reconcile_parameter_list_locked(
                "cc",
                incoming.get("cc"),
                now=now,
                response_sequence=response_sequence,
            )
            nrpn_items = self._reconcile_parameter_list_locked(
                "nrpn",
                incoming.get("nrpn"),
                now=now,
                response_sequence=response_sequence,
            )

        for key, value in incoming.items():
            if key not in {"cc", "nrpn", "active_notes", "patch"}:
                self.state[key] = copy.deepcopy(value)
        if not patch_event_newer:
            self.state["patch"] = incoming_patch
        self.state["cc"] = cc_items
        self.state["nrpn"] = nrpn_items
        if not (
            response_sequence is not None
            and self.notes_event_sequence is not None
            and self.notes_event_sequence > response_sequence
        ):
            notes = incoming.get("active_notes")
            self.state["active_notes"] = copy.deepcopy(notes) if isinstance(notes, list) else []
        if self.event_sequence is not None:
            self.state["event_sequence"] = max(
                integer(self.state.get("event_sequence")) or 0,
                self.event_sequence,
            )
        if response_sequence is not None:
            if (
                self.accepted_state_sequence is None
                or response_sequence > self.accepted_state_sequence
            ):
                self.accepted_state_sequence = response_sequence
            if self.event_sequence is None or response_sequence > self.event_sequence:
                self.event_sequence = response_sequence

        present_raw_keys: set[str] = set()
        for item in nrpn_items:
            valid = self._valid_parameter_item("nrpn", item)
            if valid is None:
                continue
            raw_key = self._parameter_key("nrpn", valid[0], valid[1])
            present_raw_keys.add(raw_key)
            decoded = self.catalog.decode_nrpn(
                channel=valid[0],
                number=valid[1],
                raw_value=valid[2],
                source=(
                    item.get("source")
                    if isinstance(item.get("source"), str)
                    else "unknown"
                ),
                age=finite_number(item.get("age")),
                resolution_bits=integer(item.get("resolution_bits")) or 14,
            ) if self.catalog is not None else []
            for record in decoded:
                key = record["key"]
                event_sequence = self.parameter_event_sequence.get(key)
                if (
                    response_sequence is not None
                    and event_sequence is not None
                    and event_sequence > response_sequence
                ):
                    continue
                reported_takeover = finite_number(item.get("takeover_remaining"))
                if reported_takeover is not None:
                    record["takeover_remaining"] = max(0.0, reported_takeover)
                self.logical_nrpn.pop(key, None)
                self.logical_nrpn[key] = record
                age = max(0.0, finite_number(item.get("age")) or 0.0)
                self.parameter_updated_at[key] = now - age
                self._record_takeover_locked(key, record, now)

        for key, record in list(self.logical_nrpn.items()):
            valid = self._valid_parameter_item("nrpn", record)
            if valid is None:
                self.logical_nrpn.pop(key, None)
                continue
            raw_key = self._parameter_key("nrpn", valid[0], valid[1])
            event_sequence = self.parameter_event_sequence.get(key)
            if (
                raw_key not in present_raw_keys
                and not (
                    response_sequence is not None
                    and event_sequence is not None
                    and event_sequence > response_sequence
                )
            ):
                self.logical_nrpn.pop(key, None)
                self.parameter_updated_at.pop(key, None)
                self.parameter_event_sequence.pop(key, None)
                self.takeover_until.pop(key, None)
        while len(self.logical_nrpn) > LOGICAL_NRPN_LIMIT:
            oldest_key = next(iter(self.logical_nrpn))
            self.logical_nrpn.pop(oldest_key, None)
            self.parameter_updated_at.pop(oldest_key, None)
            self.parameter_event_sequence.pop(oldest_key, None)
            self.takeover_until.pop(oldest_key, None)

    def _snapshot_state_locked(self, now: float) -> dict[str, Any]:
        state = copy.deepcopy(self.state)
        for kind, collection_name in (("cc", "cc"), ("nrpn", "nrpn")):
            items = state.get(collection_name, [])
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                valid = self._valid_parameter_item(kind, item)
                if valid is None:
                    continue
                key = self._parameter_key(kind, valid[0], valid[1])
                updated_at = self.parameter_updated_at.get(key)
                if updated_at is not None:
                    item["age"] = max(0.0, now - updated_at)
                deadline = self.takeover_until.get(key)
                if deadline is not None:
                    item["takeover_remaining"] = max(0.0, deadline - now)
        logical_items = copy.deepcopy(list(self.logical_nrpn.values()))
        if self.catalog is not None:
            logical_by_key = {
                item.get("key"): item
                for item in logical_items
                if isinstance(item.get("key"), str)
            }
            for raw_item in state.get("nrpn", []):
                if not isinstance(raw_item, dict):
                    continue
                valid = self._valid_parameter_item("nrpn", raw_item)
                if valid is None:
                    continue
                decoded = self.catalog.decode_nrpn(
                    channel=valid[0],
                    number=valid[1],
                    raw_value=valid[2],
                    source=(
                        raw_item.get("source")
                        if isinstance(raw_item.get("source"), str)
                        else "unknown"
                    ),
                    age=finite_number(raw_item.get("age")),
                    resolution_bits=integer(raw_item.get("resolution_bits")) or 14,
                )
                for record in decoded:
                    if "takeover_remaining" in raw_item:
                        record["takeover_remaining"] = copy.deepcopy(
                            raw_item["takeover_remaining"]
                        )
                    logical_by_key.setdefault(record["key"], record)
            logical_items = list(logical_by_key.values())
        for item in logical_items:
            key = item.get("key")
            if not isinstance(key, str):
                continue
            updated_at = self.parameter_updated_at.get(key)
            if updated_at is not None:
                item["age"] = max(0.0, now - updated_at)
            deadlines = [self.takeover_until.get(key)]
            valid = self._valid_parameter_item("nrpn", item)
            if valid is not None:
                deadlines.append(
                    self.takeover_until.get(
                        self._parameter_key("nrpn", valid[0], valid[1])
                    )
                )
            active_deadlines = [
                deadline for deadline in deadlines if deadline is not None
            ]
            if active_deadlines:
                item["takeover_remaining"] = max(
                    0.0, max(active_deadlines) - now
                )
        if self.catalog is not None:
            state["nrpn_logical"] = logical_items
        return state

    def accept(
        self, message: dict[str, Any], response_kind: str | None = None
    ) -> None:
        with self.lock:
            message_type = message.get("type")
            if message_type == "ready":
                self.ready = copy.deepcopy(message)
                self.service_running = True
                self.error = None
            elif message_type == "event":
                sequence = integer(message.get("event_sequence"))
                if sequence is not None:
                    if (
                        self.event_sequence is not None
                        and sequence > self.event_sequence + 1
                    ):
                        self.sequence_gap = True
                    if self.event_sequence is None or sequence > self.event_sequence:
                        self.event_sequence = sequence
                self.events.append(copy.deepcopy(message))
                if (
                    sequence is None
                    or self.accepted_state_sequence is None
                    or sequence > self.accepted_state_sequence
                ):
                    self._reduce_event_locked(message, sequence)
            elif message_type == "response" and message.get("ok") is True:
                payload = response_payload(message)
                if response_kind == "state" and isinstance(payload.get("state"), dict):
                    self._accept_state_locked(payload["state"])
                elif response_kind == "status":
                    self.status = payload
                elif response_kind == "capabilities":
                    self.capabilities = payload
                if response_kind in {"state", "status", "capabilities"}:
                    self.error = None
            elif message_type == "response" and message.get("ok") is False:
                error = message.get("error")
                if isinstance(error, dict):
                    detail = error.get("message") or error.get("code")
                else:
                    detail = error
                if response_kind in {"state", "status", "capabilities"}:
                    self.error = f"{response_kind} request failed: {detail or 'unknown error'}"
            self.updated_at = utc_now()

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            monotonic_now = time.monotonic()
            ready = copy.deepcopy(self.ready)
            status = copy.deepcopy(self.status)
            capabilities = copy.deepcopy(self.capabilities)
            state = self._snapshot_state_locked(monotonic_now)
            events = copy.deepcopy(list(self.events))
            connected = ready.get("connected")
            input_connected = ready.get("input_connected")
            bridge = {
                "mode": self.mode,
                "session_id": self.session_id,
                "service_running": self.service_running,
                "connected": bool(connected) if connected is not None else self.mode == "demo",
                "input_connected": (
                    bool(input_connected)
                    if input_connected is not None
                    else self.mode == "demo"
                ),
                "endpoint_state": (
                    "demo"
                    if self.mode == "demo"
                    else "selected_unverified" if connected else "unavailable"
                ),
                "destination": ready.get("destination"),
                "source": ready.get("source"),
                "event_sequence": self.event_sequence,
                "sequence_gap": self.sequence_gap,
                "parse_errors": self.parse_errors,
                "pending_requests": self.pending_requests,
                "request_timeouts": self.request_timeouts,
                "stderr_tail": list(self.stderr_tail),
                "error": self.error,
                "updated_at": self.updated_at,
            }
        return {
            "v": 1,
            "generated_at": utc_now(),
            "generated_at_epoch": time.time(),
            "bridge": bridge,
            "ready": ready,
            "status": status,
            "capabilities": capabilities,
            "catalog": (
                self.catalog.summary()
                if self.catalog is not None
                else {"available": False}
            ),
            "state": state,
            "parameters": build_parameters(state, capabilities, self.catalog),
            "events": events,
        }


class SignalLabFeed:
    """Thread-safe performance feed published by the Signal Lab browser."""

    def __init__(self, catalog: ParameterCatalog | None = None) -> None:
        self.store = SnapshotStore("signal-lab", catalog)
        self.lock = threading.RLock()
        self.started = time.monotonic()
        self.sequence = 0
        self.last_publish: float | None = None
        self.note_deadlines: dict[tuple[int, int], float] = {}
        self.metadata: dict[str, Any] = {
            "recording": None,
            "output": "browser audio",
            "progress": 0.0,
            "mapping_count": 0,
            "composite_count": 0,
        }
        self.store.accept(
            {
                "v": 1,
                "type": "ready",
                "connected": False,
                "destination": "BROWSER AUDIO",
                "input_connected": False,
                "source": "SIGNAL LAB",
                "scheduler": True,
                "event_writer": True,
                "channel": 1,
                "takeover_seconds": 0.0,
            }
        )
        self.store.capabilities = {
            "ops": ["state"],
            "timbre_controls": [],
            "limits": {"notification_queue": 0},
        }
        self.store.status = {
            "connected": False,
            "input_connected": False,
            "scheduler": True,
            "queued_events": 0,
            "active_jobs": 0,
            "event_writer": True,
            "notification_queued": 0,
            "notification_dropped": 0,
            "event_sequence": 0,
            "channel": 1,
            "takeover_seconds": 0.0,
            "incoming_dropped": 0,
            "source": "SIGNAL LAB",
            "destination": "BROWSER AUDIO",
        }

    @staticmethod
    def _short_text(value: Any, maximum: int = 160) -> str | None:
        if not isinstance(value, str):
            return None
        text = value.strip()
        return text[:maximum] if text else None

    def _update_drums_locked(self, value: Any) -> None:
        """Accept only known, finite groove telemetry; retain prior valid fields."""
        if not isinstance(value, dict):
            return
        drums = self.metadata.setdefault("drums", {})
        for name, minimum, maximum in (
            ("activity", 0, 1), ("tempo", 20, 240), ("density", 0, 100)
        ):
            number = value.get(name)
            if (isinstance(number, (int, float)) and not isinstance(number, bool)
                    and minimum <= number <= maximum):
                drums[name] = float(number)
        for name, choices in (
            ("style", ("straight", "broken", "half")),
            ("kit", ("electro", "warehouse", "minimal")),
        ):
            if value.get(name) in choices:
                drums[name] = value[name]

    def _event_locked(self, payload: dict[str, Any]) -> None:
        self.sequence += 1
        event = {
            "v": 1,
            "type": "event",
            "event_sequence": self.sequence,
            "server_time_ms": (time.monotonic() - self.started) * 1000.0,
            "source": "signal_lab",
            **payload,
        }
        self.store.accept(event)

    def _expire_notes_locked(self, now: float, *, clear_all: bool = False) -> None:
        expired = [
            key
            for key, deadline in self.note_deadlines.items()
            if clear_all or deadline <= now
        ]
        for channel, note in expired:
            self._event_locked(
                {
                    "event": "note_off",
                    "channel": channel,
                    "note": note,
                    "velocity": 0,
                }
            )
            self.note_deadlines.pop((channel, note), None)

    def active(self, now: float | None = None) -> bool:
        with self.lock:
            current = time.monotonic() if now is None else now
            return (
                self.last_publish is not None
                and current - self.last_publish <= SIGNAL_LAB_ACTIVE_SECONDS
            )

    def publish(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("signal_lab_payload_must_be_an_object")
        raw_notes = payload.get("notes", [payload.get("note")])
        if not isinstance(raw_notes, list) or len(raw_notes) > 8:
            raise ValueError("signal_lab_requires_at_most_8_notes")
        raw_cc = payload.get("cc")
        cc_items = raw_cc if isinstance(raw_cc, list) else []
        if len(cc_items) > SIGNAL_LAB_CC_LIMIT:
            raise ValueError("too_many_signal_lab_controls")
        raw_nrpn = payload.get("nrpn", [])
        if not isinstance(raw_nrpn, list) or len(raw_nrpn) > 64:
            raise ValueError("too_many_signal_lab_nrpn_controls")
        now = time.monotonic()
        with self.lock:
            self._expire_notes_locked(now)
            recording = self._short_text(payload.get("recording"))
            output = self._short_text(payload.get("output"), 32)
            progress = finite_number(payload.get("progress"))
            mapping_count = integer(payload.get("mapping_count"))
            composite_count = integer(payload.get("composite_count"))
            if recording is not None:
                self.metadata["recording"] = recording
            output_names = {"audio": "browser audio", "midi": "Hydrasynth MIDI", "drums": "electronic drums"}
            if output in output_names:
                next_output = output_names[output]
                if next_output != self.metadata["output"]:
                    self._expire_notes_locked(now, clear_all=True)
                    self.metadata.pop("voice_name", None)
                    self.metadata.pop("drums", None)
                    if output == "drums":
                        with self.store.lock:
                            self.store.state["patch"] = {"bank": "?", "number": None}
                            self.store.state["cc"] = []
                            self.store.state["nrpn"] = []
                self.metadata["output"] = next_output
            if self.metadata["output"] == "electronic drums":
                self._update_drums_locked(payload.get("drums"))
            if progress is not None:
                self.metadata["progress"] = max(0.0, min(1.0, progress))
            if mapping_count is not None:
                self.metadata["mapping_count"] = max(0, min(64, mapping_count))
            if composite_count is not None:
                self.metadata["composite_count"] = max(0, min(64, composite_count))

            destination_count = integer(payload.get("destination_count"))
            if destination_count is not None:
                self.metadata["destination_count"] = max(0, min(2048, destination_count))
            if payload.get("source_mode") in {"live", "recording"}:
                self.metadata["source_mode"] = payload["source_mode"]
            if "voice_name" in payload:
                self.metadata["voice_name"] = self._short_text(payload["voice_name"], 32)
            patch = payload.get("patch")
            if isinstance(patch, dict) and output == "midi":
                bank = patch.get("bank")
                number = integer(patch.get("number"))
                if isinstance(bank, str) and bank in tuple("ABCDEFGH") and number is not None and 1 <= number <= 128:
                    location = {"bank": bank, "number": number}
                    if self.store.state.get("patch") != location:
                        self._expire_notes_locked(now, clear_all=True)
                        self._event_locked({"event": "patch", **location})
            elif "patch" in payload and patch is None:
                with self.store.lock:
                    self.store.state["patch"] = {"bank": "?", "number": None}

            accepted_controls = 0
            seen_cc: set[int] = set()
            for item in cc_items:
                if not isinstance(item, dict):
                    continue
                number = integer(item.get("number"))
                value = integer(item.get("value"))
                if (
                    number is None
                    or value is None
                    or not 0 <= number <= 127
                    or not 0 <= value <= 127
                    or number in seen_cc
                ):
                    continue
                seen_cc.add(number)
                self._event_locked(
                    {
                        "event": "cc",
                        "channel": 1,
                        "number": number,
                        "value": value,
                    }
                )
                accepted_controls += 1

            # Keep selector-bearing updates even when they share an NRPN address.
            for item in raw_nrpn:
                if not isinstance(item, dict):
                    continue
                parameter = integer(item.get("number"))
                value = integer(item.get("value"))
                if parameter is None or value is None or not 0 <= parameter <= 16383 or not 0 <= value <= 16383:
                    continue
                self._event_locked({"event": "nrpn", "channel": 1, "parameter": parameter,
                                    "value": value, "resolution_bits": 14})
                accepted_controls += 1

            if payload.get("stop") is True:
                self._expire_notes_locked(now, clear_all=True)

            accepted_notes = 0
            seen_notes: set[int] = set()
            for note in raw_notes:
                if not isinstance(note, dict) or payload.get("stop") is True:
                    continue
                number = integer(note.get("number"))
                velocity = integer(note.get("velocity"))
                duration = finite_number(note.get("duration_ms"))
                if (
                    number is not None
                    and velocity is not None
                    and duration is not None
                    and 0 <= number <= 127
                    and number not in seen_notes
                    and 1 <= velocity <= 127
                    and 1 <= duration <= 30_000
                ):
                    seen_notes.add(number)
                    accepted_notes += 1
                    key = (1, number)
                    if key in self.note_deadlines:
                        self._event_locked(
                            {
                                "event": "note_off",
                                "channel": 1,
                                "note": number,
                                "velocity": 0,
                            }
                        )
                    self._event_locked(
                        {
                            "event": "note_on",
                            "channel": 1,
                            "note": number,
                            "velocity": velocity,
                        }
                    )
                    self.note_deadlines[key] = now + duration / 1000.0

            self.last_publish = now
            destination = str(self.metadata["output"]).upper()
            with self.store.lock:
                self.store.ready["connected"] = True
                self.store.ready["destination"] = destination
                self.store.status.update(
                    {
                        "connected": True,
                        "active_jobs": 1,
                        "event_sequence": self.sequence,
                        "source": "SIGNAL LAB",
                        "destination": destination,
                    }
                )
                self.store.updated_at = utc_now()
            return {
                "ok": True,
                "event_sequence": self.sequence,
                "accepted_controls": accepted_controls,
                "accepted_notes": accepted_notes,
            }

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.lock:
            self._expire_notes_locked(now)
            active = self.active(now)
            snapshot = self.store.snapshot()
            age = (
                None
                if self.last_publish is None
                else max(0.0, now - self.last_publish)
            )
            destination = str(self.metadata["output"]).upper()
            snapshot["signal_lab"] = {
                **copy.deepcopy(self.metadata),
                "active": active,
                "last_update_age": age,
            }
            snapshot["bridge"].update(
                {
                    "mode": "signal-lab",
                    "service_running": True,
                    "connected": active,
                    "input_connected": False,
                    "endpoint_state": (
                        "signal_lab_active" if active else "signal_lab_idle"
                    ),
                    "destination": destination,
                    "source": "SIGNAL LAB",
                }
            )
            snapshot["status"].update(
                {
                    "connected": active,
                    "active_jobs": 1 if active else 0,
                    "event_sequence": self.sequence,
                    "destination": destination,
                    "source": "SIGNAL LAB",
                }
            )
            return snapshot


def service_error_response(
    caller_id: Any, code: str, message: str
) -> dict[str, Any]:
    return {
        "v": 1,
        "type": "response",
        "id": copy.deepcopy(caller_id),
        "ok": False,
        "error": {"code": code, "message": message},
    }


def valid_caller_id(value: Any) -> bool:
    if isinstance(value, str):
        return True
    return finite_number(value) is not None


@dataclass
class PendingRequest:
    operation: str
    deadline: float
    source: str = "poll"
    caller_id: Any = None
    waiter: threading.Event | None = None
    response: dict[str, Any] | None = None


class LiveService:
    def __init__(
        self,
        store: SnapshotStore,
        executable: Path,
        device: str | None,
        channel: int,
        takeover: float,
        no_input: bool,
    ) -> None:
        self.store = store
        self.executable = executable
        self.device = device
        self.channel = channel
        self.takeover = takeover
        self.no_input = no_input
        self.process: subprocess.Popen[str] | None = None
        self.stop_event = threading.Event()
        self.ready_event = threading.Event()
        self.reconcile_event = threading.Event()
        self.write_lock = threading.Lock()
        self.pending_lock = threading.Lock()
        self.pending: dict[str, PendingRequest] = {}
        self.request_number = 0
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        if not self.executable.is_file() or not os.access(self.executable, os.X_OK):
            raise FileNotFoundError(
                f"{self.executable} is missing or not executable; run `make` first"
            )
        command = [
            str(self.executable),
            "serve",
            "--channel",
            str(self.channel),
            "--takeover",
            f"{self.takeover:g}",
        ]
        if self.device:
            command.extend(["--device", self.device])
        if self.no_input:
            command.append("--no-input")
        self.process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self.store.set_process_started()
        self.threads = [
            threading.Thread(target=self._read_stdout, name="hydra-stdout", daemon=True),
            threading.Thread(target=self._read_stderr, name="hydra-stderr", daemon=True),
            threading.Thread(target=self._poll, name="hydra-poller", daemon=True),
        ]
        for thread in self.threads:
            thread.start()
        if not self.ready_event.wait(SERVICE_READY_TIMEOUT_SECONDS):
            self.store.set_error(
                "Timed out waiting for the Hydrasynth service ready message"
            )
            self.stop()
            raise TimeoutError(
                "Hydrasynth service did not become ready within "
                f"{SERVICE_READY_TIMEOUT_SECONDS:g} seconds"
            )

    def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        for raw_line in self.process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.store.add_parse_error(line)
                continue
            if not isinstance(message, dict):
                self.store.add_parse_error(line)
                continue
            self._accept_service_message(message)
            if message.get("type") == "ready":
                self.ready_event.set()
        return_code = self.process.wait()
        self._fail_all_pending(
            "service_stopped", "Hydrasynth service stopped before responding"
        )
        if not self.stop_event.is_set():
            self.store.set_process_stopped(return_code)

    def _accept_service_message(self, message: dict[str, Any]) -> None:
        pending: PendingRequest | None = None
        response_kind: str | None = None
        if message.get("type") == "response":
            request_id = message.get("id")
            if request_id is not None:
                with self.pending_lock:
                    pending = self.pending.pop(str(request_id), None)
                    if pending is not None:
                        response_kind = pending.operation
                        if pending.source == "broker":
                            restored = copy.deepcopy(message)
                            restored["id"] = copy.deepcopy(pending.caller_id)
                            pending.response = restored
                    pending_count = len(self.pending)
                self.store.set_pending_requests(pending_count)

        self.store.accept(message, response_kind)
        if pending is None or pending.source != "broker":
            return

        if (
            message.get("ok") is True
            and pending.operation not in BROKER_READ_ONLY_OPERATIONS
        ):
            self.reconcile_event.set()
        if pending.waiter is not None:
            pending.waiter.set()

    def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        for line in self.process.stderr:
            self.store.add_stderr(line)

    def _poll(self) -> None:
        while not self.stop_event.is_set() and not self.ready_event.wait(0.1):
            if self.process is not None and self.process.poll() is not None:
                return
        next_state = 0.0
        next_status = 0.0
        next_capabilities = 0.0
        while not self.stop_event.wait(0.05):
            if self.process is None or self.process.poll() is not None:
                return
            now = time.monotonic()
            self._expire_pending(now)
            if self.reconcile_event.is_set():
                self.reconcile_event.clear()
                next_state = 0.0
                next_status = 0.0
            if now >= next_state:
                self.send_request("state")
                next_state = now + 0.5
            if now >= next_status:
                self.send_request("status")
                next_status = now + 1.0
            if now >= next_capabilities:
                self.send_request("capabilities")
                next_capabilities = now + 15.0

    def _expire_pending(self, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        expired: list[PendingRequest] = []
        with self.pending_lock:
            for request_id, pending in list(self.pending.items()):
                if current >= pending.deadline:
                    self.pending.pop(request_id, None)
                    expired.append(pending)
            pending_count = len(self.pending)
        self.store.set_pending_requests(pending_count)
        for pending in expired:
            self.store.add_request_timeout(pending.operation)
            if pending.source == "broker":
                pending.response = service_error_response(
                    pending.caller_id,
                    "broker_timeout",
                    f"Timed out waiting for {pending.operation} response",
                )
                if pending.waiter is not None:
                    pending.waiter.set()

    def send_request(self, operation: str) -> bool:
        request = {"v": 1, "op": operation}
        return self._queue_request(request, operation=operation) is not None

    def _queue_request(
        self,
        request: dict[str, Any],
        *,
        operation: str,
        source: str = "poll",
        caller_id: Any = None,
        waiter: threading.Event | None = None,
    ) -> PendingRequest | None:
        process = self.process
        if process is None or process.poll() is not None or process.stdin is None:
            return None
        self._expire_pending()
        with self.write_lock:
            self.request_number += 1
            request_id = (
                f"broker-{self.request_number}-{uuid.uuid4().hex}"
                if source == "broker"
                else f"dashboard-{operation}-{self.request_number}"
            )
            pending = PendingRequest(
                operation=operation,
                deadline=time.monotonic() + REQUEST_TIMEOUT_SECONDS,
                source=source,
                caller_id=copy.deepcopy(caller_id),
                waiter=waiter,
            )
            with self.pending_lock:
                if source == "poll" and any(
                    candidate.source == "poll"
                    and candidate.operation == operation
                    for candidate in self.pending.values()
                ):
                    return None
                if len(self.pending) >= PENDING_REQUEST_LIMIT:
                    return None
                self.pending[request_id] = pending
                pending_count = len(self.pending)
            self.store.set_pending_requests(pending_count)
            wire_request = copy.deepcopy(request)
            wire_request["v"] = 1
            wire_request["id"] = request_id
            try:
                wire_payload = json.dumps(
                    wire_request, separators=(",", ":"), allow_nan=False
                )
                if len(wire_payload.encode("utf-8")) > HYDRACTL_JSON_LINE_LIMIT:
                    raise ValueError("request exceeds the service's 16384-byte limit")
                process.stdin.write(wire_payload + "\n")
                process.stdin.flush()
                return pending
            except (BrokenPipeError, OSError, ValueError) as error:
                with self.pending_lock:
                    self.pending.pop(request_id, None)
                    pending_count = len(self.pending)
                self.store.set_pending_requests(pending_count)
                self.store.set_error(f"Unable to write to Hydrasynth service: {error}")
                return None

    def execute_command(
        self, request: dict[str, Any]
    ) -> dict[str, Any]:
        caller_id = request.get("id")
        if request.get("v") != 1:
            return service_error_response(
                caller_id, "invalid_request", "request.v must be 1"
            )
        if "id" not in request or not valid_caller_id(caller_id):
            return service_error_response(
                None,
                "invalid_request",
                "request.id must be a string or finite JSON number",
            )
        operation = request.get("op")
        if not isinstance(operation, str) or not operation:
            return service_error_response(
                caller_id, "invalid_request", "request.op must be a non-empty string"
            )
        if operation == "shutdown":
            return service_error_response(
                caller_id,
                "broker_forbidden",
                "shutdown is owned by the dashboard lifecycle; stop it with Control-C",
            )
        size_probe = copy.deepcopy(request)
        size_probe["v"] = 1
        size_probe["id"] = (
            "broker-18446744073709551615-" + ("0" * 32)
        )
        try:
            encoded_probe = json.dumps(
                size_probe, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        except (TypeError, ValueError):
            return service_error_response(
                caller_id,
                "invalid_request",
                "request must contain only finite JSON-compatible values",
            )
        if len(encoded_probe) > HYDRACTL_JSON_LINE_LIMIT:
            return service_error_response(
                caller_id,
                "request_too_large",
                "rewritten service request exceeds the 16384-byte limit",
            )
        process = self.process
        if process is None or process.poll() is not None:
            return service_error_response(
                caller_id, "service_unavailable", "Hydrasynth service is not running"
            )

        waiter = threading.Event()
        pending = self._queue_request(
            request,
            operation=operation,
            source="broker",
            caller_id=caller_id,
            waiter=waiter,
        )
        if pending is None:
            return service_error_response(
                caller_id,
                "broker_busy",
                "Hydrasynth service request queue is full or unavailable",
            )
        if waiter.wait(REQUEST_TIMEOUT_SECONDS + 0.25):
            return pending.response or service_error_response(
                caller_id,
                "service_unavailable",
                "Hydrasynth service returned no usable response",
            )

        removed = False
        with self.pending_lock:
            for request_id, candidate in list(self.pending.items()):
                if candidate is pending:
                    self.pending.pop(request_id, None)
                    removed = True
                    break
            pending_count = len(self.pending)
        self.store.set_pending_requests(pending_count)
        if pending.response is not None:
            return pending.response
        if removed:
            self.store.add_request_timeout(operation)
        return service_error_response(
            caller_id,
            "broker_timeout",
            f"Timed out waiting for {operation} response",
        )

    def _fail_all_pending(self, code: str, message: str) -> None:
        with self.pending_lock:
            pending_requests = list(self.pending.values())
            self.pending.clear()
        self.store.set_pending_requests(0)
        for pending in pending_requests:
            if pending.source != "broker":
                continue
            pending.response = service_error_response(
                pending.caller_id, code, message
            )
            if pending.waiter is not None:
                pending.waiter.set()

    def stop(self) -> None:
        self.stop_event.set()
        process = self.process
        if process is None:
            return
        if process.poll() is None:
            self.send_request("shutdown")
            try:
                process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1.0)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        for thread in self.threads:
            thread.join(timeout=0.5)
        self._fail_all_pending(
            "service_stopped", "Hydrasynth service stopped before responding"
        )
        self.store.set_process_stopped(process.returncode)


class DemoService:
    def __init__(self, store: SnapshotStore) -> None:
        self.store = store
        self.stop_event = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name="hydra-demo", daemon=True
        )
        self.started = time.monotonic()
        self.sequence = 0
        self.control_updates = {
            number: self.started for _, number in DEMO_CONTROLS
        }
        self.values = {
            number: int(38 + 34 * (0.5 + 0.5 * math.sin(index * 0.73)))
            for index, (_, number) in enumerate(DEMO_CONTROLS)
        }
        self.sources = {number: "agent" for _, number in DEMO_CONTROLS}

    def start(self) -> None:
        controls = [
            {
                "name": name,
                "kind": "cc",
                "number": number,
                "minimum": 0,
                "maximum": 127,
                "normalized": True,
            }
            for name, number in DEMO_CONTROLS
        ]
        self.store.accept(
            {
                "v": 1,
                "type": "ready",
                "connected": True,
                "destination": "HYDRASYNTH EXPLORER · DEMO",
                "input_connected": True,
                "source": "HYDRASYNTH EXPLORER · DEMO",
                "scheduler": True,
                "event_writer": True,
                "channel": 1,
                "takeover_seconds": 3.0,
            }
        )
        self.store.capabilities = {
            "ops": ["status", "capabilities", "state"],
            "timbre_controls": controls,
            "limits": {"notification_queue": 1024},
        }
        self.thread.start()

    def _event(self, event: dict[str, Any]) -> None:
        self.sequence += 1
        event.update(
            {
                "v": 1,
                "type": "event",
                "event_sequence": self.sequence,
                "server_time_ms": (time.monotonic() - self.started) * 1000.0,
            }
        )
        self.store.accept(event)

    def _cc_snapshot(self, now: float) -> list[dict[str, Any]]:
        return [
            {
                "channel": 1,
                "number": number,
                "value": self.values[number],
                "source": self.sources[number],
                "age": now - self.control_updates[number],
            }
            for _, number in DEMO_CONTROLS
        ]

    def _run(self) -> None:
        tick = 0
        chord = (48, 55, 60, 64, 67)
        while not self.stop_event.wait(0.22):
            now = time.monotonic()
            elapsed = now - self.started
            index = tick % len(DEMO_CONTROLS)
            _, number = DEMO_CONTROLS[index]
            value = round(
                63.5
                + 53
                * math.sin(elapsed * (0.42 + (index % 5) * 0.035) + index)
            )
            value = max(0, min(127, value))
            source = "user" if tick % 11 in {0, 1} else "agent"
            self.values[number] = value
            self.sources[number] = source
            self.control_updates[number] = now
            self._event(
                {
                    "event": "cc",
                    "source": source,
                    "channel": 1,
                    "number": number,
                    "value": value,
                }
            )
            if tick % 19 == 0:
                note = chord[(tick // 19) % len(chord)]
                self._event(
                    {
                        "event": "note_on",
                        "source": "user",
                        "channel": 1,
                        "note": note,
                        "velocity": 72 + tick % 36,
                    }
                )
            if tick % 19 == 7:
                note = chord[(tick // 19) % len(chord)]
                self._event(
                    {
                        "event": "note_off",
                        "source": "user",
                        "channel": 1,
                        "note": note,
                        "velocity": 0,
                    }
                )
            if tick % 13 == 0:
                self._event(
                    {
                        "event": "pitch_bend",
                        "source": "user",
                        "channel": 1,
                        "value": round(8192 + 3500 * math.sin(elapsed * 0.7)),
                        "normalized": 0.43 * math.sin(elapsed * 0.7),
                    }
                )

            active_notes: list[dict[str, Any]] = []
            if tick % 19 < 7:
                active_notes.append(
                    {
                        "channel": 1,
                        "note": chord[(tick // 19) % len(chord)],
                        "count": 1,
                    }
                )
            cc_items = self._cc_snapshot(now)
            with self.store.lock:
                self.store.state = {
                    "uptime": elapsed,
                    "event_sequence": self.sequence,
                    "takeover_seconds": 3.0,
                    "patch": {"bank": "A", "number": 1},
                    "cc": cc_items,
                    "nrpn": [
                        {
                            "channel": 1,
                            "parameter": 8232,
                            "value": round(
                                4096 + 3500 * math.sin(elapsed * 0.27)
                            ),
                            "resolution_bits": 14,
                            "source": "agent",
                            "age": 0.0,
                        }
                    ],
                    "active_notes": active_notes,
                }
                self.store.status = {
                    "connected": True,
                    "input_connected": True,
                    "scheduler": True,
                    "queued_events": 0,
                    "active_jobs": 1 if tick % 41 < 18 else 0,
                    "event_writer": True,
                    "notification_queued": 0,
                    "notification_dropped": 0,
                    "event_sequence": self.sequence,
                    "channel": 1,
                    "takeover_seconds": 3.0,
                    "incoming_dropped": 0,
                    "server_time_ms": elapsed * 1000.0,
                }
                self.store.updated_at = utc_now()
            tick += 1

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=1.0)


class CommandBroker:
    """Token-gated, one-request-per-connection AF_UNIX command broker."""

    def __init__(
        self,
        service: LiveService,
        socket_path: Path = DEFAULT_BROKER_SOCKET,
        token_path: Path = DEFAULT_BROKER_TOKEN,
    ) -> None:
        self.service = service
        self.socket_path = socket_path
        self.token_path = token_path
        self.token = ""
        self.listener: socket.socket | None = None
        self.stop_event = threading.Event()
        self.accept_thread: threading.Thread | None = None
        self.worker_slots = threading.BoundedSemaphore(BROKER_CONNECTION_LIMIT)
        self.workers_lock = threading.Lock()
        self.workers: set[threading.Thread] = set()
        self.socket_identity: tuple[int, int] | None = None
        self.token_identity: tuple[int, int] | None = None

    @staticmethod
    def _lstat(path: Path) -> os.stat_result | None:
        try:
            return path.lstat()
        except FileNotFoundError:
            return None

    @staticmethod
    def _active_socket(path: Path) -> bool:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.25)
        try:
            probe.connect(str(path))
            return True
        except (ConnectionRefusedError, FileNotFoundError):
            return False
        finally:
            probe.close()

    def _remove_stale_default(
        self, path: Path, default: Path, expected: str
    ) -> None:
        metadata = self._lstat(path)
        if metadata is None:
            return
        if path != default:
            raise FileExistsError(
                f"refusing to replace existing custom broker {expected}: {path}"
            )
        if metadata.st_uid != os.getuid():
            raise PermissionError(
                f"refusing to replace broker {expected} not owned by this user: {path}"
            )
        correct_type = (
            stat.S_ISSOCK(metadata.st_mode)
            if expected == "socket"
            else stat.S_ISREG(metadata.st_mode)
        )
        if not correct_type:
            raise FileExistsError(
                f"refusing to replace non-{expected} broker path: {path}"
            )
        if expected == "socket" and self._active_socket(path):
            raise OSError(f"another Hydrasynth command broker is active at {path}")
        path.unlink()

    @staticmethod
    def _identity(path: Path) -> tuple[int, int]:
        metadata = path.lstat()
        return metadata.st_dev, metadata.st_ino

    @staticmethod
    def _unlink_created(path: Path, identity: tuple[int, int] | None) -> None:
        if identity is None:
            return
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return
        if (metadata.st_dev, metadata.st_ino) == identity:
            path.unlink()

    def start(self) -> None:
        if self.socket_path == self.token_path:
            raise ValueError("broker socket and token file must be different paths")
        for path in (self.socket_path, self.token_path):
            if not path.is_absolute():
                raise ValueError(f"broker paths must be absolute: {path}")
            if not path.parent.is_dir():
                raise FileNotFoundError(
                    f"broker parent directory does not exist: {path.parent}"
                )

        self._remove_stale_default(
            self.socket_path, DEFAULT_BROKER_SOCKET, "socket"
        )
        self._remove_stale_default(
            self.token_path, DEFAULT_BROKER_TOKEN, "token file"
        )

        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener = listener
        try:
            listener.bind(str(self.socket_path))
            os.chmod(self.socket_path, 0o600)
            self.socket_identity = self._identity(self.socket_path)
            listener.listen(BROKER_CONNECTION_LIMIT)
            listener.settimeout(0.25)

            token = secrets.token_urlsafe(32)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(self.token_path, flags, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, (token + "\n").encode("ascii"))
            finally:
                os.close(descriptor)
            self.token_identity = self._identity(self.token_path)
            self.token = token
        except BaseException:
            listener.close()
            self.listener = None
            self._unlink_created(self.token_path, self.token_identity)
            self._unlink_created(self.socket_path, self.socket_identity)
            raise

        self.accept_thread = threading.Thread(
            target=self._accept_loop, name="hydra-command-broker", daemon=True
        )
        self.accept_thread.start()

    def _accept_loop(self) -> None:
        assert self.listener is not None
        while not self.stop_event.is_set():
            try:
                connection, _address = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if self.stop_event.is_set():
                    return
                continue
            if not self.worker_slots.acquire(blocking=False):
                self._write_response(
                    connection,
                    service_error_response(
                        None,
                        "broker_busy",
                        "Too many concurrent broker connections",
                    ),
                )
                connection.close()
                continue
            worker = threading.Thread(
                target=self._serve_connection,
                args=(connection,),
                name="hydra-command-client",
                daemon=True,
            )
            with self.workers_lock:
                self.workers.add(worker)
            worker.start()

    def _read_request(self, connection: socket.socket) -> bytes:
        connection.settimeout(REQUEST_TIMEOUT_SECONDS + 1.0)
        payload = bytearray()
        while True:
            chunk = connection.recv(4096)
            if not chunk:
                break
            payload.extend(chunk)
            newline = payload.find(b"\n")
            if newline >= 0:
                if newline > BROKER_REQUEST_LIMIT:
                    raise ValueError("broker request exceeds 16 KiB")
                if payload[newline + 1 :].strip():
                    raise ValueError("broker accepts exactly one request")
                return bytes(payload[:newline])
            if len(payload) > BROKER_REQUEST_LIMIT:
                raise ValueError("broker request exceeds 16 KiB")
        if len(payload) > BROKER_REQUEST_LIMIT:
            raise ValueError("broker request exceeds 16 KiB")
        return bytes(payload)

    def _dispatch(self, payload: bytes) -> dict[str, Any]:
        try:
            envelope = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return service_error_response(
                None, "invalid_envelope", "broker request must be one UTF-8 JSON object"
            )
        if not isinstance(envelope, dict) or envelope.get("v") != 1:
            return service_error_response(
                None, "invalid_envelope", "broker envelope.v must be 1"
            )
        supplied_token = envelope.get("token")
        if not isinstance(supplied_token, str) or not secrets.compare_digest(
            supplied_token, self.token
        ):
            return service_error_response(
                None, "unauthorized", "invalid broker token"
            )
        request = envelope.get("request")
        if not isinstance(request, dict):
            return service_error_response(
                None, "invalid_envelope", "broker envelope.request must be an object"
            )
        return self.service.execute_command(request)

    @staticmethod
    def _write_response(
        connection: socket.socket, response: dict[str, Any]
    ) -> None:
        try:
            payload = (
                json.dumps(response, separators=(",", ":"), allow_nan=False)
                + "\n"
            ).encode("utf-8")
            if len(payload) - 1 > BROKER_RESPONSE_LIMIT:
                payload = (
                    json.dumps(
                        service_error_response(
                            response.get("id"),
                            "response_too_large",
                            "broker response exceeds the 2 MiB limit",
                        ),
                        separators=(",", ":"),
                    )
                    + "\n"
                ).encode("utf-8")
            connection.sendall(payload)
        except (BrokenPipeError, OSError, ValueError):
            return

    def _serve_connection(self, connection: socket.socket) -> None:
        try:
            with connection:
                try:
                    payload = self._read_request(connection)
                    if not payload:
                        response = service_error_response(
                            None, "invalid_envelope", "empty broker request"
                        )
                    else:
                        response = self._dispatch(payload)
                except socket.timeout:
                    response = service_error_response(
                        None, "broker_timeout", "timed out reading broker request"
                    )
                except ValueError as error:
                    response = service_error_response(
                        None, "invalid_envelope", str(error)
                    )
                self._write_response(connection, response)
        finally:
            with self.workers_lock:
                self.workers.discard(threading.current_thread())
            self.worker_slots.release()

    def stop(self) -> None:
        self.stop_event.set()
        listener = self.listener
        if listener is not None:
            listener.close()
            self.listener = None
        if self.accept_thread is not None:
            self.accept_thread.join(timeout=1.0)
        with self.workers_lock:
            workers = list(self.workers)
        for worker in workers:
            worker.join(timeout=REQUEST_TIMEOUT_SECONDS + 1.0)
        self.token = ""
        self._unlink_created(self.token_path, self.token_identity)
        self._unlink_created(self.socket_path, self.socket_identity)
        self.token_identity = None
        self.socket_identity = None


class DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def handler_for(
    store: SnapshotStore,
    catalog_payload: bytes | None = None,
    recording_library: RecordingLibrary | None = None,
    signal_lab_feed: SignalLabFeed | None = None,
) -> type[BaseHTTPRequestHandler]:
    class DashboardHandler(BaseHTTPRequestHandler):
        server_version = "HydraDashboard/1"

        def do_GET(self) -> None:  # noqa: N802
            request_url = urlsplit(self.path)
            path = unquote(request_url.path)
            if path == "/api/snapshot":
                payload = json.dumps(
                    store.snapshot(), separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8", "no-store")
                return
            if path == "/api/observer/snapshot":
                requested_source = parse_qs(request_url.query).get(
                    "source", ["auto"]
                )[0]
                if requested_source not in {"auto", "signal-lab"}:
                    self._json_error(400, "invalid_observer_source")
                    return
                use_signal_lab = (
                    signal_lab_feed is not None
                    and (
                        requested_source == "signal-lab"
                        or signal_lab_feed.active()
                    )
                )
                snapshot = (
                    signal_lab_feed.snapshot()
                    if use_signal_lab and signal_lab_feed is not None
                    else store.snapshot()
                )
                snapshot["observer_source"] = {
                    "requested": requested_source,
                    "selected": "signal-lab" if use_signal_lab else "telemetry",
                }
                payload = json.dumps(
                    snapshot, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8", "no-store")
                return
            if path == "/api/signal-lab/snapshot":
                if signal_lab_feed is None:
                    self._json_error(404, "signal_lab_unavailable")
                    return
                payload = json.dumps(
                    signal_lab_feed.snapshot(),
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8", "no-store")
                return
            if path == "/api/catalog":
                if catalog_payload is None:
                    self._send(
                        404,
                        b'{"error":"catalog_unavailable"}',
                        "application/json; charset=utf-8",
                        "no-store",
                    )
                else:
                    self._send(
                        200,
                        catalog_payload,
                        "application/json; charset=utf-8",
                        "no-cache",
                    )
                return
            if path == "/api/recordings":
                if (
                    recording_library is not None
                    and parse_qs(request_url.query).get("refresh") == ["1"]
                ):
                    recording_library.refresh()
                payload = json.dumps(
                    (
                        recording_library.summary()
                        if recording_library is not None
                        else {"available": False, "directory": None, "recordings": []}
                    ),
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8", "no-store")
                return
            if path.startswith("/api/recordings/") and path.endswith(("/series", "/series-batch")):
                suffix = "/series-batch" if path.endswith("/series-batch") else "/series"
                recording_id = path[len("/api/recordings/") : -len(suffix)].strip("/")
                if recording_library is None or not recording_id:
                    self._json_error(404, "recording_not_found")
                    return
                parameters = parse_qs(request_url.query)
                channel = parameters.get("channel", [""])[0]
                field = parameters.get("field", [""])[0]
                reducer = parameters.get("reducer", ["mean"])[0]
                try:
                    if suffix == "/series-batch":
                        sources = json.loads(parameters.get("sources", ["[]"])[0])
                        series = {"series": recording_library.series_batch(recording_id, sources)}
                    else:
                        index = int(parameters.get("index", ["0"])[0])
                        limit = int(parameters.get("limit", ["720"])[0])
                        series = recording_library.series(
                            recording_id, channel, field, reducer=reducer, index=index, limit=limit,
                        )
                except KeyError as error:
                    self._json_error(404, str(error).strip("'"))
                    return
                except (OSError, TypeError, ValueError) as error:
                    self._json_error(400, str(error) or "invalid_series_request")
                    return
                payload = json.dumps(
                    series, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
                self._send(200, payload, "application/json; charset=utf-8", "no-store")
                return
            if path == "/favicon.ico":
                self._send(204, b"", "image/x-icon", "public, max-age=86400")
                return
            static_files = {
                "/": "index.html",
                "/index.html": "index.html",
                "/styles.css": "styles.css",
                "/app.js": "app.js",
                "/sonification.js": "sonification.js",
                "/parameters.js": "parameters.js",
                "/live.js": "live.js",
                "/drums.js": "drums.js",
                "/drum-workspace.js": "drum-workspace.js",
                "/observer": "observer/index.html",
                "/observer/": "observer/index.html",
                "/observer/index.html": "observer/index.html",
                "/observer/styles.css": "observer/styles.css",
                "/observer/app.js": "observer/app.js",
            }
            filename = static_files.get(path)
            if filename is None:
                self._send(404, b"Not found\n", "text/plain; charset=utf-8", "no-store")
                return
            target = DASHBOARD_DIR / filename
            try:
                payload = target.read_bytes()
            except OSError:
                self._send(
                    500,
                    b"Dashboard asset unavailable\n",
                    "text/plain; charset=utf-8",
                    "no-store",
                )
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if content_type.startswith(("text/", "application/javascript")):
                content_type += "; charset=utf-8"
            self._send(200, payload, content_type, "no-cache")

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_POST(self) -> None:  # noqa: N802
            path = unquote(urlsplit(self.path).path)
            if path == "/api/signal-lab/events":
                if signal_lab_feed is None:
                    self._json_error(404, "signal_lab_unavailable")
                    return
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    self._json_error(400, "invalid_content_length")
                    return
                if not 0 < content_length <= SIGNAL_LAB_REQUEST_LIMIT:
                    self._json_error(413, "signal_lab_payload_too_large")
                    return
                try:
                    document = json.loads(self.rfile.read(content_length))
                    response = signal_lab_feed.publish(document)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._json_error(400, "invalid_signal_lab_json")
                    return
                except ValueError as error:
                    self._json_error(400, str(error) or "invalid_signal_lab_event")
                    return
                payload = json.dumps(
                    response, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
                self._send(202, payload, "application/json; charset=utf-8", "no-store")
                return
            self._send(
                405,
                b'{"error":"read_only"}',
                "application/json; charset=utf-8",
                "no-store",
            )

        def _json_error(self, status: int, code: str) -> None:
            payload = json.dumps(
                {"error": code}, separators=(",", ":")
            ).encode("utf-8")
            self._send(
                status, payload, "application/json; charset=utf-8", "no-store"
            )

        def _send(
            self,
            status: int,
            payload: bytes,
            content_type: str,
            cache_control: str,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; "
                "style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
            )
            self.end_headers()
            if self.command != "HEAD" and payload:
                self.wfile.write(payload)

        def log_message(self, _format: str, *_arguments: Any) -> None:
            return

    return DashboardHandler


def host_is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def run_self_test() -> int:
    for filename in ("index.html", "styles.css", "app.js"):
        assert (DASHBOARD_DIR / filename).is_file(), filename
    catalog = ParameterCatalog.load()
    assert len(catalog.cc_by_number) == 117
    assert sum(len(entries) for entries in catalog.nrpn_by_number.values()) == 1032
    store = SnapshotStore("live", catalog)
    store.accept(
        {
            "v": 1,
            "type": "ready",
            "connected": True,
            "input_connected": True,
            "destination": "HYDRASYNTH",
            "source": "HYDRASYNTH",
        }
    )
    store.accept(
        {
            "v": 1,
            "type": "response",
            "id": "caps",
            "ok": True,
            "timbre_controls": [
                {"name": "cutoff", "number": 74},
                {"name": "filter1-cutoff", "number": 74},
            ],
        },
        "capabilities",
    )
    store.accept(
        {
            "v": 1,
            "type": "response",
            "id": "state",
            "ok": True,
            "state": {
                "uptime": 1.0,
                "event_sequence": 3,
                "takeover_seconds": 3.0,
                "patch": {"bank": "A", "number": 1},
                "cc": [
                    {
                        "channel": 1,
                        "number": 74,
                        "value": 96,
                        "source": "user",
                        "age": 0.5,
                    }
                ],
                "nrpn": [
                    {
                        "channel": 1,
                        "parameter": 123,
                        "value": 8192,
                        "resolution_bits": 14,
                        "source": "agent",
                        "age": 0.1,
                    }
                ],
                "active_notes": [{"channel": 1, "note": 60, "count": 1}],
            },
        },
        "state",
    )
    store.accept(
        {"v": 1, "type": "event", "event": "cc", "event_sequence": 1}
    )
    store.accept(
        {"v": 1, "type": "event", "event": "cc", "event_sequence": 5}
    )
    snapshot = store.snapshot()
    assert snapshot["bridge"]["sequence_gap"] is True
    assert snapshot["state"]["patch"] == {"bank": "A", "number": 1}
    assert len(snapshot["parameters"]) == 2
    cutoff = snapshot["parameters"][0]
    assert cutoff["key"] == "cc:1:74"
    assert cutoff["name"] == "filter1-cutoff"
    assert abs(cutoff["normalized"] - 96 / 127.0) < 1e-12
    assert 2.45 < cutoff["takeover_remaining"] <= 2.5
    assert snapshot["catalog"]["counts"]["cc_parameters"] == 117

    selected = catalog.decode_nrpn(
        channel=1,
        number=8081,
        raw_value=(1 << 7) | 70,
        source="user",
        age=0.0,
        resolution_bits=14,
    )
    assert len(selected) == 1
    assert selected[0]["catalog_id"] == "nrpn-08081-osc2-semi"
    assert selected[0]["value"] == 70
    assert selected[0]["display_value"] == -58
    assert abs(selected[0]["normalized"] - 70 / 127.0) < 1e-12

    packed = catalog.decode_nrpn(
        channel=1,
        number=7936,
        raw_value=(4 << 7) | 5,
        source="user",
        age=0.0,
        resolution_bits=14,
    )
    assert packed[0]["catalog_id"] == "nrpn-07936-modmatrix-1-target"
    assert packed[0]["value"] == 133
    collision = catalog.decode_nrpn(
        channel=1,
        number=8068,
        raw_value=(6 << 7) | 44,
        source="user",
        age=0.0,
        resolution_bits=14,
    )
    assert collision[0]["catalog_ambiguous"] is True
    assert len(collision[0]["catalog_ids"]) == 2
    assert catalog.decode_nrpn(
        channel=1,
        number=8081,
        raw_value=1 << 7,
        source="user",
        age=0.0,
        resolution_bits=7,
    ) == []
    assert catalog.decode_nrpn(
        channel=1,
        number=7936,
        raw_value=4 << 7,
        source="user",
        age=0.0,
        resolution_bits=7,
    ) == []

    stale_patch = SnapshotStore("live", catalog)
    stale_patch.accept(
        {
            "v": 1,
            "type": "event",
            "event": "patch",
            "event_sequence": 5,
            "bank": "B",
            "number": 2,
        }
    )
    stale_patch.accept(
        {
            "v": 1,
            "type": "response",
            "id": "stale-state",
            "ok": True,
            "state": {
                "event_sequence": 4,
                "patch": {"bank": "A", "number": 1},
                "cc": [
                    {
                        "channel": 1,
                        "number": 74,
                        "value": 100,
                        "source": "agent",
                    }
                ],
                "nrpn": [],
                "active_notes": [],
            },
        },
        "state",
    )
    stale_patch_snapshot = stale_patch.snapshot()
    assert stale_patch_snapshot["state"]["patch"] == {"bank": "B", "number": 2}
    assert stale_patch_snapshot["state"]["cc"] == []

    state_floor = SnapshotStore("live", catalog)
    state_floor.accept(
        {
            "v": 1,
            "type": "response",
            "id": "floor",
            "ok": True,
            "state": {
                "event_sequence": 10,
                "patch": {"bank": "A", "number": 1},
                "cc": [
                    {
                        "channel": 1,
                        "number": 74,
                        "value": 80,
                        "source": "agent",
                    }
                ],
                "nrpn": [],
                "active_notes": [{"channel": 1, "note": 60, "count": 1}],
            },
        },
        "state",
    )
    state_floor.accept(
        {
            "v": 1,
            "type": "event",
            "event": "note_on",
            "event_sequence": 9,
            "channel": 1,
            "note": 60,
            "velocity": 100,
        }
    )
    state_floor.accept(
        {
            "v": 1,
            "type": "event",
            "event": "cc",
            "event_sequence": 10,
            "channel": 1,
            "number": 74,
            "value": 12,
            "source": "agent",
        }
    )
    floor_snapshot = state_floor.snapshot()
    assert floor_snapshot["state"]["active_notes"][0]["count"] == 1
    assert floor_snapshot["state"]["cc"][0]["value"] == 80
    assert len(floor_snapshot["events"]) == 2

    transient_error = SnapshotStore("live", catalog)
    transient_error.accept(
        {
            "v": 1,
            "type": "response",
            "id": "failed",
            "ok": False,
            "error": {"code": "temporary"},
        },
        "status",
    )
    assert transient_error.error is not None
    transient_error.accept(
        {"v": 1, "type": "response", "id": "ok", "ok": True},
        "status",
    )
    assert transient_error.error is None
    demo = DemoService(SnapshotStore("demo", catalog))
    retained_source_number = DEMO_CONTROLS[0][1]
    demo.sources[retained_source_number] = "user"
    assert next(
        item
        for item in demo._cc_snapshot(time.monotonic())
        if item["number"] == retained_source_number
    )["source"] == "user"

    reduction = SnapshotStore("live", catalog)
    reduction.state["takeover_seconds"] = 3.0
    reduction.accept(
        {
            "v": 1,
            "type": "event",
            "event": "cc",
            "event_sequence": 1,
            "source": "user",
            "channel": 1,
            "number": 74,
            "value": 31,
        }
    )
    reduction.accept(
        {
            "v": 1,
            "type": "event",
            "event": "cc",
            "event_sequence": 2,
            "source": "agent",
            "channel": 1,
            "number": 74,
            "value": 99,
        }
    )
    reduced_cutoff = reduction.snapshot()["parameters"][0]
    assert reduced_cutoff["value"] == 99
    assert reduced_cutoff["source"] == "agent"
    assert reduced_cutoff["takeover_remaining"] > 2.9

    for sequence, selector in ((3, 0), (4, 1)):
        reduction.accept(
            {
                "v": 1,
                "type": "event",
                "event": "nrpn",
                "event_sequence": sequence,
                "source": "user",
                "channel": 1,
                "parameter": 8081,
                "value": (selector << 7) | (64 + selector),
                "resolution_bits": 14,
            }
        )
    logical_ids = {
        parameter.get("catalog_id")
        for parameter in reduction.snapshot()["parameters"]
    }
    assert "nrpn-08081-osc1-semi" in logical_ids
    assert "nrpn-08081-osc2-semi" in logical_ids

    for sequence in range(5, EVENT_HISTORY_LIMIT + 15):
        reduction.accept(
            {
                "v": 1,
                "type": "event",
                "event": "pitch_bend",
                "event_sequence": sequence,
                "source": "user",
                "channel": 1,
                "value": 8192,
            }
        )
    assert len(reduction.snapshot()["events"]) == EVENT_HISTORY_LIMIT

    live = LiveService(reduction, DEFAULT_HYDRACTL, None, 1, 3.0, False)
    live.pending["expired"] = PendingRequest(
        "state", time.monotonic() - 1.0
    )
    live._expire_pending()
    assert not live.pending
    assert reduction.snapshot()["bridge"]["request_timeouts"] == 1

    class FakeInput:
        def __init__(self) -> None:
            self.lines: list[str] = []

        def write(self, payload: str) -> int:
            self.lines.append(payload)
            return len(payload)

        def flush(self) -> None:
            return

    class FakeProcess:
        def __init__(self) -> None:
            self.stdin = FakeInput()

        def poll(self) -> None:
            return None

    correlation = LiveService(
        SnapshotStore("live", catalog), DEFAULT_HYDRACTL, None, 1, 3.0, False
    )
    fake_process = FakeProcess()
    correlation.process = fake_process  # type: ignore[assignment]
    command_result: list[dict[str, Any]] = []
    command_thread = threading.Thread(
        target=lambda: command_result.append(
            correlation.execute_command(
                {
                    "v": 1,
                    "id": 12.5,
                    "op": "timbre",
                    "name": "cutoff",
                    "value": 0.75,
                }
            )
        )
    )
    command_thread.start()
    deadline = time.monotonic() + 1.0
    while not fake_process.stdin.lines and time.monotonic() < deadline:
        time.sleep(0.005)
    assert fake_process.stdin.lines
    wire_request = json.loads(fake_process.stdin.lines[0])
    assert wire_request["id"] != 12.5
    correlation._accept_service_message(
        {
            "v": 1,
            "type": "response",
            "id": wire_request["id"],
            "ok": True,
            "number": 74,
            "value": 95,
        }
    )
    command_thread.join(timeout=1.0)
    assert not command_thread.is_alive()
    assert command_result[0]["id"] == 12.5
    assert command_result[0]["ok"] is True
    assert correlation.reconcile_event.is_set()
    oversized = correlation.execute_command(
        {
            "v": 1,
            "id": "large",
            "op": "ping",
            "padding": "x" * HYDRACTL_JSON_LINE_LIMIT,
        }
    )
    assert oversized["error"]["code"] == "request_too_large"
    forbidden = correlation.execute_command(
        {"v": 1, "id": "stop", "op": "shutdown"}
    )
    assert forbidden["error"]["code"] == "broker_forbidden"

    class FakeBrokerTarget:
        def execute_command(
            self, request: dict[str, Any]
        ) -> dict[str, Any]:
            return {
                "v": 1,
                "type": "response",
                "id": copy.deepcopy(request.get("id")),
                "ok": True,
                "operation": request.get("op"),
            }

    def broker_round_trip(path: Path, payload: bytes) -> dict[str, Any]:
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.settimeout(2.0)
        try:
            connection.connect(str(path))
            connection.sendall(payload + b"\n")
            response = bytearray()
            while b"\n" not in response:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                response.extend(chunk)
            return json.loads(bytes(response).split(b"\n", 1)[0])
        finally:
            connection.close()

    with tempfile.TemporaryDirectory(prefix="hydra-broker-test-") as directory:
        test_socket = Path(directory) / "broker.sock"
        test_token = Path(directory) / "broker.token"
        broker = CommandBroker(  # type: ignore[arg-type]
            FakeBrokerTarget(), test_socket, test_token
        )
        broker_started = False
        try:
            broker.start()
            broker_started = True
        except PermissionError:
            # Some execution sandboxes prohibit bind(AF_UNIX). Exercise the
            # authenticated dispatcher here; the external test uses the socket.
            broker.token = "self-test-secret"
            successful = broker._dispatch(
                b'{"v":1,"token":"self-test-secret",'
                b'"request":{"v":1,"id":"client-1","op":"state"}}'
            )
            unauthorized = broker._dispatch(
                b'{"v":1,"token":"wrong",'
                b'"request":{"v":1,"id":"x","op":"state"}}'
            )
        else:
            try:
                assert stat.S_IMODE(test_socket.lstat().st_mode) == 0o600
                assert stat.S_IMODE(test_token.lstat().st_mode) == 0o600
                test_secret = test_token.read_text(encoding="ascii").strip()
                successful = broker_round_trip(
                    test_socket,
                    json.dumps(
                        {
                            "v": 1,
                            "token": test_secret,
                            "request": {
                                "v": 1,
                                "id": "client-1",
                                "op": "state",
                            },
                        },
                        separators=(",", ":"),
                    ).encode("utf-8"),
                )
                unauthorized = broker_round_trip(
                    test_socket,
                    b'{"v":1,"token":"wrong",'
                    b'"request":{"v":1,"id":"x","op":"state"}}',
                )
                too_large = broker_round_trip(
                    test_socket, b"x" * (BROKER_REQUEST_LIMIT + 1)
                )
                assert too_large["error"]["code"] == "invalid_envelope"
            finally:
                broker.stop()
            assert not test_socket.exists()
            assert not test_token.exists()
        assert successful["id"] == "client-1"
        assert successful["ok"] is True
        assert unauthorized["error"]["code"] == "unauthorized"
        if not broker_started:
            broker.token = ""

    signal_feed = SignalLabFeed(catalog)
    published = signal_feed.publish(
        {
            "recording": "self-test.jsonl",
            "output": "audio",
            "progress": 0.25,
            "mapping_count": 2,
            "composite_count": 1,
            "cc": [{"number": 74, "value": 91}],
            "note": {"number": 60, "velocity": 96, "duration_ms": 100},
        }
    )
    assert published["accepted_controls"] == 1
    signal_snapshot = signal_feed.snapshot()
    assert signal_snapshot["bridge"]["mode"] == "signal-lab"
    assert signal_snapshot["signal_lab"]["active"] is True
    assert signal_snapshot["state"]["cc"][0]["value"] == 91
    assert signal_snapshot["state"]["active_notes"][0]["note"] == 60
    chord = [{"number": note, "velocity": 96, "duration_ms": 5000} for note in (60, 64, 67)]
    published = signal_feed.publish({"output": "midi", "patch": {"bank": "B", "number": 17},
                                     "notes": chord, "cc": [{"number": 74, "value": 72}]})
    assert published["accepted_notes"] == 3
    signal_snapshot = signal_feed.snapshot()
    assert signal_snapshot["state"]["patch"] == {"bank": "B", "number": 17}
    assert {item["note"] for item in signal_snapshot["state"]["active_notes"]} == {60, 64, 67}
    signal_feed.publish({"output": "midi", "patch": {"bank": "B", "number": 17}})
    assert signal_feed.snapshot()["state"]["cc"][0]["value"] == 72, "same patch must preserve parameter state"
    try:
        signal_feed.publish({"notes": chord * 3})
        raise AssertionError("oversized chords must be rejected")
    except ValueError:
        pass
    signal_feed.publish({"stop": True, "notes": chord})
    assert not signal_feed.snapshot()["state"]["active_notes"]
    signal_feed.publish({"output": "audio", "patch": None, "voice_name": "Bell", "notes": chord})
    assert signal_feed.snapshot()["signal_lab"]["voice_name"] == "Bell"
    assert signal_feed.snapshot()["state"]["patch"]["number"] is None
    published = signal_feed.publish({"nrpn": [{"number": 8097, "value": 1}, {"number": 8097, "value": 130},
                                               {"number": 99999, "value": 0}],
                                     "destination_count": 256, "source_mode": "live"})
    assert published["accepted_controls"] == 2
    assert signal_feed.snapshot()["state"]["nrpn"][-1]["value"] == 130
    assert signal_feed.snapshot()["signal_lab"]["destination_count"] == 256
    try:
        signal_feed.publish({"nrpn": [{}] * 65})
        raise AssertionError("oversized parameter batches must be rejected")
    except ValueError:
        pass
    drum_values = {"activity": 0.65, "tempo": 122.5, "density": 70, "style": "broken", "kit": "warehouse"}
    published = signal_feed.publish({
        "output": "drums", "voice_name": "Warehouse", "patch": None,
        "drums": {**drum_values, "unexpected": ["discard"]},
        "notes": [{"number": note, "velocity": 90, "duration_ms": 150} for note in (36, 38, 42)],
    })
    assert published["accepted_notes"] == 3
    drum_snapshot = signal_feed.snapshot()
    assert drum_snapshot["signal_lab"]["output"] == "electronic drums"
    assert drum_snapshot["signal_lab"]["drums"] == drum_values
    assert drum_snapshot["bridge"]["destination"] == "ELECTRONIC DRUMS"
    assert drum_snapshot["state"]["patch"]["number"] is None
    assert not drum_snapshot["state"]["cc"] and not drum_snapshot["state"]["nrpn"]
    assert {item["note"] for item in drum_snapshot["state"]["active_notes"]} == {36, 38, 42}
    signal_feed.publish({"drums": {
        "activity": float("nan"), "tempo": 9999, "density": -1,
        "style": "unknown", "kit": ["electro"], "extra": "discard",
    }})
    assert signal_feed.snapshot()["signal_lab"]["drums"] == drum_values
    signal_feed.publish({"drums": {"activity": True, "tempo": "120", "density": float("inf")}})
    assert signal_feed.snapshot()["signal_lab"]["drums"] == drum_values
    signal_feed.publish({"drums": {"activity": 10 ** 400, "tempo": -10 ** 400, "density": 10 ** 400}})
    assert signal_feed.snapshot()["signal_lab"]["drums"] == drum_values
    signal_feed.publish({"drums": [1, 2, 3]})
    assert signal_feed.snapshot()["signal_lab"]["drums"] == drum_values
    signal_feed.publish({"drums": {"activity": 0, "tempo": 20, "density": 0, "style": "straight", "kit": "electro"}})
    assert signal_feed.snapshot()["signal_lab"]["drums"]["activity"] == 0
    signal_feed.publish({"drums": {"activity": 1, "tempo": 240, "density": 100, "style": "half", "kit": "minimal"}})
    assert signal_feed.snapshot()["signal_lab"]["drums"]["density"] == 100
    signal_feed.publish({"stop": True})
    assert not signal_feed.snapshot()["state"]["active_notes"]
    signal_feed.publish({"output": "audio", "voice_name": "Glass"})
    assert "drums" not in signal_feed.snapshot()["signal_lab"]
    assert signal_feed.snapshot()["signal_lab"]["output"] == "browser audio"
    signal_feed.publish({"output": "midi", "patch": {"bank": "C", "number": 9}})
    assert signal_feed.snapshot()["state"]["patch"] == {"bank": "C", "number": 9}
    assert handler_for(store, b"{}", signal_lab_feed=signal_feed)
    print("hydra-dashboard self-test: ok")
    return 0


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Serve a read-only Hydrasynth telemetry dashboard with an optional "
            "authenticated local Unix command broker."
        )
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument(
        "--recordings-dir",
        type=Path,
        help=(
            "RAPP JSONL recordings directory. Defaults to RAPP_RECORDINGS_DIR "
            "or a recognised sibling repository."
        ),
    )
    parser.add_argument("--hydractl", type=Path, default=DEFAULT_HYDRACTL)
    parser.add_argument("--device")
    parser.add_argument("--channel", type=int, default=1)
    parser.add_argument("--takeover", type=float, default=3.0)
    parser.add_argument("--no-input", action="store_true")
    parser.add_argument("--no-broker", action="store_true")
    parser.add_argument(
        "--broker-socket", type=Path, default=DEFAULT_BROKER_SOCKET
    )
    parser.add_argument(
        "--broker-token-file", type=Path, default=DEFAULT_BROKER_TOKEN
    )
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args(argv)
    if not 1 <= arguments.port <= 65535:
        parser.error("--port must be from 1 to 65535")
    if not 1 <= arguments.channel <= 16:
        parser.error("--channel must be from 1 to 16")
    if not 0 <= arguments.takeover <= 3600:
        parser.error("--takeover must be from 0 to 3600 seconds")
    if not arguments.allow_remote and not host_is_loopback(arguments.host):
        parser.error("non-loopback --host requires explicit --allow-remote")
    return arguments


def main(argv: list[str] | None = None) -> int:
    arguments = parse_arguments(sys.argv[1:] if argv is None else argv)
    if arguments.self_test:
        return run_self_test()
    try:
        catalog = ParameterCatalog.load()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        catalog = None
        print(f"warning: parameter catalog unavailable: {error}", file=sys.stderr)
    recordings_directory = (
        arguments.recordings_dir.expanduser().resolve()
        if arguments.recordings_dir is not None
        else default_recordings_directory(PROJECT_ROOT)
    )
    recording_library = RecordingLibrary(recordings_directory)
    store = SnapshotStore("demo" if arguments.demo else "live", catalog)
    signal_lab_feed = SignalLabFeed(catalog)
    service: DemoService | LiveService
    if arguments.demo:
        service = DemoService(store)
    else:
        service = LiveService(
            store,
            arguments.hydractl.resolve(),
            arguments.device,
            arguments.channel,
            arguments.takeover,
            arguments.no_input,
        )
    service_started = False
    try:
        service.start()
    except (OSError, ValueError) as error:
        store.set_error(str(error))
    else:
        service_started = True

    broker: CommandBroker | None = None
    if (
        not arguments.demo
        and not arguments.no_broker
        and service_started
        and isinstance(service, LiveService)
    ):
        broker = CommandBroker(
            service,
            arguments.broker_socket,
            arguments.broker_token_file,
        )
        try:
            broker.start()
        except (OSError, ValueError) as error:
            service.stop()
            print(f"error: unable to start command broker: {error}", file=sys.stderr)
            return 1

    stop_event = threading.Event()

    def request_stop(_signal_number: int, _frame: Any) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    try:
        catalog_payload = (
            json.dumps(
                catalog.document, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
            if catalog is not None
            else None
        )
        server = DashboardHTTPServer(
            (arguments.host, arguments.port),
            handler_for(
                store,
                catalog_payload,
                recording_library,
                signal_lab_feed,
            ),
        )
    except OSError as error:
        if broker is not None:
            broker.stop()
        service.stop()
        print(f"error: unable to listen on {arguments.host}:{arguments.port}: {error}", file=sys.stderr)
        return 1
    server.timeout = 0.4
    print(
        f"Hydrasynth dashboard: http://{arguments.host}:{arguments.port}"
        f" ({'demo' if arguments.demo else 'live'})",
        flush=True,
    )
    if recording_library.available:
        print(
            f"RAPP recordings: {recording_library.directory} "
            f"({len(recording_library.recordings)} files)",
            flush=True,
        )
    else:
        print(
            "RAPP recordings: not found; use --recordings-dir or "
            "RAPP_RECORDINGS_DIR",
            file=sys.stderr,
            flush=True,
        )
    if broker is not None:
        print(
            f"Hydrasynth command broker: {broker.socket_path} "
            f"(token file {broker.token_path})",
            flush=True,
        )
    if arguments.allow_remote and not host_is_loopback(arguments.host):
        print(
            "warning: remote HTTP telemetry is unauthenticated and unencrypted; "
            "the command broker remains local AF_UNIX only",
            file=sys.stderr,
            flush=True,
        )
    try:
        while not stop_event.is_set():
            server.handle_request()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if broker is not None:
            broker.stop()
        service.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
