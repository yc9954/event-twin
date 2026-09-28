"""No providers called: real bridge against an isolated local HTTP fixture."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from event_twin_nat.register import (EventTwinConfig, experiment_audit,
                                     inspect_app, parse_request, project_summary)
from event_twin_nat.worker import LocalBoundary


class BridgeTest(unittest.TestCase):
    @staticmethod
    def project_with_results():
        candidates = [{"id": chr(65 + i), "name": "private candidate name"}
                      for i in range(16)]
        results = [{"candidateId": c["id"], "completed": 100 + i,
                    "rate": 50 + i / 10, "waitP90": 5, "cost": 50000000 + i * 100000,
                    "consents": 300, "feasible": True, "reasons": [],
                    "range": {"low": 45, "high": 55},
                    "samples": [{"notes": "private trajectory"}]}
                   for i, c in enumerate(candidates)]
        assumptions = {"budget": 60000000, "minCompletionRate": 40,
                       "maxWaitMinutes": 12, "minConsent": 240,
                       "seed": 42, "replications": 12}
        return {"project": {"id": "EVT-test", "version": 4,
                            "inputRevision": 2, "assumptions": assumptions,
                            "candidates": candidates, "selectedId": "P",
                            "simulation": {"id": "SIM-test", "inputRevision": 2,
                                           "method": "paired-seeded-discrete-event-v1 (uncalibrated)",
                                           "policy": {"calibration": "uncalibrated"},
                                           "pairedSamples": True, "seed": 42,
                                           "replications": 12, "assumptions": assumptions,
                                           "results": results, "recommendedId": "P"},
                            "crm": {"people": [{"email": "private@example.com"}]},
                            "messages": [{"content": "private chat"}],
                            "attachments": ["private photo"]}}

    def test_config_rejects_external_origins(self):
        for url in ["https://127.0.0.1:4180", "http://example.com:4180", "http://localhost:4180", "http://127.0.0.1:4180/private", "http://u:p@127.0.0.1:4180", "http://127.0.0.1:4180/?a=1"]:
            with self.assertRaises(ValueError):
                EventTwinConfig(app_base_url=url)

    def test_only_explicit_read_tools(self):
        self.assertEqual(parse_request('health'), ('health', '/api/health'))
        self.assertEqual(parse_request('{"tool":"experiment_audit","projectId":"EVT-1"}'),
                         ('experiment_audit', '/api/projects/EVT-1'))
        for message in ['run_simulation', '{"tool":"approve","projectId":"EVT-1"}', '{"tool":"project_summary","projectId":"../export"}', '{"tool":"project_summary","projectId":"EVT-1","url":"evil"}']:
            with self.assertRaises(ValueError):
                parse_request(message)

    def test_summary_matches_domain_and_strips_private_data(self):
        result = project_summary({"project": {"id": "EVT-1", "version": 3, "inputRevision": 2,
            "space": {"width": 24, "depth": 18, "notes": "private"}, "simulation": {"id": "BAT-1"},
            "selectedId": "gallery-1", "approval": {}, "crm": {"people": [{"email": "private@example.com"}], "deployment": {"id": "DEP-1"}},
            "messages": [{"content": "private chat"}], "attachments": ["data:image/png;base64,secret"]}})
        self.assertEqual(result["version"], 3)
        self.assertEqual(result["selection"], "gallery-1")
        self.assertEqual(result["batchId"], "BAT-1")
        self.assertEqual(result["crmRecordCount"], 1)
        self.assertTrue(result["deploymentPresent"])
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("messages", result)

    def test_audit_ranks_all_persisted_results_and_strips_private_fields(self):
        result = experiment_audit(self.project_with_results())
        self.assertEqual(result["status"], "audited")
        self.assertEqual(result["candidateCount"], 16)
        self.assertEqual(len(result["results"]), 16)
        self.assertEqual(result["rankedFeasibleIds"][0], "P")
        self.assertEqual(result["recommendedId"], "P")
        self.assertFalse(result["evidence"]["forecastValidated"])
        self.assertEqual(result["results"][0]["sourcePath"], "simulation.results[0]")
        output = json.dumps(result)
        for secret in ("private candidate name", "private@example.com", "private chat",
                       "private photo", "private trajectory"):
            self.assertNotIn(secret, output)

    def test_audit_rejects_stale_mismatched_and_inconsistent_results(self):
        project = self.project_with_results()
        project["project"]["simulation"]["inputRevision"] = 1
        self.assertEqual(experiment_audit(project)["status"], "stale")
        project = self.project_with_results()
        project["project"]["simulation"]["results"][0]["candidateId"] = "P"
        self.assertEqual(experiment_audit(project)["issueCodes"], ["CANDIDATE_RESULT_MISMATCH"])
        project = self.project_with_results()
        project["project"]["simulation"]["results"][0]["cost"] = 70000000
        self.assertEqual(experiment_audit(project)["issueCodes"], ["FEASIBILITY_CONTRADICTION"])
        project["project"]["simulation"]["results"][0]["feasible"] = False
        project["project"]["simulation"]["results"][0]["reasons"] = ["예산 초과"]
        audited = experiment_audit(project)
        self.assertEqual(audited["status"], "audited")
        self.assertEqual(audited["feasibleCount"], 15)
        self.assertEqual(audited["results"][0]["reasonCodes"], ["BUDGET_EXCEEDED"])
        project = self.project_with_results()
        project["project"]["simulation"] = None
        self.assertEqual(experiment_audit(project)["status"], "not_run")

    def test_audit_real_http_read_without_inference_or_private_output(self):
        body = json.dumps(self.project_with_results()).encode()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != '/api/projects/EVT-test':
                    self.send_response(404); self.end_headers(); return
                self.send_response(200); self.end_headers(); self.wfile.write(body)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            config = EventTwinConfig(app_base_url=f'http://127.0.0.1:{server.server_port}')
            output = asyncio.run(inspect_app(config, '{"tool":"experiment_audit","projectId":"EVT-test"}'))
            receipt = json.loads(output)
            self.assertEqual(receipt["tool"], "experiment_audit")
            self.assertTrue(receipt["readOnly"])
            self.assertFalse(receipt["inferencePerformed"])
            self.assertEqual(receipt["result"]["candidateCount"], 16)
            self.assertNotIn("private", output)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_real_http_bridge_without_model(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                payload = json.dumps({"ok": True, "modelConfigured": False, "secret": "never-forward"}).encode()
                self.send_response(200); self.end_headers(); self.wfile.write(payload)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            config = EventTwinConfig(app_base_url=f'http://127.0.0.1:{server.server_port}')
            output = asyncio.run(inspect_app(config, 'health'))
            result = json.loads(output)
            self.assertEqual(result['framework'], 'nvidia-nat')
            self.assertEqual(result['version'], '1.9.0')
            self.assertFalse(result['inferencePerformed'])
            self.assertTrue(result['result']['ok'])
            self.assertNotIn('never-forward', output)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_http_boundary_rejects_rebinding_cross_origin_and_large_body(self):
        async def run_case(headers, body=b'{}', path='/generate'):
            calls, sent = [], []
            async def app(*_args): calls.append(True)
            async def receive(): return {'type': 'http.request', 'body': body, 'more_body': False}
            async def send(event): sent.append(event)
            await LocalBoundary(app)({'type': 'http', 'method': 'POST', 'path': path, 'headers': headers}, receive, send)
            return calls, sent[0].get('status') if sent else 200
        good = [(b'host', b'127.0.0.1:8008'), (b'content-type', b'application/json')]
        for headers, body, path, expected in [
            (good + [(b'origin', b'https://evil.example')], b'{}', '/generate', 403),
            ([(b'host', b'evil.example:8008')], b'{}', '/generate', 403),
            (good, b'x' * 4097, '/generate', 413),
            (good, b'{}', '/v1/chat/completions', 404),
        ]:
            calls, status = asyncio.run(run_case(headers, body, path))
            self.assertFalse(calls); self.assertEqual(status, expected)


if __name__ == '__main__':
    unittest.main()
