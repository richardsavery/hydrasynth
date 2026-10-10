#!/usr/bin/env python3
"""Offline numerical fixtures for the ElevenLabs recorded-data pipeline."""
import copy
import json
import math
import unittest

from elevenlabs_analysis import (
    analyze_dataset, compile_plan, parse_dataset, synthetic_dataset, validate_request,
)


def recording(points):
    return parse_dataset("\n".join(json.dumps({"t": time, "value": value}) for time, value in points), "fixture.jsonl")


def settings(**overrides):
    value = {"timestamp_column": "t", "timestamp_units": "seconds",
             "channels": [{"name": "value", "meaning": "scalar", "lower_bound": 0, "upper_bound": 1}]}
    value.update(overrides)
    return value


def browser_json_roundtrip(value):
    """JavaScript's JSON.stringify removes .0 from integral JSON numbers."""
    return json.loads(json.dumps(value), parse_float=lambda token: (
        int(float(token)) if float(token).is_integer() else float(token)))


class AnalysisTests(unittest.TestCase):
    def test_synthetic_plan_is_repeatable_and_alternates(self):
        source = synthetic_dataset()
        analysis = analyze_dataset(source, source["defaults"])
        self.assertTrue(analysis["can_generate"])
        self.assertEqual([section["bands"]["activity"] for section in analysis["sections"]], ["low", "high"] * 3)
        for section in analysis["sections"]:
            self.assertAlmostEqual(section["coverage"], 1.0)
        plan = compile_plan(analysis, {})
        self.assertEqual(plan, compile_plan(analyze_dataset(source, source["defaults"]), {}))
        self.assertEqual(sum(chunk["duration_ms"] for chunk in plan["request"]["composition_plan"]["chunks"]), 60000)
        self.assertTrue(all(section["descriptors"]["articulation"] == [] for section in plan["sections"]))
        self.assertNotIn("prompt", plan["request"])
        validate_request(plan["request"])
        enabled = compile_plan(analysis, {"enable_variability": True})
        self.assertTrue(enabled["sections"][0]["descriptors"]["articulation"])

    def test_flat_parsing_and_content_identity(self):
        csv = parse_dataset("t,value\n0,0.2\n1,\n2,NaN\n3,0.4\n", "file.csv")
        jsonl = recording([(0, 0.2), (1, None), (2, None), (3, 0.4)])
        self.assertEqual(csv["content_hash"], jsonl["content_hash"])
        with self.assertRaisesRegex(ValueError, "nested"):
            parse_dataset('{"t":0,"value":{"x":1}}', "nested.jsonl")
        with self.assertRaisesRegex(ValueError, "unique"):
            parse_dataset("t,t\n0,1", "bad.csv")
        with self.assertRaisesRegex(ValueError, "finite"):
            analyze_dataset(recording([(None, 0), (1, 1)]), settings())

    def test_sort_duplicate_last_and_explicit_units(self):
        source = recording([(2000, 0.2), (0, 0.1), (1000, 0.3), (1000, 0.8), (3000, 0.4)])
        analysis = analyze_dataset(source, settings(timestamp_units="milliseconds"))
        self.assertEqual(analysis["source_duration_seconds"], 3)
        self.assertTrue(analysis["diagnostics"]["sorting_changed"])
        self.assertEqual(analysis["diagnostics"]["duplicate_timestamps"], 1)
        self.assertAlmostEqual(analysis["timeline"]["signal"][10], 0.8)
        self.assertTrue(analysis["can_generate"])

    def test_constant_vs_sparse_spike_degenerate_baseline(self):
        inferred = settings(channels=[{"name": "value", "meaning": "scalar"}])
        constant = analyze_dataset(recording([(i / 10, 2) for i in range(101)]), inferred)
        self.assertFalse(constant["can_generate"])
        self.assertTrue(constant["baseline"]["value"]["constant"])
        spikes = analyze_dataset(recording([(i / 10, 1 if i == 50 else 0) for i in range(101)]), inferred)
        self.assertFalse(spikes["can_generate"])
        self.assertFalse(spikes["baseline"]["value"]["constant"])
        self.assertIn("despite changing data", " ".join(spikes["blocking_reasons"]))
        self.assertAlmostEqual(spikes["sections"][0]["coverage"], 1)
        fixed = analyze_dataset(recording([(i / 10, 0) for i in range(101)]), settings())
        self.assertTrue(fixed["can_generate"])
        self.assertEqual(fixed["sections"][0]["activity"], 0)

    def test_missing_and_long_gaps_do_not_become_stillness(self):
        points = [(i / 10, None if 25 <= i <= 45 else 0.7) for i in range(101)]
        result = analyze_dataset(recording(points), settings())
        self.assertFalse(result["can_generate"])
        self.assertLess(result["sections"][0]["coverage"], 0.9)
        self.assertIsNone(result["timeline"]["signal"][30])
        self.assertAlmostEqual(result["sections"][0]["activity"], 0.7)
        points = [(i / 10, 0.7) for i in range(101) if not 25 <= i <= 45]
        result = analyze_dataset(recording(points), settings())
        self.assertFalse(result["can_generate"])
        self.assertEqual(result["diagnostics"]["source_gap_count"], 1)
        self.assertIsNone(result["timeline"]["signal"][30])

    def test_coverage_threshold_accepts_exactly_ninety_percent(self):
        source = recording([(i / 10, None if 20 <= i < 30 else 0.4) for i in range(101)])
        result = analyze_dataset(source, settings())
        self.assertAlmostEqual(result["sections"][0]["coverage"], 0.9)
        self.assertTrue(result["can_generate"])

    def test_velocity_position_scalar_and_unit_normalization(self):
        negative = recording([(i / 10, -0.6) for i in range(101)])
        result = analyze_dataset(negative, settings(channels=[{"name": "value", "meaning": "velocity", "lower_bound": 0, "upper_bound": 1}]))
        self.assertAlmostEqual(result["sections"][0]["activity"], 0.6)
        scalar = analyze_dataset(negative, settings(channels=[{"name": "value", "meaning": "scalar", "lower_bound": -1, "upper_bound": 1}]))
        self.assertAlmostEqual(scalar["sections"][0]["activity"], 0.2)
        ramp = recording([(i / 10, 2 * i / 10) for i in range(101)])
        position = analyze_dataset(ramp, settings(channels=[{"name": "value", "meaning": "position", "lower_bound": 0, "upper_bound": 4}]))
        self.assertAlmostEqual(position["sections"][0]["activity"], 0.5, delta=0.01)
        mixed = parse_dataset("\n".join(json.dumps({"t": i / 10, "small": 0.2, "large": 800}) for i in range(101)), "mixed.jsonl")
        result = analyze_dataset(mixed, settings(channels=[{"name": "small", "meaning": "scalar", "lower_bound": 0, "upper_bound": 1}, {"name": "large", "meaning": "scalar", "lower_bound": 0, "upper_bound": 1000}]))
        self.assertAlmostEqual(result["sections"][0]["activity"], math.sqrt((0.2 ** 2 + 0.8 ** 2) / 2))

    def test_saved_baseline_reused_and_clipping_reported(self):
        first = analyze_dataset(recording([(i / 10, i / 100) for i in range(101)]), settings(channels=[{"name": "value", "meaning": "scalar"}]))
        second = analyze_dataset(recording([(i / 10, 2 * i / 100) for i in range(101)]), settings(channels=[{"name": "value", "meaning": "scalar"}], baseline=first["baseline"]))
        self.assertEqual(first["baseline"]["value"]["lower_bound"], second["baseline"]["value"]["lower_bound"])
        self.assertEqual(first["baseline"]["value"]["upper_bound"], second["baseline"]["value"]["upper_bound"])
        self.assertGreater(second["baseline"]["value"]["clipped_percent"], first["baseline"]["value"]["clipped_percent"])

    def test_saved_settings_roundtrip_preserves_plan_and_cache_identity(self):
        for source, config in (
            (synthetic_dataset(), {}),
            (recording([(i / 10, i / 100) for i in range(101)]), settings(channels=[{"name": "value", "meaning": "scalar"}])),
        ):
            first = analyze_dataset(source, config)
            reopened = analyze_dataset(source, first["settings"])
            self.assertEqual(reopened, first)
            self.assertEqual(compile_plan(reopened, {}), compile_plan(first, {}))
        saved = first["baseline"]
        changed = analyze_dataset(source, settings(channels=[{"name": "value", "meaning": "velocity", "lower_bound": 0, "upper_bound": 2}], baseline=saved))
        self.assertEqual(changed["baseline"]["value"]["method"], "fixed")
        self.assertEqual(changed["baseline"]["value"]["meaning"], "velocity")
        self.assertEqual(changed["baseline"]["value"]["upper_bound"], 2)

    def test_browser_roundtrip_preserves_serialized_settings_and_plan_identity(self):
        for source, config in (
            (synthetic_dataset(), {}),
            (recording([(i / 10, i / 100) for i in range(101)]), settings(channels=[{"name": "value", "meaning": "scalar"}])),
        ):
            first = analyze_dataset(source, config)
            browser_settings = browser_json_roundtrip(first["settings"])
            for channel in browser_settings["channels"]:
                channel["change_based"] = False
                channel["selected"] = True
            reopened = analyze_dataset(source, browser_settings)
            encode = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
            self.assertEqual(encode(reopened), encode(first))
            first_plan = compile_plan(first, {})
            reopened_plan = compile_plan(reopened, browser_json_roundtrip(first_plan["settings"]))
            self.assertEqual(encode(first_plan), encode(reopened_plan))
            self.assertTrue(all(set(channel) <= {"name", "meaning", "change_based", "lower_bound", "upper_bound"}
                                for channel in reopened["settings"]["channels"]))

        source = synthetic_dataset()
        original = analyze_dataset(source, {})
        browser_defaults = browser_json_roundtrip(source["defaults"])
        browser_defaults["channels"][0]["change_based"] = False
        browser_defaults["channels"][0]["lower_bound"] = -0.0
        self.assertEqual(encode(original["settings"]), encode(analyze_dataset(source, browser_defaults)["settings"]))

    def test_density_invariance_and_decimation_filter(self):
        sparse = recording([(i / 10, 0.5 + 0.3 * math.sin(i / 10)) for i in range(201)])
        dense = recording([(i / 100, 0.5 + 0.3 * math.sin(i / 100)) for i in range(2001)])
        a, b = analyze_dataset(sparse, settings()), analyze_dataset(dense, settings())
        self.assertTrue(b["diagnostics"]["downsampled_with_averaging"])
        for left, right in zip(a["sections"], b["sections"]):
            self.assertAlmostEqual(left["activity"], right["activity"], delta=0.005)
            self.assertAlmostEqual(left["variability"], right["variability"], delta=0.01)
        alias = recording([(i / 100, i % 2) for i in range(1001)])
        filtered = analyze_dataset(alias, settings())
        self.assertAlmostEqual(filtered["sections"][0]["activity"], 0.5)
        self.assertAlmostEqual(filtered["sections"][0]["variability"], 0, places=10)

    def test_tail_preserved_and_limits_block_without_losing_preview(self):
        result = analyze_dataset(recording([(i / 10, 0.3) for i in range(621)]), settings(end_seconds=62))
        self.assertEqual([section["duration_ms"] for section in result["sections"]], [10000] * 5 + [12000])
        self.assertEqual(result["sections"][-1]["source_end"], 62)
        too_many = analyze_dataset(recording([(i, 0.3) for i in range(601)]), settings(end_seconds=600))
        self.assertEqual(len(too_many["sections"]), 60)
        self.assertFalse(too_many["can_generate"])
        self.assertEqual(too_many["sections"][-1]["source_end"], 600)
        plan = compile_plan(too_many, {})
        self.assertFalse(plan["can_generate"])
        self.assertEqual(len(plan["request"]["composition_plan"]["chunks"]), 60)
        valid = analyze_dataset(recording([(i, 0.3) for i in range(601)]), settings(end_seconds=600, window_seconds=20))
        self.assertTrue(valid["can_generate"])
        validate_request(compile_plan(valid, {})["request"])

    def test_crop_alignment_and_submillisecond_rounding(self):
        result = analyze_dataset(recording([(i / 10, 0.4) for i in range(401)]), settings(start_seconds=5.1234, end_seconds=28.2468))
        self.assertEqual(result["sections"][0]["source_start"], 5.1234)
        self.assertEqual(result["sections"][0]["audio_start"], 0)
        self.assertEqual(result["sections"][-1]["source_end"], 28.2468)
        self.assertEqual(sum(section["duration_ms"] for section in result["sections"]), round((28.2468 - 5.1234) * 1000))

    def test_provider_validation_rejects_unsupported_and_invalid_fields(self):
        source = synthetic_dataset()
        valid = compile_plan(analyze_dataset(source, {}), {})["request"]
        for change in (
            lambda body: body.update(model_id="music_v1"),
            lambda body: body.update(force_instrumental=True),
            lambda body: body.update(seed=-1),
            lambda body: body.update(seed=2147483648),
            lambda body: body["composition_plan"]["chunks"][0].update(duration_ms=2999),
            lambda body: body["composition_plan"]["chunks"][0].update(context_adherence="maximum"),
            lambda body: body["composition_plan"]["chunks"][0].update(positive_styles=["style"] * 51),
        ):
            body = copy.deepcopy(valid)
            change(body)
            with self.assertRaises(ValueError):
                validate_request(body)

    def test_saved_baseline_validates_meaning_and_numeric_bounds(self):
        source = recording([(i / 10, 0.4) for i in range(101)])
        config = settings(channels=[{"name": "value", "meaning": "scalar"}],
                          baseline={"value": {"lower_bound": "0", "upper_bound": "1", "meaning": "scalar"}})
        self.assertTrue(analyze_dataset(source, config)["can_generate"])
        config["baseline"]["value"]["meaning"] = "velocity"
        with self.assertRaisesRegex(ValueError, "different channel meaning"):
            analyze_dataset(source, config)
        config["baseline"]["value"]["meaning"] = "scalar"
        config["baseline"]["value"]["lower_bound"] = "nan"
        with self.assertRaisesRegex(ValueError, "finite numbers"):
            analyze_dataset(source, config)

    def test_extreme_finite_values_block_overflow_and_remain_json_serializable(self):
        source = recording([(i / 10, -1e308 if i % 2 == 0 else 1e308) for i in range(101)])
        position = analyze_dataset(source, settings(channels=[{"name": "value", "meaning": "position", "lower_bound": 0, "upper_bound": 1}]))
        self.assertFalse(position["can_generate"])
        self.assertIn("overflow", " ".join(position["blocking_reasons"]))
        json.dumps(position, allow_nan=False)
        scalar = analyze_dataset(source, settings(channels=[{"name": "value", "meaning": "scalar", "lower_bound": -1e308, "upper_bound": 1e308}]))
        self.assertFalse(scalar["can_generate"])
        self.assertIn("overflows", " ".join(scalar["blocking_reasons"]))
        json.dumps(scalar, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
