#!/usr/bin/env python3
"""Credential setup regression tests; all files and values are isolated fixtures."""

import contextlib
import getpass
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

import configure_api_key as setup
from elevenlabs_service import load_configuration


class ConfigureApiKeyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hydra-key-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / ".env"
        for patch in (mock.patch.object(setup, "ROOT", self.root),
                      mock.patch.dict(os.environ, {}, clear=True)):
            patch.start()
            self.addCleanup(patch.stop)

    def run_main(self, arguments=None, *, key="fixture-secret", terminal=True, error=None):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), \
                mock.patch.object(setup.sys.stdin, "isatty", return_value=terminal), \
                mock.patch.object(setup.getpass, "getpass", return_value=key, side_effect=error) as prompt:
            result = setup.main(arguments or [])
        return result, output.getvalue() + errors.getvalue(), prompt

    def assert_private(self):
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_new_key_roundtrips_literally_without_shell_evaluation(self):
        key = "fixture-$(literal)-$VALUE#suffix=part"
        setup.save_key(self.path, "", key)
        self.assertEqual(load_configuration(self.path)[0], key)
        self.assert_private()
        self.assertEqual(list(self.root.glob(".env-*")), [])

    def test_replace_removes_duplicate_keys_and_preserves_other_settings(self):
        document = ("# private settings\r\nELEVENLABS_API_KEY=old-one\n"
                    "ELEVENLABS_TIMEOUT_SECONDS=90\r\n"
                    "  export  ELEVENLABS_API_KEY = 'old-two'\n"
                    "OTHER_SETTING=literal-$(not-a-command)")
        self.path.write_text(document, encoding="utf-8")
        self.assertEqual(setup.read_document(self.path), document)
        setup.save_key(self.path, document, "replacement-fixture")
        self.assertEqual(self.path.read_bytes().decode("utf-8"),
                         "# private settings\r\nELEVENLABS_TIMEOUT_SECONDS=90\r\n"
                         "OTHER_SETTING=literal-$(not-a-command)\n"
                         "ELEVENLABS_API_KEY=replacement-fixture\n")
        self.assertEqual(load_configuration(self.path)[:2], ("replacement-fixture", 90.0))
        self.assert_private()

    def test_saved_key_detection_matches_service_duplicate_and_quote_rules(self):
        for document, expected in (
                ("export  ELEVENLABS_API_KEY = 'fixture'\n", True),
                ("ELEVENLABS_API_KEY=fixture # comment\n", True),
                ("ELEVENLABS_API_KEY=fixture\nELEVENLABS_API_KEY=\n", False),
                ("# ELEVENLABS_API_KEY=fixture\n", False),
                ("export\tELEVENLABS_API_KEY=fixture\n", False)):
            with self.subTest(document=document):
                self.path.write_text(document, encoding="utf-8")
                self.assertEqual(bool(load_configuration(self.path)[0]), expected)
                self.assertEqual(setup.has_saved_key(document), expected)

    def test_main_does_not_echo_saved_key(self):
        result, output, prompt = self.run_main(key="no-echo-fixture")
        self.assertEqual(result, 0)
        prompt.assert_called_once_with("API key: ")
        self.assertNotIn("no-echo-fixture", output)
        self.assertEqual(load_configuration(self.path)[0], "no-echo-fixture")
        self.assert_private()

    def test_existing_key_is_kept_and_permissions_tightened(self):
        document = "ELEVENLABS_API_KEY=existing-fixture\nOTHER=value\n"
        self.path.write_text(document, encoding="utf-8")
        self.path.chmod(0o644)
        result, output, prompt = self.run_main()
        self.assertEqual(result, 0)
        prompt.assert_not_called()
        self.assertEqual(self.path.read_text(encoding="utf-8"), document)
        self.assertNotIn("existing-fixture", output)
        self.assert_private()

    def test_environment_key_preserves_file_without_prompting(self):
        document = "OTHER=unchanged\n"
        self.path.write_text(document, encoding="utf-8")
        with mock.patch.dict(os.environ, {setup.SETTING: "environment-fixture"}):
            result, output, prompt = self.run_main()
        self.assertEqual(result, 0)
        prompt.assert_not_called()
        self.assertEqual(self.path.read_text(encoding="utf-8"), document)
        self.assertNotIn("environment-fixture", output)

    def test_replace_warns_that_environment_still_takes_precedence(self):
        with mock.patch.dict(os.environ, {setup.SETTING: "environment-fixture"}):
            result, output, prompt = self.run_main(["--replace"], key="replacement-fixture")
        self.assertEqual(result, 0)
        prompt.assert_called_once()
        self.assertEqual(load_configuration(self.path)[0], "replacement-fixture")
        self.assertIn("environment still takes precedence", output)
        self.assertNotIn("environment-fixture", output)
        self.assertNotIn("replacement-fixture", output)

    def test_blank_or_cancelled_prompt_preserves_original_bytes(self):
        original = b"ELEVENLABS_API_KEY=old-fixture\r\nOTHER=value\r\n"
        for error in (None, EOFError, KeyboardInterrupt):
            with self.subTest(error=error):
                self.path.write_bytes(original)
                result, output, _ = self.run_main(["--replace"], key="", error=error)
                self.assertEqual(result, 0 if error is None else 1)
                self.assertEqual(self.path.read_bytes(), original)
                self.assertNotIn("old-fixture", output)
                self.assertEqual(list(self.root.glob(".env-*")), [])

    def test_noninteractive_input_does_not_prompt_or_create_file(self):
        result, _, prompt = self.run_main(terminal=False)
        self.assertEqual(result, 0)
        prompt.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_no_echo_fallback_is_rejected_without_writing(self):
        result, output, _ = self.run_main(error=getpass.GetPassWarning)
        self.assertEqual(result, 1)
        self.assertIn("Cannot hide terminal input", output)
        self.assertFalse(self.path.exists())

    def test_invalid_values_do_not_leak_or_modify_file(self):
        original = "OTHER=preserved\n"
        self.path.write_text(original, encoding="utf-8")
        for key in (" leading", "trailing ", "two words", "quoted'key", 'quoted"key',
                    "new\nline", "carriage\rreturn", "tab\tkey", "nul\0key", "nonascii-\u00e9"):
            with self.subTest(key=repr(key)):
                result, output, _ = self.run_main(key=key)
                self.assertEqual(result, 1)
                self.assertNotIn(key, output)
                self.assertEqual(self.path.read_text(encoding="utf-8"), original)
                self.assertEqual(list(self.root.glob(".env-*")), [])

    def test_concurrent_edit_is_preserved_and_private_temporary_file_removed(self):
        original = "OTHER=original\n"
        self.path.write_text(original, encoding="utf-8")
        document = setup.read_document(self.path)
        self.path.write_text("OTHER=edited-while-prompt-open\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed during setup"):
            setup.save_key(self.path, document, "new-fixture")
        self.assertEqual(self.path.read_text(encoding="utf-8"), "OTHER=edited-while-prompt-open\n")
        self.assertEqual(list(self.root.glob(".env-*")), [])

    def test_symlink_is_rejected_including_replacement_during_prompt(self):
        target = self.root / "elsewhere"
        target.write_text("OTHER=do-not-touch\n", encoding="utf-8")
        self.path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlink"):
            setup.read_document(self.path)
        with self.assertRaisesRegex(ValueError, "symlink"):
            setup.save_key(self.path, "", "new-fixture")
        self.assertEqual(target.read_text(encoding="utf-8"), "OTHER=do-not-touch\n")
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(list(self.root.glob(".env-*")), [])

    def test_unreadable_text_reports_generic_error_without_echo(self):
        original = b"ELEVENLABS_API_KEY=private-fixture\xff\n"
        self.path.write_bytes(original)
        result, output, prompt = self.run_main()
        self.assertEqual(result, 1)
        prompt.assert_not_called()
        self.assertNotIn("private-fixture", output)
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
