"""Offline portable-session checks with real audio services and HTTP routing."""
import copy
import http.client
import io
import json
from pathlib import Path
import shutil
import stat
import tempfile
import threading
import unittest
import wave
import zipfile

from elevenlabs_service import ElevenLabsService, canonical_json
from hydra_dashboard import DashboardHTTPServer, SnapshotStore, handler_for
from rap_experiment_service import RapExperimentService
from rap_response_service import RapResponseService
from rap_service import RapService
from session_assets import MAX_ZIP, SessionAssets
from test_elevenlabs_service import example_plan


def wave_bytes(seconds=.1):
    result = io.BytesIO()
    with wave.open(result, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x01\x00" * round(8000 * seconds))
    return result.getvalue()


class NoProvider:
    def __getattr__(self, name):
        raise AssertionError("Session operations must never call a provider: " + name)


class SessionAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.services = []
        self.origin, self.music, self.responses, self.experiments = self.make_services("origin")
        self.target, self.target_music, self.target_responses, self.target_experiments = self.make_services("target")
        self.audio = wave_bytes()
        self.music_id, self.response_id, self.experiment_id = "a" * 32, "b" * 32, "c" * 32
        plan = self.music._save("plans", example_plan())
        self.job = {"id": self.music_id, "plan_id": plan["id"], "cache_key": plan["cache_key"],
                    "state": "complete", "attempt_count": 1, "created_at": "2026-10-20T00:00:00Z", "updated_at": "2026-10-20T00:00:00Z",
                    "generation_settings": {"style": "Warm glass bells"}, "audio_filename": "audio.wav",
                    "audio": {"content_type": "audio/wav", "size_bytes": len(self.audio), "duration_seconds": .1},
                    "audio_url": f"/api/elevenlabs/generations/{self.music_id}/audio", "separate_stems": True,
                    "stem_separation": {"state": "complete", "generation_id": self.music_id, "stems": [
                        {"id": "drums", "name": "drums", "filename": "drums.wav", "content_type": "audio/wav", "size_bytes": len(self.audio),
                         "audio_url": f"/api/elevenlabs/generations/{self.music_id}/stems/drums/audio"}]}}
        self.music._write_job(copy.deepcopy(self.job))
        self.write(self.music.root / "jobs" / self.music_id / "audio.wav", self.audio)
        self.write(self.music.root / "jobs" / self.music_id / "stems/drums.wav", self.audio)
        response = {"id": self.response_id, "request_id": "response-request", "state": "complete", "created_at": self.job["created_at"],
                    "_filename": "response.wav", "_content_type": "audio/wav", "lyrics": "A short bright rap",
                    "audio_url": f"/api/rap-response/responses/{self.response_id}/audio", "vocal_state": "complete",
                    "_vocal_filename": "vocal.wav", "_vocal_content_type": "audio/wav",
                    "vocal_audio_url": f"/api/rap-response/responses/{self.response_id}/vocals/audio"}
        self.responses._db.execute("INSERT INTO responses VALUES (?,?,?,?,?,?)", (self.response_id, response["request_id"], "response-hash", "complete", response["created_at"], canonical_json(response)))
        self.responses._db.commit()
        for name in ("response.wav", "vocal.wav", "input.wav"):
            self.write(self.responses.root / self.response_id / name, self.audio)
        experiment = {"id": self.experiment_id, "request_id": "experiment-request", "state": "complete", "created_at": self.job["created_at"],
                      "text": "Comparison rhythm", "examples": [{"id": "flash", "state": "complete", "filename": "flash.wav", "content_type": "audio/wav",
                      "audio_url": f"/api/rap-experiment/experiments/{self.experiment_id}/audio/flash"}]}
        self.experiments._db.execute("INSERT INTO experiments VALUES (?,?,?,?,?,?)", (self.experiment_id, experiment["request_id"], "experiment-hash", "complete", experiment["created_at"], canonical_json(experiment)))
        self.experiments._db.commit()
        self.write(self.experiments.root / self.experiment_id / "flash.wav", self.audio)
        self.storage = {"hydra.music-mixer.demo.v1": json.dumps({"trackId": self.music_id, "prompt": {"next_track_id": self.music_id}, "rap": {"experiment_id": self.experiment_id}}),
                        "hydra.rap-response.v1": json.dumps({"response_id": self.response_id}),
                        "hydra.elevenlabs.realtime.v1": json.dumps({"starterId": self.music_id})}
        self.session = {"schema": 1, "id": "session-test", "name": "Evening groove", "route": "#mixer", "storage": self.storage,
                        "createdAt": self.job["created_at"], "updatedAt": self.job["created_at"]}
        self.library = {"format": "hydra-sessions", "version": 1, "sessions": [self.session]}

    def make_services(self, name):
        root = self.root / name
        music = ElevenLabsService(root / "elevenlabs", root / ".env", client=NoProvider(), start_worker=False)
        responses = RapResponseService(root / "rap-response", root / ".env", client=NoProvider(), music_client=NoProvider(), voice_client=NoProvider(), start_worker=False)
        experiments = RapExperimentService(root / "rap-experiment", root / ".env", client=NoProvider(), music_client=NoProvider(), start_worker=False)
        self.services.extend((music, responses, experiments))
        return SessionAssets(root / "session-assets", elevenlabs=music, rap_response=responses, rap_experiment=experiments), music, responses, experiments

    def tearDown(self):
        for service in self.services:
            service.close()
        self.temp.cleanup()

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def archive(self):
        self.session["assets"] = self.origin.capture(self.session)
        return self.origin.export(self.library).path.read_bytes()

    def rewrite(self, data, callback):
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(output, "w") as target:
            members = {item.filename: source.read(item) for item in source.infolist()}
            callback(members)
            for name, content in members.items():
                target.writestr(name, content)
        return output.getvalue()

    def test_full_roundtrip_copies_generated_music_stems_and_rap_only(self):
        archive = self.archive()
        metadata = self.session["assets"]
        self.assertEqual(metadata["files"], 5)
        self.assertEqual(len(metadata["tracks"]), 3)
        self.assertEqual(metadata["bytes"], len(self.audio) * 5)
        self.assertTrue(any("Warm glass bells" in item["name"] for item in metadata["tracks"]))
        with zipfile.ZipFile(io.BytesIO(archive)) as packed:
            self.assertTrue(any("Warm-glass-bells" in name for name in packed.namelist()))
            self.assertFalse(any("input.wav" in name or ".env" in name or "sqlite" in name for name in packed.namelist()))
        imported = self.target.import_archive(archive)
        self.assertEqual(imported, self.library)
        self.assertEqual(self.target_music.jobs(), [], "import does not activate or install jobs")
        self.target.restore({"assets": imported["sessions"][0]["assets"]})
        self.assertEqual(self.target_music.audio_response(self.target_music._job(self.music_id)).path.read_bytes(), self.audio)
        self.assertEqual(self.target_music.resolve_stem_audio(self.music_id, "drums").path.read_bytes(), self.audio)
        self.assertEqual(self.target_responses.audio_response(self.response_id, vocals=True).path.read_bytes(), self.audio)
        self.assertEqual(self.target_experiments.audio_response(self.experiment_id, "flash").path.read_bytes(), self.audio)
        self.assertFalse((self.target_responses.root / self.response_id / "input.wav").exists())
        self.assertTrue(self.target_music._queue.empty())
        self.assertTrue(self.target_responses._queue.empty())
        self.assertTrue(self.target_experiments._queue.empty())
        self.target_music._recover()
        self.assertTrue(self.target_music._queue.empty(), "restart cannot resume provider work")
        self.target.restore({"assets": metadata})
        self.assertEqual(self.target.import_archive(archive), imported, "reimport and restore are idempotent")

    def test_legacy_export_captures_audio_and_no_audio_needs_no_bundle(self):
        self.assertIsNone(self.origin.capture({"storage": {}}))
        exported = self.origin.export(self.library)
        self.assertNotIn("assets", self.session, "legacy input remains untouched")
        imported = self.target.import_archive(exported.path.read_bytes())
        self.assertEqual(imported["sessions"][0]["assets"]["files"], 5)

    def test_uploaded_audio_and_finished_stems_roundtrip_without_generation(self):
        upload_audio = wave_bytes(71)
        uploaded = self.music.create_upload(upload_audio, "My custom recording.wav", "d" * 32)
        self.assertEqual(uploaded["origin"], "uploaded")
        self.assertAlmostEqual(uploaded["audio"]["duration_seconds"], 71, places=2)
        analysis = {"schema_version": 1, "algorithm": "librosa-dynamic-v2", "state": "complete", "analysis_id": "e" * 32,
                    "first_beat_in_bar": 4, "bar_phase_confidence": .8,
                    "source": "mix", "source_sha256": uploaded["source"]["sha256"], "audio_sha256": uploaded["source"]["sha256"],
                    "duration_seconds": 71, "beats_seconds": [2, 2.51, 3.04, 5.25, 5.75, 6.2],
                    "active_regions": [{"start_seconds": 2, "end_seconds": 3.04}, {"start_seconds": 5.25, "end_seconds": 6.2}],
                    "bpm_median": 120, "bpm_min": 113, "bpm_max": 134, "warnings": []}
        uploaded["beat_analysis"] = copy.deepcopy(analysis)
        self.music._write_job(uploaded)
        self.session["storage"] = {"hydra.music-mixer.demo.v1": json.dumps({"trackId": uploaded["id"],
            "config": {"uploadedBpms": {uploaded["id"]: 123},
                       "beatTracking": {uploaded["id"]: {"enabled": True, "offsetSeconds": .025, "firstBeatInBar": 2}}},
            "prompt": {"next_mode": "loop"}})}
        archive = self.origin.export(self.library).path.read_bytes()
        original_archive = archive
        imported = self.target.import_archive(archive)
        self.target.restore({"assets": imported["sessions"][0]["assets"]})
        restored = self.target_music._job(uploaded["id"])
        self.assertEqual(restored["name"], "My custom recording")
        self.assertEqual(restored["source"], uploaded["source"])
        self.assertEqual(self.target_music.audio_response(restored).path.read_bytes(), upload_audio)
        saved_config = json.loads(imported["sessions"][0]["storage"]["hydra.music-mixer.demo.v1"])["config"]
        self.assertEqual(saved_config["uploadedBpms"], {uploaded["id"]: 123})
        self.assertEqual(saved_config["beatTracking"][uploaded["id"]]["offsetSeconds"], .025)
        self.assertEqual(restored["beat_analysis"], analysis)
        self.assertIsNone(restored.get("stem_separation"), "restoring an upload does not request separation")
        self.assertFalse(self.target_music._read("plans", restored["plan_id"])["can_generate"])
        self.assertTrue(self.target_music._queue.empty())

        # A later session can bring completed stems to a laptop that already has
        # the original upload. Its metadata must become usable with those files.
        uploaded["stem_separation"] = copy.deepcopy(self.job["stem_separation"])
        uploaded["stem_separation"]["generation_id"] = uploaded["id"]
        stem = uploaded["stem_separation"]["stems"][0]
        stem["audio_url"] = f"/api/elevenlabs/generations/{uploaded['id']}/stems/drums/audio"
        stem["size_bytes"] = len(upload_audio)
        self.write(self.music.root / "jobs" / uploaded["id"] / "stems/drums.wav", upload_audio)
        uploaded["beat_analysis"].update(source="drums", source_stem_id="drums", analysis_id="f" * 32)
        self.music._write_job(uploaded)
        archive = self.origin.export(self.library).path.read_bytes()
        imported = self.target.import_archive(archive)
        self.target.restore({"assets": imported["sessions"][0]["assets"]})
        self.assertEqual(self.target_music.get_stem_job(uploaded["id"])["state"], "complete")
        self.assertEqual(self.target_music.resolve_stem_audio(uploaded["id"], "drums").path.read_bytes(), upload_audio)
        self.assertEqual(self.target_music._job(uploaded["id"])["beat_analysis"], uploaded["beat_analysis"])
        self.target_music._recover()
        self.assertTrue(self.target_music._queue.empty(), "a restored upload remains passive across restart")

        # Loading an earlier saved version restores its timing while retaining
        # already available audio assets. Neither action restarts local analysis.
        earlier = self.target.import_archive(original_archive)
        self.target.restore({"assets": earlier["sessions"][0]["assets"]})
        self.assertEqual(self.target_music._job(uploaded["id"])["beat_analysis"], analysis)
        self.assertEqual(self.target_music.get_stem_job(uploaded["id"])["state"], "complete")
        self.assertTrue(self.target_music._queue.empty())

        def damage_source(members):
            for name, content in list(members.items()):
                if name.endswith("manifest.json"):
                    manifest = json.loads(content)
                    item = manifest["tracks"][0]
                    item["job"]["source"]["sha256"] = "0" * 64
                    members[name] = json.dumps(manifest).encode()
        status, _ = self.target.dispatch("POST", "/api/sessions/import", self.rewrite(archive, damage_source))
        self.assertEqual(status, 400, "untrusted archives cannot relabel unrelated audio as the upload")

        def damage_timing(members):
            for name, content in list(members.items()):
                if name.endswith("manifest.json"):
                    manifest = json.loads(content)
                    manifest["tracks"][0]["job"]["beat_analysis"]["audio_sha256"] = "0" * 64
                    members[name] = json.dumps(manifest).encode()
        status, _ = self.target.dispatch("POST", "/api/sessions/import", self.rewrite(archive, damage_timing))
        self.assertEqual(status, 400, "a beat map must belong to the archived audio")

        uploaded["beat_analysis"] = {"state": "analyzing", "schema_version": 1, "analysis_id": "f" * 32}
        self.music._write_job(uploaded)
        pending_archive = self.origin.export(self.library).path.read_bytes()
        with zipfile.ZipFile(io.BytesIO(pending_archive)) as pending:
            manifest_name = next(name for name in pending.namelist() if name.endswith("manifest.json"))
            self.assertNotIn("beat_analysis", json.loads(pending.read(manifest_name))["tracks"][0]["job"],
                             "unfinished analysis is never restored as pending work")

    def test_unchanged_captures_reuse_audio_bundle_and_repair_stem_metadata(self):
        first = self.origin.capture(self.session)
        self.assertEqual(first, self.origin.capture(self.session))
        self.assertEqual(len(list(self.origin.root.iterdir())), 1)
        path = self.music.root / "jobs" / self.music_id / "stems/drums.wav"
        path.unlink()
        self.assertEqual(self.music.get_stem_job(self.music_id)["state"], "failed")
        self.origin.restore({"assets": first})
        self.assertEqual(self.music.get_stem_job(self.music_id)["state"], "complete")
        self.assertEqual(path.read_bytes(), self.audio)

    def test_synth_legacy_rap_render_roundtrip(self):
        origin = RapService(self.root / "origin" / "rap", self.root / ".env", client=NoProvider(), start_worker=False)
        target = RapService(self.root / "target" / "rap", self.root / ".env", client=NoProvider(), start_worker=False)
        self.services.extend((origin, target))
        self.origin.services["rap"], self.target.services["rap"] = origin, target
        identifier = "d" * 32
        job = {"id": identifier, "request_id": "render-request", "state": "complete", "created_at": self.job["created_at"],
               "text": "Legacy rap", "audio_url": f"/api/rap/renders/{identifier}/audio"}
        origin._db.execute("INSERT INTO renders VALUES (?,?,?,?,?,?)", (identifier, job["request_id"], "render-hash", "complete", job["created_at"], canonical_json(job)))
        origin._db.commit()
        self.write(origin.root / (identifier + ".wav"), self.audio)
        self.storage["hydra.synth-mixer.v1"] = json.dumps({"rap": {"legacy_rap": {"render_id": identifier}}})
        archive = self.archive()
        self.assertEqual(self.session["assets"]["files"], 6)
        self.target.import_archive(archive)
        self.target.restore({"assets": self.session["assets"]})
        self.assertEqual(target.audio_response(identifier).path.read_bytes(), self.audio)
        self.assertTrue(target._queue.empty())

    def test_missing_or_pending_audio_fails_without_partial_capture(self):
        self.job["state"] = "generating"
        self.music._write_job(copy.deepcopy(self.job))
        status, body = self.origin.dispatch("POST", "/api/sessions/capture", self.session)
        self.assertEqual(status, 409)
        self.assertIn("complete", body["error"])
        self.assertEqual(list(self.origin.root.iterdir()), [])
        self.job["state"] = "complete"
        self.music._write_job(copy.deepcopy(self.job))
        (self.music.root / "jobs" / self.music_id / "audio.wav").unlink()
        self.assertEqual(self.origin.dispatch("POST", "/api/sessions/capture", self.session)[0], 404)

    def test_capture_rejects_truncated_audio_instead_of_archiving_damage(self):
        path = self.music.root / "jobs" / self.music_id / "audio.wav"
        path.write_bytes(b"short")
        status, body = self.origin.dispatch("POST", "/api/sessions/capture", self.session)
        self.assertEqual(status, 400)
        self.assertIn("damaged", body["error"])
        self.assertEqual(list(self.origin.root.iterdir()), [])

    def test_restore_repairs_deleted_audio_but_preserves_conflicting_files(self):
        metadata = self.origin.capture(self.session)
        path = self.music.root / "jobs" / self.music_id / "audio.wav"
        path.unlink()
        self.music._check_saved_audio(self.music._job(self.music_id))
        self.assertEqual(self.music._job(self.music_id)["state"], "failed")
        self.origin.restore({"assets": metadata})
        self.assertEqual(path.read_bytes(), self.audio)
        self.assertEqual(self.music._job(self.music_id)["state"], "complete")
        path.write_bytes(b"different original")
        status, _ = self.origin.dispatch("POST", "/api/sessions/restore", {"assets": metadata})
        self.assertEqual(status, 409)
        self.assertEqual(path.read_bytes(), b"different original")

    def test_restore_never_installs_over_active_child_generation(self):
        metadata = self.origin.capture(self.session)
        job = self.music._job(self.music_id)
        job["stem_separation"]["state"] = "generating"
        self.music._write_job(job)
        path = self.music.root / "jobs" / self.music_id / "stems/drums.wav"
        path.unlink()
        status, _ = self.origin.dispatch("POST", "/api/sessions/restore", {"assets": metadata})
        self.assertEqual(status, 409)
        self.assertFalse(path.exists())
        self.assertEqual(self.music._job(self.music_id)["stem_separation"]["state"], "generating")

    def test_untrusted_archives_reject_traversal_corruption_extra_files_and_remote_urls(self):
        original = self.archive()
        cases = []
        for name in ("../outside.wav", "/outside.wav", "assets/../outside.wav", "assets\\outside.wav", "credentials.json"):
            cases.append(self.rewrite(original, lambda members, name=name: members.update({name: b"bad"})))
        def corrupt(members):
            name = next(name for name in members if name.endswith("audio.wav"))
            members[name] = b"damaged"
        cases.append(self.rewrite(original, corrupt))
        def remote_url(members):
            name = next(name for name in members if name.endswith("manifest.json"))
            manifest = json.loads(members[name])
            manifest["tracks"][0]["job"]["audio_url"] = "https://example.invalid/audio.wav"
            members[name] = json.dumps(manifest).encode()
        cases.append(self.rewrite(original, remote_url))
        def unsafe_metadata(members, field):
            name = next(name for name in members if name.endswith("manifest.json"))
            manifest = json.loads(members[name])
            track = next(item for item in manifest["tracks"] if item["kind"] == "elevenlabs")
            if field == "mime":
                track["job"]["audio"]["content_type"] = "text/html\r\nX-Injected: yes"
            elif field == "recovery":
                track["job"].pop("attempt_count")
            elif field == "stem_recovery":
                track["job"]["stem_separation"].pop("state")
            else:
                track["plan"].pop("analysis_settings")
            members[name] = json.dumps(manifest).encode()
        for field in ("mime", "recovery", "stem_recovery", "plan"):
            cases.append(self.rewrite(original, lambda members, field=field: unsafe_metadata(members, field)))
        for archive in cases:
            status, _ = self.target.dispatch("POST", "/api/sessions/import", archive)
            self.assertEqual(status, 400)
            self.assertEqual(list(self.target.root.iterdir()), [], "invalid archive cannot install partial bundles")
        self.assertFalse((self.root / "outside.wav").exists())

    def test_symlinks_are_rejected_on_capture_and_in_zip(self):
        file = self.music.root / "jobs" / self.music_id / "audio.wav"
        file.unlink()
        secret = self.root / "private.wav"
        secret.write_bytes(self.audio)
        file.symlink_to(secret)
        self.assertEqual(self.origin.dispatch("POST", "/api/sessions/capture", self.session)[0], 400)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            info = zipfile.ZipInfo("sessions.json")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "outside.json")
        self.assertEqual(self.target.dispatch("POST", "/api/sessions/import", output.getvalue())[0], 400)

    def test_http_origin_media_type_and_archive_roundtrip(self):
        server = DashboardHTTPServer(("127.0.0.1", 0), handler_for(SnapshotStore("demo"), sessions=self.origin))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        def request(path, data, content_type="application/json", extra=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            headers = {"Content-Type": content_type, **(extra or {})}
            connection.request("POST", path, data, headers)
            response = connection.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            connection.close()
            return result
        try:
            status, _, body = request("/api/sessions/capture", json.dumps(self.session))
            self.assertEqual(status, 200)
            self.session["assets"] = json.loads(body)
            status, headers, archive = request("/api/sessions/export", json.dumps(self.library))
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Type"], "application/zip")
            self.assertIn("Evening-groove.zip", headers["Content-Disposition"])
            self.assertEqual(list(self.origin.root.glob("export-*.zip")), [], "HTTP downloads do not accumulate temporary ZIPs")
            self.assertEqual(request("/api/sessions/import", archive, "application/zip")[0], 200)
            self.assertEqual(request("/api/sessions/import", archive)[0], 415)
            self.assertEqual(request("/api/sessions/capture", "{}", extra={"Origin": "https://example.invalid"})[0], 403)
            self.assertEqual(request("/api/sessions/import", b"", "application/zip", {"Content-Length": str(MAX_ZIP + 1)})[0], 413)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
