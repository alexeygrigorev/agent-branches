#!/usr/bin/env python3
"""
Real Browser Playwright DOM Negative End-to-End Test Suite (C-1399 & C-1409).

Loads index.html in a real headless Chromium browser instance via Playwright,
serving static UI assets and dynamic /status endpoints.

Tests:
1. test_01_clean_to_503_downgrade_and_recovery:
   - Initial 200 Clean: pair renders green '.badge.clean', #status-error hidden.
   - Status 503 Outage: #status-error appears, clean badge is downgraded to '.badge.unknown',
     ZERO '.badge.clean' elements exist anywhere in the DOM.
   - Recovery 200: #status-error hides, green '.badge.clean' is restored.
2. test_02_out_of_order_stale_response_does_not_restore_green:
   - Verifies single-flight generation guard in live DOM: out-of-order delayed clean
     reply settling after newer failure does NOT restore green badges.
3. test_03_initial_503_no_last_status_does_not_throw:
   - Fresh page boot when /status is 503 immediately: no unhandled exceptions thrown,
     error surfaced, zero clean badges.
"""

import http.server
import json
import os
import socketserver
import sys
import threading
import time
import unittest
from playwright.sync_api import sync_playwright

UI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
default_scratch = os.path.abspath(os.path.join(UI_DIR, "../../.local/scratch"))
scratch_dir = os.environ.get("TMPDIR", default_scratch)
os.makedirs(scratch_dir, exist_ok=True)
os.environ["TMPDIR"] = scratch_dir

CLEAN_STATUS = {
    "agents": [
        {"agentId": "agent-alpha", "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "intent": "feature auth", "pushes": 1, "taskId": "task-alpha"},
        {"agentId": "agent-beta", "head": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "intent": "feature billing", "pushes": 1, "taskId": "task-beta"}
    ],
    "heads": {
        "agent-alpha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "agent-beta": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "pairs": [
        {
            "pair": ["agent-alpha", "agent-beta"],
            "status": "clean",
            "heads": {
                "agent-alpha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "agent-beta": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            },
            "coverage": {
                "tests_collected": 12
            }
        }
    ],
    "warnings": [],
    "unprocessedPushes": []
}

class MockUIHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=UI_DIR, **kwargs)

    def log_message(self, format, *args):
        # suppress noisy access logs during test run
        pass

    def do_GET(self):
        if self.path.startswith("/status"):
            state = self.server.ui_state
            mode = state.get("mode", "clean")
            delay_s = state.get("delay_s", 0)
            if delay_s > 0:
                time.sleep(delay_s)

            if mode == "clean":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(CLEAN_STATUS).encode("utf-8"))
            elif mode == "503":
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b'{"error": "status server outage 503"}')
            elif mode == "empty":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b"")
            else:
                self.send_response(500)
                self.end_headers()
        elif self.path.startswith("/tasks/"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            task_data = {
                "taskId": "task-alpha",
                "agentId": "agent-alpha",
                "forkName": "agent-branches-canonical-agent-alpha",
                "ref": "refs/heads/main",
                "createdAt": "2026-10-03T12:00:00.000Z",
                "agent": {
                    "agentId": "agent-alpha",
                    "taskId": "task-alpha",
                    "forkName": "agent-branches-canonical-agent-alpha",
                    "ref": "refs/heads/main",
                    "intent": "feature auth",
                    "baseSha": "0000000000000000000000000000000000000000",
                    "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "pushes": 1,
                    "createdAt": "2026-10-03T12:00:00.000Z",
                    "pushLog": [
                        {
                            "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "at": "2026-10-03T12:00:00.000Z",
                            "message": "feature auth"
                        }
                    ],
                    "testEvidence": {
                        "command": "npm test",
                        "exitCode": 0,
                        "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "at": "2026-10-03T12:00:00.000Z"
                    }
                },
                "warnings": []
            }
            self.wfile.write(json.dumps(task_data).encode("utf-8"))
        else:
            super().do_GET()


class MockServer(socketserver.TCPServer):
    allow_reuse_address = True
    def __init__(self, server_address, handler_class):
        self.ui_state = {"mode": "clean", "delay_s": 0}
        super().__init__(server_address, handler_class)


class TestDOMNegativeBrowser(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = MockServer(("127.0.0.1", 0), MockUIHandler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def test_01_clean_to_503_downgrade_and_recovery(self):
        """
        Phase 1: Serve clean matching heads -> assert green .badge.clean present.
        Phase 2: Transition to 503 -> refresh -> assert #status-error banner visible,
                 assert ZERO .badge.clean in entire DOM, assert pair badge is .badge.unknown.
        Phase 3: Recovery back to 200 -> refresh -> assert #status-error hidden,
                 assert .badge.clean returns.
        """
        self.server.ui_state = {"mode": "clean", "delay_s": 0}
        page = self.browser.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        url = f"http://127.0.0.1:{self.port}/index.html?api=http://127.0.0.1:{self.port}"
        page.goto(url)

        # 1. Initial Clean Load
        page.wait_for_selector(".pair", timeout=5000)
        page.wait_for_function("document.getElementById('loading').hidden === true")

        status_error = page.locator("#status-error")
        self.assertTrue(status_error.get_attribute("hidden") is not None or not status_error.is_visible())

        clean_badges = page.locator(".pair .badge.clean")
        self.assertEqual(clean_badges.count(), 1, "Expected exactly 1 clean pair badge on fresh load")
        self.assertIn("Clean — tests ran", clean_badges.first.text_content())

        # 2. Switch server to 503 outage
        self.server.ui_state = {"mode": "503", "delay_s": 0}
        # Trigger refresh via client
        page.evaluate("window.AgentBranchesUI.bootIndex()")

        # Wait for status-error alert to show
        page.wait_for_function("document.getElementById('status-error').hidden === false", timeout=5000)
        err_text = page.locator("#status-error").text_content()
        self.assertIn("Live status is out of date", err_text)
        self.assertIn("HTTP 503", err_text)

        # CRITICAL DOM NEGATIVE ASSERTION:
        # Zero dynamic green .badge.clean elements in the pair status list during outage!
        remaining_clean = page.locator(".pair .badge.clean").count()
        self.assertEqual(remaining_clean, 0, "No green .badge.clean elements may remain in .pair during 503 outage!")
        self.assertEqual(page.locator("#pairs .badge.clean").count(), 0, "No green .badge.clean elements in #pairs")
        # Clarify distinction: static legend swatch in index.html is 1, dynamic pair count is 0
        self.assertEqual(page.locator(".legend .badge.clean").count(), 1, "Static documentation legend swatch preserved")

        unknown_badges = page.locator(".pair .badge.unknown")
        self.assertEqual(unknown_badges.count(), 1, "Expected pair badge to be downgraded to unknown")
        self.assertIn("Unknown — not safe", unknown_badges.first.text_content())

        why_text = page.locator(".pair .why").first.text_content()
        self.assertIn("treated as unknown, not clean", why_text)
        self.assertIn("HTTP 503", why_text)

        # 3. Recovery: Switch server back to 200 Clean
        self.server.ui_state = {"mode": "clean", "delay_s": 0}
        page.evaluate("window.AgentBranchesUI.bootIndex()")

        page.wait_for_function("document.getElementById('status-error').hidden === true", timeout=5000)
        recovered_clean = page.locator(".pair .badge.clean")
        self.assertEqual(recovered_clean.count(), 1, "Expected green .badge.clean to recover on successful 200")
        self.assertIn("Clean — tests ran", recovered_clean.first.text_content())

        page.close()
        self.assertEqual(page_errors, [], f"Unexpected page errors: {page_errors}")

    def test_02_out_of_order_stale_response_does_not_restore_green(self):
        """
        Single-flight generation guard in live DOM:
        A slow clean response settling after a newer 503 failure has settled must be dropped
        and MUST NOT restore green badges or clear the stale error banner.
        """
        self.server.ui_state = {"mode": "clean", "delay_s": 0}
        page = self.browser.new_page()
        page.goto(f"http://127.0.0.1:{self.port}/index.html?api=http://127.0.0.1:{self.port}")
        page.wait_for_selector(".pair", timeout=5000)

        # Verify initial clean state
        self.assertEqual(page.locator(".pair .badge.clean").count(), 1)

        # Trigger out-of-order scenario:
        # In browser JS, launch request A (delayed clean), then request B (fast 503).
        # When B completes first, status is marked stale and badges downgraded to unknown.
        # When A completes later, generation guard must reject A and leave badges unknown.
        res = page.evaluate("""
            async () => {
                // Mock fetch to simulate delayed A followed by fast B
                const originalFetch = window.fetch;
                let fetchCount = 0;
                window.fetch = (url, opts) => {
                    fetchCount++;
                    if (url.includes('/status')) {
                        if (fetchCount === 1) {
                            // Request A: delayed clean reply (300ms)
                            return new Promise((resolve) => {
                                setTimeout(() => {
                                    resolve(new Response(JSON.stringify(""" + json.dumps(CLEAN_STATUS) + """), {
                                        status: 200,
                                        headers: {'Content-Type': 'application/json'}
                                    }));
                                }, 300);
                            });
                        } else {
                            // Request B: fast 503 failure (50ms)
                            return new Promise((resolve) => {
                                setTimeout(() => {
                                    resolve(new Response(JSON.stringify({error: 'fast 503'}), {
                                        status: 503,
                                        headers: {'Content-Type': 'application/json'}
                                    }));
                                }, 50);
                            });
                        }
                    }
                    return originalFetch(url, opts);
                };

                // Launch A, then shortly launch B
                window.AgentBranchesUI.bootIndex();
                await new Promise(r => setTimeout(r, 20));
                window.AgentBranchesUI.bootIndex();

                // Wait 450ms for both to settle
                await new Promise(r => setTimeout(r, 450));
                window.fetch = originalFetch;
                return true;
            }
        """)
        self.assertTrue(res)

        # After both have settled:
        # Request B (503) was newer and settled first.
        # Request A (200) settled later and must have been dropped by genTracker.settle(gen)!
        # Therefore, #status-error must be visible and .badge.clean must be ZERO!
        self.assertFalse(page.locator("#status-error").is_hidden(), "Stale error banner must remain visible")
        self.assertEqual(
            page.locator(".pair .badge.clean").count(),
            0,
            "Late clean response from older request must NOT restore green badges!"
        )
        self.assertEqual(
            page.locator(".pair .badge.unknown").count(),
            1,
            "Pair badge must remain unknown after out-of-order resolution"
        )
        page.close()

    def test_03_initial_503_no_last_status_does_not_throw(self):
        """
        Initial 503 outage with zero previous lastStatus:
        Page must boot cleanly without unhandled JavaScript exceptions,
        loading must hide, error must be surfaced, and zero clean badges rendered.
        """
        self.server.ui_state = {"mode": "503", "delay_s": 0}
        page = self.browser.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        url = f"http://127.0.0.1:{self.port}/index.html?api=http://127.0.0.1:{self.port}"
        page.goto(url)

        # Wait for loading to finish
        page.wait_for_function("document.getElementById('loading').hidden === true", timeout=5000)

        # Error banner must be visible
        err_banner = page.locator("#error")
        status_err_banner = page.locator("#status-error")
        has_error = (not err_banner.is_hidden()) or (not status_err_banner.is_hidden())
        self.assertTrue(has_error, "Either #error or #status-error must be visible on initial 503")

        # Zero dynamic clean badges in pair status or agent cards
        self.assertEqual(page.locator("#pairs .badge.clean").count(), 0, "No dynamic clean badges in #pairs")
        self.assertEqual(page.locator("#agents .badge.clean").count(), 0, "No dynamic clean badges in #agents")

        # Zero uncaught page exceptions
        page.close()
        self.assertEqual(page_errors, [], f"Page threw unhandled exceptions: {page_errors}")

    def test_04_task_view_stale_behavior(self):
        """
        Task view (task.html) stale status behavior (C-1385 & C-1426):
        1. Clean 200: Historical Passed run matches latest change, zero unknown badges in #evidence.
        2. 503 Outage:
           - #status-error alert displayed.
           - Historical fact PRESERVED: Result remains 'Passed' (exit 0 did occur at tested commit).
           - Live head match UNCONFIRMED: Tested change shows '(live status unconfirmed · HTTP 503)'.
           - Current-head safety DOWNGRADED: #evidence surfaces '.badge.unknown' ('Unknown — not safe').
        3. Recovery 200:
           - #status-error hidden.
           - Tested change restores '(the latest change)'.
           - #evidence '.badge.unknown' removed (count 0).
        """
        self.server.ui_state = {"mode": "clean", "delay_s": 0}
        page = self.browser.new_page()
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        url = f"http://127.0.0.1:{self.port}/task.html?id=task-alpha&api=http://127.0.0.1:{self.port}"
        page.goto(url)

        # Wait for task content to load
        page.wait_for_selector("#task-head", timeout=5000)
        page.wait_for_function("document.getElementById('loading').hidden === true", timeout=5000)

        # 1. Clean 200 checks
        self.assertIn("agent-alpha", page.locator("#task-head").text_content())
        status_error = page.locator("#status-error")
        self.assertTrue(status_error.get_attribute("hidden") is not None or not status_error.is_visible())

        # Evidence: historical Passed, matches current head, 0 unknown badges
        self.assertIn("Passed", page.locator("#evidence .badge.clean").text_content())
        self.assertIn("(the latest change)", page.locator("#evidence").text_content())
        self.assertEqual(page.locator("#evidence .badge.unknown").count(), 0)

        # 2. Switch server to 503 outage and re-boot task view
        self.server.ui_state = {"mode": "503", "delay_s": 0}
        page.evaluate("window.AgentBranchesUI.bootTask('task-alpha')")

        # Wait for status-error alert to show
        page.wait_for_function("document.getElementById('status-error').hidden === false", timeout=5000)
        err_text = page.locator("#status-error").text_content()
        self.assertIn("Live status is out of date", err_text)
        self.assertIn("HTTP 503", err_text)

        # CRITICAL DOM NEGATIVE ASSERTION ON TASK VIEW (C-1426):
        # Historical fact is preserved: Result still displays 'Passed'
        self.assertIn("Passed", page.locator("#evidence .badge.clean").text_content())
        # Current head match is unconfirmed during outage
        self.assertIn("live status unconfirmed", page.locator("#evidence").text_content())
        # Current head safety verdict is strictly downgraded to unknown (not safe)
        self.assertEqual(page.locator("#evidence .badge.unknown").count(), 1, "Evidence must surface Unknown — not safe during outage")
        self.assertIn("Unknown — not safe", page.locator("#evidence .badge.unknown").first.text_content())
        self.assertIn("whether tests ran at the true current head is unknown, not safe", page.locator("#evidence").text_content())

        # 3. Recovery: Switch server back to 200 Clean
        self.server.ui_state = {"mode": "clean", "delay_s": 0}
        page.evaluate("window.AgentBranchesUI.bootTask('task-alpha')")

        page.wait_for_function("document.getElementById('status-error').hidden === true", timeout=5000)
        self.assertIn("Passed", page.locator("#evidence .badge.clean").text_content())
        self.assertIn("(the latest change)", page.locator("#evidence").text_content())
        self.assertEqual(page.locator("#evidence .badge.unknown").count(), 0, "Unknown badge removed upon 200 recovery")

        page.close()
        self.assertEqual(page_errors, [], f"Page threw unhandled exceptions: {page_errors}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
