#!/usr/bin/env python3
"""Validate the machine-readable Hydrasynth parameter catalog."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / "data" / "hydrasynth_parameters.json"
EXPECTED_CC_COUNT = 117
EXPECTED_NRPN_COUNT = 1032
EXPECTED_STITCHED_ROW_COUNT = 464
VALUE_KINDS = {
    "range",
    "enum",
    "bipolar",
    "signed_wrap",
    "selected_byte",
    "packed_index",
    "enum_reference",
    "context_dependent",
    "curve",
}


class CatalogError(Exception):
    """Raised when catalog validation fails."""


def require(condition: bool, errors: list[str], message: str) -> None:
    if not condition:
        errors.append(message)


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def require_keys(
    value: Any,
    keys: set[str],
    errors: list[str],
    location: str,
) -> bool:
    if not isinstance(value, dict):
        errors.append(f"{location}: expected object")
        return False
    missing = keys - set(value)
    if missing:
        errors.append(f"{location}: missing keys {sorted(missing)}")
        return False
    return True


def validate_items(
    items: Any,
    errors: list[str],
    location: str,
    raw_min: int | None = None,
    raw_max: int | None = None,
) -> None:
    if not isinstance(items, list) or not items:
        errors.append(f"{location}: items must be a non-empty list")
        return
    values: list[int] = []
    for index, item in enumerate(items):
        item_location = f"{location}[{index}]"
        if not require_keys(item, {"value", "label"}, errors, item_location):
            continue
        value = item["value"]
        label = item["label"]
        require(is_int(value), errors, f"{item_location}.value: expected integer")
        require(
            isinstance(label, str) and bool(label),
            errors,
            f"{item_location}.label: expected non-empty string",
        )
        if is_int(value):
            values.append(value)
    if len(values) == len(items):
        expected_start = raw_min if raw_min is not None else values[0]
        expected = list(range(expected_start, expected_start + len(values)))
        require(
            values == expected,
            errors,
            f"{location}: values must be consecutive in document order",
        )
        if raw_max is not None:
            require(
                values[-1] == raw_max,
                errors,
                f"{location}: final value must equal raw_max",
            )


def validate_resolution(value: dict[str, Any], errors: list[str], location: str) -> None:
    resolution = value.get("resolution_bits")
    require(
        is_int(resolution) and 1 <= resolution <= 14,
        errors,
        f"{location}.resolution_bits: expected integer from 1 through 14",
    )


def validate_raw_range(
    value: dict[str, Any],
    errors: list[str],
    location: str,
    *,
    allow_null: bool = False,
    maximum: int = 16383,
) -> None:
    raw_min = value.get("raw_min")
    raw_max = value.get("raw_max")
    if allow_null and raw_min is None and raw_max is None:
        return
    require(is_int(raw_min), errors, f"{location}.raw_min: expected integer")
    require(is_int(raw_max), errors, f"{location}.raw_max: expected integer")
    if is_int(raw_min) and is_int(raw_max):
        require(
            0 <= raw_min <= raw_max <= maximum,
            errors,
            f"{location}: invalid raw range {raw_min!r}..{raw_max!r}",
        )


def validate_value(
    value: Any,
    errors: list[str],
    location: str,
    rhythm_lists: dict[str, Any],
) -> None:
    if not require_keys(value, {"kind", "resolution_bits"}, errors, location):
        return
    kind = value["kind"]
    require(kind in VALUE_KINDS, errors, f"{location}.kind: unsupported {kind!r}")
    validate_resolution(value, errors, location)

    if kind == "range":
        validate_raw_range(value, errors, location)
    elif kind == "enum":
        validate_raw_range(value, errors, location)
        validate_items(
            value.get("items"),
            errors,
            f"{location}.items",
            value.get("raw_min"),
            value.get("raw_max"),
        )
    elif kind == "bipolar":
        required = {
            "raw_min",
            "raw_center",
            "raw_max",
            "display_min",
            "display_center",
            "display_max",
        }
        require_keys(value, required, errors, location)
        validate_raw_range(value, errors, location)
        if all(is_int(value.get(key)) for key in required):
            require(
                value["raw_min"] <= value["raw_center"] <= value["raw_max"],
                errors,
                f"{location}: raw center is outside the raw range",
            )
            require(
                value["display_min"]
                <= value["display_center"]
                <= value["display_max"],
                errors,
                f"{location}: display center is outside the display range",
            )
    elif kind == "signed_wrap":
        required = {"raw_min", "raw_max", "pivot", "subtract_above_pivot"}
        require_keys(value, required, errors, location)
        validate_raw_range(value, errors, location)
        if is_int(value.get("pivot")) and is_int(value.get("raw_max")):
            require(
                value["raw_min"] <= value["pivot"] <= value["raw_max"],
                errors,
                f"{location}: pivot is outside the raw range",
            )
    elif kind == "selected_byte":
        required = {
            "selector_byte",
            "selector_values",
            "value_byte",
            "raw_min",
            "raw_max",
        }
        require_keys(value, required, errors, location)
        require(
            value.get("selector_byte") == "data_msb",
            errors,
            f"{location}.selector_byte: expected data_msb",
        )
        require(
            value.get("value_byte") == "data_lsb",
            errors,
            f"{location}.value_byte: expected data_lsb",
        )
        selectors = value.get("selector_values")
        require(
            isinstance(selectors, list) and bool(selectors),
            errors,
            f"{location}.selector_values: expected non-empty list",
        )
        if isinstance(selectors, list):
            require(
                all(is_int(item) and 0 <= item <= 127 for item in selectors),
                errors,
                f"{location}.selector_values: values must be 7-bit integers",
            )
            require(
                len(selectors) == len(set(selectors)),
                errors,
                f"{location}.selector_values: duplicate selector",
            )
        validate_raw_range(value, errors, location, allow_null=True, maximum=128)
        if value.get("raw_max") == 128:
            require(
                value.get("documented_out_of_7bit_range") is True,
                errors,
                f"{location}: raw_max 128 must be flagged as documented anomaly",
            )
        if "items" in value:
            validate_items(
                value["items"],
                errors,
                f"{location}.items",
                value.get("raw_min"),
                value.get("raw_max"),
            )
    elif kind == "packed_index":
        required = {"prefix_byte", "value_byte", "segments"}
        if require_keys(value, required, errors, location):
            require(
                value["prefix_byte"] == "data_msb",
                errors,
                f"{location}.prefix_byte: expected data_msb",
            )
            require(
                value["value_byte"] == "data_lsb",
                errors,
                f"{location}.value_byte: expected data_lsb",
            )
            segments = value["segments"]
            require(
                isinstance(segments, list) and bool(segments),
                errors,
                f"{location}.segments: expected non-empty list",
            )
            prefixes: list[int] = []
            if isinstance(segments, list):
                for index, segment in enumerate(segments):
                    segment_location = f"{location}.segments[{index}]"
                    if not require_keys(
                        segment, {"prefix", "offset"}, errors, segment_location
                    ):
                        continue
                    require(
                        is_int(segment["prefix"]) and 0 <= segment["prefix"] <= 127,
                        errors,
                        f"{segment_location}.prefix: expected 7-bit integer",
                    )
                    require(
                        is_int(segment["offset"]) and segment["offset"] >= 0,
                        errors,
                        f"{segment_location}.offset: expected non-negative integer",
                    )
                    if is_int(segment["prefix"]):
                        prefixes.append(segment["prefix"])
                require(
                    len(prefixes) == len(set(prefixes)),
                    errors,
                    f"{location}.segments: duplicate prefix",
                )
    elif kind == "enum_reference":
        enum_name = value.get("enum")
        require(
            isinstance(enum_name, str) and enum_name in rhythm_lists,
            errors,
            f"{location}.enum: unknown rhythm-list reference {enum_name!r}",
        )
    elif kind == "context_dependent":
        require(
            isinstance(value.get("dependency"), str) and bool(value["dependency"]),
            errors,
            f"{location}.dependency: expected non-empty string",
        )
    elif kind == "curve":
        validate_raw_range(value, errors, location)
        anchors = value.get("anchors")
        require(
            isinstance(anchors, list) and len(anchors) >= 2,
            errors,
            f"{location}.anchors: expected at least two anchors",
        )
        if isinstance(anchors, list):
            raw_values: list[int] = []
            for index, anchor in enumerate(anchors):
                anchor_location = f"{location}.anchors[{index}]"
                if not require_keys(
                    anchor, {"raw", "label", "display"}, errors, anchor_location
                ):
                    continue
                require(
                    is_int(anchor["raw"]),
                    errors,
                    f"{anchor_location}.raw: expected integer",
                )
                require(
                    isinstance(anchor["label"], str) and bool(anchor["label"]),
                    errors,
                    f"{anchor_location}.label: expected non-empty string",
                )
                require(
                    isinstance(anchor["display"], (int, float))
                    and not isinstance(anchor["display"], bool),
                    errors,
                    f"{anchor_location}.display: expected number",
                )
                if is_int(anchor["raw"]):
                    raw_values.append(anchor["raw"])
            require(
                raw_values == sorted(set(raw_values)),
                errors,
                f"{location}.anchors: raw positions must be unique and sorted",
            )


def decoder_tokens(entry: dict[str, Any]) -> set[str]:
    number = entry["address"]["number"]
    value = entry["value"]
    if value["kind"] == "selected_byte":
        return {
            f"{number}:selector:{selector}"
            for selector in value["selector_values"]
        }
    if value["kind"] == "packed_index":
        return {
            f"{number}:prefix:{segment['prefix']}"
            for segment in value["segments"]
        }
    return {f"{number}:direct"}


def validate_catalog(catalog: Any) -> dict[str, int]:
    errors: list[str] = []
    root_keys = {
        "schema_version",
        "catalog_version",
        "specification",
        "compatibility",
        "rhythm_lists",
        "source_ambiguities",
        "counts",
        "cc_parameters",
        "nrpn_parameters",
    }
    if not require_keys(catalog, root_keys, errors, "catalog"):
        raise CatalogError("\n".join(errors))

    require(catalog["schema_version"] == 1, errors, "schema_version: expected 1")
    require(
        catalog["catalog_version"] == "1.0.0",
        errors,
        "catalog_version: expected 1.0.0",
    )

    specification = catalog["specification"]
    specification_keys = {
        "title",
        "firmware_version",
        "document_version",
        "document_filename",
        "document_pages",
        "sha256",
        "official_landing_url",
        "official_direct_url",
        "document_models",
        "default_nrpn_value",
    }
    if require_keys(specification, specification_keys, errors, "specification"):
        require(
            specification["firmware_version"] == "1.5",
            errors,
            "specification.firmware_version: expected 1.5",
        )
        require(
            specification["document_version"] == "1.5.0",
            errors,
            "specification.document_version: expected 1.5.0",
        )
        require(
            specification["document_pages"] == 31,
            errors,
            "specification.document_pages: expected 31",
        )
        require(
            isinstance(specification["sha256"], str)
            and bool(re.fullmatch(r"[0-9a-f]{64}", specification["sha256"])),
            errors,
            "specification.sha256: expected lowercase SHA-256",
        )
        require(
            str(specification["official_landing_url"]).startswith(
                "https://www.ashunsoundmachines.com/"
            ),
            errors,
            "specification.official_landing_url: expected official ASM domain",
        )
        require(
            str(specification["official_direct_url"]).startswith(
                "https://www.mecldata.com/download/asm/"
            ),
            errors,
            "specification.official_direct_url: expected official ASM download host",
        )

    compatibility = catalog["compatibility"]
    if require_keys(
        compatibility,
        {
            "catalog_basis",
            "explorer_firmware_2_2_officially_covered",
            "explorer_firmware_2_2_runtime_verified",
            "risk",
        },
        errors,
        "compatibility",
    ):
        require(
            compatibility["explorer_firmware_2_2_officially_covered"] is False,
            errors,
            "compatibility: legacy spec must not claim official Explorer 2.2 coverage",
        )
        require(
            compatibility["explorer_firmware_2_2_runtime_verified"] is False,
            errors,
            "compatibility: catalog must not claim unperformed runtime verification",
        )

    rhythm_lists = catalog["rhythm_lists"]
    if not isinstance(rhythm_lists, dict):
        errors.append("rhythm_lists: expected object")
        rhythm_lists = {}
    else:
        require(
            set(rhythm_lists) == {"arp", "vibrato", "env_lfo", "lfo_rate"},
            errors,
            "rhythm_lists: unexpected named lists",
        )
        for name, rhythm in rhythm_lists.items():
            location = f"rhythm_lists.{name}"
            if require_keys(rhythm, {"index_origin", "items"}, errors, location):
                require(
                    rhythm["index_origin"] == 0,
                    errors,
                    f"{location}.index_origin: expected 0",
                )
                validate_items(rhythm["items"], errors, f"{location}.items", 0)

    counts = catalog["counts"]
    if require_keys(
        counts,
        {
            "cc_parameters",
            "nrpn_table_rows_after_page_stitching",
            "nrpn_parameters_after_range_and_selector_expansion",
        },
        errors,
        "counts",
    ):
        require(
            counts["cc_parameters"] == EXPECTED_CC_COUNT,
            errors,
            f"counts.cc_parameters: expected {EXPECTED_CC_COUNT}",
        )
        require(
            counts["nrpn_table_rows_after_page_stitching"]
            == EXPECTED_STITCHED_ROW_COUNT,
            errors,
            "counts.nrpn_table_rows_after_page_stitching: unexpected value",
        )
        require(
            counts["nrpn_parameters_after_range_and_selector_expansion"]
            == EXPECTED_NRPN_COUNT,
            errors,
            "counts.nrpn_parameters_after_range_and_selector_expansion: "
            "unexpected value",
        )

    cc_parameters = catalog["cc_parameters"]
    nrpn_parameters = catalog["nrpn_parameters"]
    require(
        isinstance(cc_parameters, list),
        errors,
        "cc_parameters: expected list",
    )
    require(
        isinstance(nrpn_parameters, list),
        errors,
        "nrpn_parameters: expected list",
    )
    if not isinstance(cc_parameters, list):
        cc_parameters = []
    if not isinstance(nrpn_parameters, list):
        nrpn_parameters = []
    require(
        len(cc_parameters) == EXPECTED_CC_COUNT,
        errors,
        f"cc_parameters: expected {EXPECTED_CC_COUNT} entries",
    )
    require(
        len(nrpn_parameters) == EXPECTED_NRPN_COUNT,
        errors,
        f"nrpn_parameters: expected {EXPECTED_NRPN_COUNT} entries",
    )

    cc_ids: set[str] = set()
    cc_numbers: set[int] = set()
    cc_nrpn_links: dict[int, set[str]] = defaultdict(set)
    for index, parameter in enumerate(cc_parameters):
        location = f"cc_parameters[{index}]"
        required = {"id", "name", "group", "number", "value", "source"}
        if not require_keys(parameter, required, errors, location):
            continue
        parameter_id = parameter["id"]
        number = parameter["number"]
        require(
            isinstance(parameter_id, str)
            and bool(re.fullmatch(r"cc-\d{3}-[a-z0-9-]+", parameter_id)),
            errors,
            f"{location}.id: invalid stable ID",
        )
        require(
            parameter_id not in cc_ids,
            errors,
            f"{location}.id: duplicate {parameter_id!r}",
        )
        if isinstance(parameter_id, str):
            cc_ids.add(parameter_id)
        require(
            is_int(number) and 0 <= number <= 127,
            errors,
            f"{location}.number: expected 7-bit integer",
        )
        if is_int(number):
            require(
                number not in cc_numbers,
                errors,
                f"{location}.number: duplicate CC {number}",
            )
            cc_numbers.add(number)
        require(
            isinstance(parameter["name"], str) and bool(parameter["name"]),
            errors,
            f"{location}.name: expected non-empty string",
        )
        require(
            isinstance(parameter["group"], str) and bool(parameter["group"]),
            errors,
            f"{location}.group: expected non-empty string",
        )
        validate_value(parameter["value"], errors, f"{location}.value", rhythm_lists)
        value = parameter["value"]
        if isinstance(value, dict):
            require(
                value.get("kind") == "range"
                and value.get("raw_min") == 0
                and value.get("raw_max") == 127
                and value.get("resolution_bits") == 7,
                errors,
                f"{location}.value: CC values must be the 7-bit range",
            )
        links = parameter.get("nrpn_equivalents", [])
        require(
            isinstance(links, list),
            errors,
            f"{location}.nrpn_equivalents: expected list",
        )
        if isinstance(links, list) and is_int(number):
            require(
                all(isinstance(link, str) for link in links),
                errors,
                f"{location}.nrpn_equivalents: IDs must be strings",
            )
            cc_nrpn_links[number].update(
                link for link in links if isinstance(link, str)
            )

    require(
        [parameter.get("number") for parameter in cc_parameters]
        == sorted(parameter.get("number") for parameter in cc_parameters),
        errors,
        "cc_parameters: entries must be sorted by CC number",
    )

    nrpn_ids: set[str] = set()
    reverse_links: dict[int, set[str]] = defaultdict(set)
    token_owners: dict[str, list[str]] = defaultdict(list)
    sort_keys: list[tuple[int, str]] = []
    for index, parameter in enumerate(nrpn_parameters):
        location = f"nrpn_parameters[{index}]"
        required = {"id", "name", "group", "address", "value", "source"}
        if not require_keys(parameter, required, errors, location):
            continue
        parameter_id = parameter["id"]
        require(
            isinstance(parameter_id, str)
            and bool(re.fullmatch(r"nrpn-\d{5}-[a-z0-9-]+", parameter_id)),
            errors,
            f"{location}.id: invalid stable ID",
        )
        require(
            parameter_id not in nrpn_ids,
            errors,
            f"{location}.id: duplicate {parameter_id!r}",
        )
        if isinstance(parameter_id, str):
            nrpn_ids.add(parameter_id)
        require(
            isinstance(parameter["name"], str) and bool(parameter["name"]),
            errors,
            f"{location}.name: expected non-empty string",
        )
        require(
            isinstance(parameter["group"], str) and bool(parameter["group"]),
            errors,
            f"{location}.group: expected non-empty string",
        )
        address = parameter["address"]
        if require_keys(address, {"number", "msb", "lsb"}, errors, f"{location}.address"):
            msb = address["msb"]
            lsb = address["lsb"]
            number = address["number"]
            require(
                is_int(msb) and 0 <= msb <= 127,
                errors,
                f"{location}.address.msb: expected 7-bit integer",
            )
            require(
                is_int(lsb) and 0 <= lsb <= 127,
                errors,
                f"{location}.address.lsb: expected 7-bit integer",
            )
            require(
                is_int(number) and 0 <= number <= 16383,
                errors,
                f"{location}.address.number: expected 14-bit integer",
            )
            if is_int(msb) and is_int(lsb) and is_int(number):
                require(
                    number == msb * 128 + lsb,
                    errors,
                    f"{location}.address.number: inconsistent with MSB/LSB",
                )
                sort_keys.append((number, str(parameter["name"])))
        validate_value(parameter["value"], errors, f"{location}.value", rhythm_lists)
        if "cc_equivalent" in parameter:
            cc_number = parameter["cc_equivalent"]
            require(
                is_int(cc_number) and cc_number in cc_numbers,
                errors,
                f"{location}.cc_equivalent: unknown CC {cc_number!r}",
            )
            if is_int(cc_number) and isinstance(parameter_id, str):
                reverse_links[cc_number].add(parameter_id)
        if isinstance(parameter_id, str):
            try:
                for token in decoder_tokens(parameter):
                    token_owners[token].append(parameter_id)
            except (KeyError, TypeError):
                errors.append(f"{location}: cannot derive decoder key")

    require(
        sort_keys == sorted(sort_keys),
        errors,
        "nrpn_parameters: entries must be sorted by address and name",
    )
    linked_ids = set().union(*cc_nrpn_links.values()) if cc_nrpn_links else set()
    require(
        linked_ids <= nrpn_ids,
        errors,
        "cc_parameters: nrpn_equivalents contains unknown IDs",
    )
    nonempty_cc_links = {
        number: links for number, links in cc_nrpn_links.items() if links
    }
    require(
        nonempty_cc_links == dict(reverse_links),
        errors,
        "CC/NRPN equivalence links are not bidirectionally consistent",
    )

    ambiguities = catalog["source_ambiguities"]
    if require_keys(
        ambiguities,
        {
            "fx_delay_rhythm_list",
            "unattributed_page_26_list",
            "decoder_collisions",
        },
        errors,
        "source_ambiguities",
    ):
        require(
            ambiguities["fx_delay_rhythm_list"] == "label_present_values_absent",
            errors,
            "source_ambiguities.fx_delay_rhythm_list: unexpected status",
        )
        unattributed = ambiguities["unattributed_page_26_list"]
        require(
            isinstance(unattributed, list)
            and len(unattributed) == 12
            and all(isinstance(item, str) and item for item in unattributed),
            errors,
            "source_ambiguities.unattributed_page_26_list: expected 12 labels",
        )
        expected_collisions = [
            {"decoder_key": token, "parameter_ids": owners}
            for token, owners in sorted(token_owners.items())
            if len(owners) > 1
        ]
        require(
            ambiguities["decoder_collisions"] == expected_collisions,
            errors,
            "source_ambiguities.decoder_collisions: declarations do not match data",
        )

    if errors:
        raise CatalogError("\n".join(errors))
    return {
        "cc_parameters": len(cc_parameters),
        "nrpn_parameters": len(nrpn_parameters),
        "decoder_collisions": sum(
            len(owners) > 1 for owners in token_owners.values()
        ),
    }


def load_catalog(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def expect_failure(catalog: Any, label: str) -> None:
    try:
        validate_catalog(catalog)
    except CatalogError:
        return
    raise CatalogError(f"self-test fixture did not fail: {label}")


def run_self_test(path: Path) -> dict[str, int]:
    catalog = load_catalog(path)
    summary = validate_catalog(catalog)

    duplicate_cc = copy.deepcopy(catalog)
    duplicate_cc["cc_parameters"].append(
        copy.deepcopy(duplicate_cc["cc_parameters"][0])
    )
    expect_failure(duplicate_cc, "duplicate CC")

    broken_address = copy.deepcopy(catalog)
    broken_address["nrpn_parameters"][0]["address"]["number"] += 1
    expect_failure(broken_address, "inconsistent NRPN number")

    broken_enum = copy.deepcopy(catalog)
    enum_parameter = next(
        parameter
        for parameter in broken_enum["nrpn_parameters"]
        if parameter["value"]["kind"] == "enum"
    )
    enum_parameter["value"]["items"][0]["value"] = 99
    expect_failure(broken_enum, "invalid enum")

    missing_collision = copy.deepcopy(catalog)
    missing_collision["source_ambiguities"]["decoder_collisions"].pop()
    expect_failure(missing_collision, "missing collision declaration")
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "catalog",
        nargs="?",
        type=Path,
        default=DEFAULT_CATALOG,
        help=f"catalog to validate (default: {DEFAULT_CATALOG})",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="also verify that deliberately corrupt fixtures are rejected",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        summary = (
            run_self_test(args.catalog)
            if args.self_test
            else validate_catalog(load_catalog(args.catalog))
        )
    except (CatalogError, OSError, json.JSONDecodeError) as error:
        print(f"parameter catalog validation failed:\n{error}", file=sys.stderr)
        return 1
    print(
        f"parameter catalog ok: {summary['cc_parameters']} CC, "
        f"{summary['nrpn_parameters']} NRPN, "
        f"{summary['decoder_collisions']} declared decoder collisions"
    )
    if args.self_test:
        print("self-test: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
