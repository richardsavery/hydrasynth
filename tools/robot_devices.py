"""Read-only discovery of the robot's USB adapters across computers.

The portable profile binds each role to a USB identity, never a host-specific
port name. Enumeration reads operating-system metadata; it does not connect to
serial ports, probe motors, or enable torque.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
from typing import Any


DEFAULT_PROFILE_PATH = Path(__file__).resolve().parent.parent / "config" / "robot-devices.json"
DEVICE_PATTERN = re.compile(
    r"(?:/dev/(?:(?:cu|tty)\.(?:usbserial|usbmodem)[A-Za-z0-9_.-]*"
    r"|tty(?:USB|ACM)[0-9]+)|(?i:COM)[1-9][0-9]*)"
)
_FIELDS = ("device", "vid", "pid", "serial_number", "description", "manufacturer", "product", "location")
_IDENTITY_FIELDS = {"vid", "pid", "serial_number"}
_BAUDRATES = (57_600, 115_200, 1_000_000, 2_000_000, 3_000_000, 4_000_000)
_MAX_PROFILE_BYTES = 64 * 1024


def connection_key(device: str | None) -> str | None:
    """Canonicalize POSIX symlinks, macOS aliases, and Windows COM casing."""
    if not isinstance(device, str) or not device:
        return None
    if re.fullmatch(r"COM[1-9][0-9]*", device, re.IGNORECASE):
        return device.upper()
    if os.name == "posix" and device.startswith("/"):
        device = os.path.realpath(device)
    if device.startswith("/dev/tty."):
        return "/dev/cu." + device[len("/dev/tty."):]
    return device


def validate_identity(value: Any) -> dict[str, Any]:
    """Return an exact, complete USB identity or raise ValueError.

    Description and physical USB location are intentionally excluded: neither
    identifies an adapter reliably after moving it to a different computer.
    """
    if not isinstance(value, dict) or set(value) != _IDENTITY_FIELDS:
        raise ValueError("A USB identity must contain exactly vid, pid, and serial_number.")
    for field in ("vid", "pid"):
        if type(value[field]) is not int or not 0 <= value[field] <= 0xFFFF:
            raise ValueError(f"USB {field} must be an integer from 0 to 65535.")
    serial = value["serial_number"]
    if (not isinstance(serial, str) or not serial.strip() or len(serial) > 256
            or any(ord(char) < 32 or ord(char) == 127 for char in serial)):
        raise ValueError("USB serial_number must be a nonempty printable string.")
    return {"vid": value["vid"], "pid": value["pid"], "serial_number": serial}


def _identity(row: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return validate_identity({field: row.get(field) for field in _IDENTITY_FIELDS})
    except ValueError:
        return None


def _deduplicate_ports(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for row in rows:
        device = row.get("device")
        if not isinstance(device, str) or not DEVICE_PATTERN.fullmatch(device):
            continue
        key = connection_key(device)
        normalized = {field: row.get(field) for field in _FIELDS}
        if re.fullmatch(r"COM[1-9][0-9]*", device, re.IGNORECASE):
            normalized["device"] = device.upper()
        previous = selected.get(key)
        # macOS's cu and tty entries address the same adapter. Prefer cu for an
        # outgoing connection regardless of the OS enumeration order.
        if previous is None or (device.startswith("/dev/cu.")
                                and not previous["device"].startswith("/dev/cu.")):
            selected[key] = normalized
    return sorted(selected.values(), key=lambda row: row["device"])


def _enumerate_port_metadata() -> list[dict[str, Any]]:
    from serial.tools import list_ports

    return [{field: getattr(port, field, None) for field in _FIELDS}
            for port in list_ports.comports()]


def _discover() -> tuple[list[dict[str, Any]], str | None]:
    try:
        return _deduplicate_ports(_enumerate_port_metadata()), None
    except Exception as error:
        return [], f"USB discovery is unavailable: {error}. Install requirements-robot.txt if needed."


def serial_ports() -> list[dict[str, Any]]:
    """List supported serial ports and USB metadata without opening devices.

    A missing optional pySerial dependency or OS enumeration failure produces
    an empty list. Use resolve_identity() for a diagnostic discovery result.
    """
    return _discover()[0]


def _result(state: str, identity: dict[str, Any] | None, message: str,
            device: str | None = None) -> dict[str, Any]:
    return {"state": state, "device": device, "identity": identity, "message": message}


def resolve_identity(identity: Any, ports: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Resolve a complete identity to exactly one current port, failing closed."""
    try:
        identity = validate_identity(identity)
    except ValueError as error:
        return _result("unavailable", None, str(error))
    if ports is None:
        ports, error = _discover()
        if error:
            return _result("unavailable", identity, error)
    else:
        ports = _deduplicate_ports(ports)
    matches = [row for row in ports if _identity(row) == identity]
    if not matches:
        return _result("missing", identity, "The saved USB adapter is not connected or its USB identity is unavailable.")
    if len(matches) > 1:
        return _result("ambiguous", identity, "More than one port has the saved USB identity; choose and check a port explicitly.")
    device = matches[0]["device"]
    return _result("matched", identity, f"Found the saved USB adapter at {device}.", device)


def device_identity(device: str | None, ports: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """Return an adapter identity only when it uniquely resolves to this port."""
    if not isinstance(device, str) or not DEVICE_PATTERN.fullmatch(device):
        return None
    ports = serial_ports() if ports is None else _deduplicate_ports(ports)
    rows = [row for row in ports if connection_key(row["device"]) == connection_key(device)]
    if len(rows) != 1:
        return None
    identity = _identity(rows[0])
    if identity is None or resolve_identity(identity, ports)["state"] != "matched":
        return None
    return identity


def _read_profile(profile_path: str | Path) -> dict[str, dict[str, Any]]:
    with Path(profile_path).open("rb") as handle:
        content = handle.read(_MAX_PROFILE_BYTES + 1)
    if len(content) > _MAX_PROFILE_BYTES:
        raise ValueError("USB device profile must not exceed 64 KiB.")
    document = json.loads(content.decode("utf-8"))
    if (not isinstance(document, dict) or set(document) != {"version", "devices"}
            or type(document["version"]) is not int or document["version"] != 1
            or not isinstance(document["devices"], dict) or not document["devices"]):
        raise ValueError("USB device profile must have version 1 and a devices object.")
    devices = {}
    identities = set()
    for group, entry in document["devices"].items():
        if not isinstance(group, str) or not group:
            raise ValueError("Each USB device profile needs a role name.")
        if not isinstance(entry, dict) or set(entry) != {"identity", "baudrate", "label"}:
            raise ValueError(f"USB device profile for {group} needs identity, baudrate, and label.")
        identity = validate_identity(entry["identity"])
        identity_key = (identity["vid"], identity["pid"], identity["serial_number"])
        if identity_key in identities:
            raise ValueError("The same USB identity cannot be assigned to multiple robot roles.")
        identities.add(identity_key)
        if type(entry["baudrate"]) is not int or entry["baudrate"] not in _BAUDRATES:
            raise ValueError(f"USB device profile for {group} has an unsupported baudrate.")
        if group == "ribs" and entry["baudrate"] != 1_000_000:
            raise ValueError("USB device profile for ribs must use the fixed baudrate of 1000000.")
        if not isinstance(entry["label"], str) or not entry["label"].strip():
            raise ValueError(f"USB device profile for {group} needs a nonempty label.")
        devices[group] = {"identity": identity, "baudrate": entry["baudrate"], "label": entry["label"]}
    return devices


def preferred_connection(group: str, ports: list[dict[str, Any]] | None = None,
                         profile_path: str | Path = DEFAULT_PROFILE_PATH) -> dict[str, Any]:
    """Resolve a robot role from the portable profile without connecting to it."""
    try:
        devices = _read_profile(profile_path)
        entry = devices.get(group)
        if entry is None:
            raise ValueError(f"No USB identity is configured for {group}.")
    except (OSError, ValueError, TypeError, UnicodeError) as error:
        return {**_result("unavailable", None, f"USB device profile is unavailable: {error}"),
                "baudrate": None, "label": None}
    return {**resolve_identity(entry["identity"], ports),
            "baudrate": entry["baudrate"], "label": entry["label"]}


def main() -> None:
    parser = argparse.ArgumentParser(description="Show USB metadata and robot adapter matches without opening serial ports.")
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE_PATH,
                        help="Portable robot device profile (default: config/robot-devices.json).")
    args = parser.parse_args()
    ports, error = _discover()
    devices = {group: preferred_connection(group, ports, args.profile) for group in ("head", "ribs", "drums")}
    if error:
        for result in devices.values():
            if result["state"] == "missing":
                result.update(state="unavailable", message=error)
    print(json.dumps({"ports": ports, "devices": devices, "discovery_error": error}, indent=2))


if __name__ == "__main__":
    main()
