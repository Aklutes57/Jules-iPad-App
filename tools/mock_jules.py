#!/usr/bin/env python3
"""A local stand-in for the Jules API, for developing and testing offline.

Standard library only - no pip install, no virtualenv.

    python3 tools/mock_jules.py

Then point the app at it by opening it with the localhost override:

    http://localhost:8080/?apiBase=http://localhost:8787/v1alpha

and paste the API key `test-key-123` when the app asks for one.

Environment variables
---------------------
    PORT=8787       port to listen on
    EMPTY=1         GET /sources returns nothing, to exercise the empty state
    RATELIMIT=1     every 3rd request answers 429 with Retry-After: 1

What it imitates
----------------
* Base path /v1alpha, auth via the X-Goog-Api-Key header.
* CORS wide open on every single response - success, error and preflight -
  because the real Jules API is reachable straight from a browser.
* Google's JSON error envelope, including the genuinely misleading 401 you get
  from a wrong key ("API keys are not supported by this API...").
* A scripted session lifecycle that advances exactly one step each time the
  client polls .../activities, so a test can drive a whole task to completion
  deterministically instead of sleeping.

Deliberate fidelity choice
--------------------------
Like real Google JSON APIs, empty repeated fields are OMITTED rather than sent
as []. `sources`, `sessions`, `activities`, `artifacts` and `outputs` simply
will not be there when they are empty, so client code has to cope with
`data.sources` being undefined. That is not an oversight - it is the behaviour
the real API has, and the reason to test against it.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

BASE_PATH = "/v1alpha"
VALID_API_KEY = "test-key-123"

PORT = int(os.environ.get("PORT", "8787"))
EMPTY_SOURCES = os.environ.get("EMPTY", "") not in ("", "0", "false")
RATE_LIMIT = os.environ.get("RATELIMIT", "") not in ("", "0", "false")

STATE_LOCK = threading.RLock()

# --------------------------------------------------------------------------
# Monotonic clock: every timestamp handed out is strictly greater than the last,
# so `create_time>"..."` incremental polling is exact and never re-delivers or
# skips an activity.
# --------------------------------------------------------------------------

_CLOCK_LOCK = threading.Lock()
_CLOCK = [datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=1)]


def next_timestamp() -> str:
    with _CLOCK_LOCK:
        _CLOCK[0] += timedelta(seconds=1)
        return _CLOCK[0].strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_rfc3339(text: str):
    """Lenient RFC3339 parse; returns None if it cannot be read."""
    text = text.strip().strip('"').strip("'")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------

def _source(owner: str, repo: str, default_branch: str, branches, private: bool) -> dict:
    return {
        "name": f"sources/github/{owner}/{repo}",
        "id": f"github/{owner}/{repo}",
        "githubRepo": {
            "owner": owner,
            "repo": repo,
            "isPrivate": private,
            "defaultBranch": {"displayName": default_branch},
            "branches": [{"displayName": b} for b in branches],
        },
    }


SOURCES = [
    _source("octo-labs", "atlas-web", "main",
            ["main", "develop", "feature/search-rework"], private=False),
    _source("octo-labs", "pantry-api", "main",
            ["main", "release/2.4", "hotfix/token-refresh"], private=True),
    _source("ayden-lutes", "cs401-final-project", "main",
            ["main", "gh-pages"], private=True),
]


# --------------------------------------------------------------------------
# Canned artifact payloads
# --------------------------------------------------------------------------

FAILING_TEST_OUTPUT = """> atlas-web@2.4.0 test
> node --test test/

TAP version 13
# Subtest: formatBytes
    # Subtest: renders zero
    ok 1 - renders zero
    # Subtest: clamps oversized values
    not ok 2 - clamps oversized values
      ---
      error: "Expected values to be strictly equal: '1024.0 GB' !== '1.0 TB'"
      code: 'ERR_ASSERTION'
      ...
    1..2
not ok 1 - formatBytes
1..1
# tests 2
# pass 1
# fail 1
"""

PASSING_TEST_OUTPUT = """> atlas-web@2.4.0 test
> node --test test/

TAP version 13
# Subtest: formatBytes
    ok 1 - renders zero
    ok 2 - clamps oversized values
    ok 3 - rejects negative and non-finite input
    1..3
ok 1 - formatBytes
1..1
# tests 3
# pass 3
# fail 0
"""

UNIDIFF_PATCH = """diff --git a/src/lib/format.js b/src/lib/format.js
index 8f3c1a2f..b41d9e07 100644
--- a/src/lib/format.js
+++ b/src/lib/format.js
@@ -1,14 +1,23 @@
-const UNITS = ['B', 'KB', 'MB', 'GB'];
+const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

+/**
+ * Render a byte count for humans. Returns 'unknown' for input that is not a
+ * usable size rather than leaking NaN into the UI.
+ */
 export function formatBytes(bytes) {
+  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
+    return 'unknown';
+  }
   if (bytes === 0) {
     return '0 B';
   }
   const exponent = Math.floor(Math.log(bytes) / Math.log(1024));
-  const value = bytes / Math.pow(1024, exponent);
-  return value.toFixed(1) + ' ' + UNITS[exponent];
+  const clamped = Math.min(exponent, UNITS.length - 1);
+  const value = bytes / Math.pow(1024, clamped);
+  const digits = clamped === 0 ? 0 : 1;
+  return value.toFixed(digits) + ' ' + UNITS[clamped];
 }

 export function formatDuration(ms) {
diff --git a/src/components/FileRow.js b/src/components/FileRow.js
index 2ab7c910..d5e6f188 100644
--- a/src/components/FileRow.js
+++ b/src/components/FileRow.js
@@ -18,7 +18,7 @@ export function FileRow({ file }) {
   const size = document.createElement('span');
   size.className = 'file-row__size';
-  size.textContent = formatBytes(file.sizeInBytes);
+  size.textContent = formatBytes(file.sizeInBytes ?? null);
   row.append(name, size);
   return row;
 }
diff --git a/test/format.test.js b/test/format.test.js
new file mode 100644
index 00000000..1c9b7a34
--- /dev/null
+++ b/test/format.test.js
@@ -0,0 +1,21 @@
+import assert from 'node:assert/strict';
+import test from 'node:test';
+import { formatBytes } from '../src/lib/format.js';
+
+test('formatBytes', async (t) => {
+  await t.test('renders zero', () => {
+    assert.equal(formatBytes(0), '0 B');
+  });
+
+  await t.test('clamps oversized values', () => {
+    assert.equal(formatBytes(1024 ** 5), '1024.0 TB');
+  });
+
+  await t.test('rejects negative and non-finite input', () => {
+    assert.equal(formatBytes(-1), 'unknown');
+    assert.equal(formatBytes(NaN), 'unknown');
+    assert.equal(formatBytes(null), 'unknown');
+  });
+});
"""

SUGGESTED_COMMIT_MESSAGE = (
    "Handle oversized and invalid byte counts in formatBytes\n"
    "\n"
    "formatBytes indexed UNITS with an unclamped exponent, so anything at or\n"
    "above 1 TB produced 'undefined' and negative or non-finite input rendered\n"
    "as NaN. Clamp the exponent, add a TB unit, and return 'unknown' for input\n"
    "that is not a usable size. Adds unit tests covering all three cases."
)


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------

_SESSION_SEQ = [0]
SESSIONS: dict = {}          # id -> session dict


def _new_session_id() -> str:
    _SESSION_SEQ[0] += 1
    return str(7300000000000000000 + _SESSION_SEQ[0])


def add_activity(session: dict, originator: str, description: str,
                 union_key: str, union_value, artifacts=None) -> dict:
    """Append one activity. Exactly one union field, per the real Activity."""
    session["_activity_seq"] += 1
    activity_id = f"a{session['_activity_seq']:04d}"
    activity = {
        "name": f"sessions/{session['id']}/activities/{activity_id}",
        "id": activity_id,
        "description": description,
        "createTime": next_timestamp(),
        "originator": originator,
    }
    if artifacts:
        activity["artifacts"] = artifacts
    activity[union_key] = union_value
    session["_activities"].append(activity)
    session["updateTime"] = activity["createTime"]
    return activity


def _emit_plan_approved(session: dict, originator: str) -> None:
    session["_plan_approved"] = True
    session["state"] = "IN_PROGRESS"
    add_activity(
        session, originator, "Plan approved",
        "planApproved", {"planId": session["_plan_id"]},
    )


# -- the scripted lifecycle, one function per poll --------------------------

def _step_start_planning(session: dict) -> None:
    session["state"] = "PLANNING"
    add_activity(
        session, "agent", "Agent message", "agentMessaged",
        {"agentMessage":
            "Got it. I'm cloning the repository and reading through the "
            "relevant files so I can put a plan together."},
    )


def _step_generate_plan(session: dict) -> None:
    session["_plan_id"] = "plan-01"
    add_activity(
        session, "agent", "Plan generated", "planGenerated",
        {"plan": {
            "id": "plan-01",
            "steps": [
                {"id": "step-1", "index": 0,
                 "title": "Reproduce the problem",
                 "description":
                     "Add a failing test that demonstrates the current "
                     "behaviour so the fix can be verified."},
                {"id": "step-2", "index": 1,
                 "title": "Implement the fix",
                 "description":
                     "Update the implementation, keeping the existing public "
                     "API unchanged so no callers need to change."},
                {"id": "step-3", "index": 2,
                 "title": "Run the full test suite",
                 "description":
                     "Confirm the new test passes and nothing else regressed, "
                     "then prepare the change set."},
            ],
        }},
    )
    if session["requirePlanApproval"]:
        session["state"] = "AWAITING_PLAN_APPROVAL"


def _step_auto_approve(session: dict) -> None:
    # Only reached when requirePlanApproval was false - API-created sessions
    # auto-approve. An explicit :approvePlan call jumps the step counter past
    # this one so the approval is never emitted twice.
    if not session["_plan_approved"]:
        _emit_plan_approved(session, "system")


def _step_setup(session: dict) -> None:
    session["state"] = "IN_PROGRESS"
    add_activity(
        session, "agent", "Progress update", "progressUpdated",
        {"title": "Setting up the workspace",
         "description": "Installing dependencies and warming the build cache."},
    )


def _step_tests_failing(session: dict) -> None:
    add_activity(
        session, "agent", "Progress update", "progressUpdated",
        {"title": "Running the test suite",
         "description": "Established a baseline before changing anything."},
        artifacts=[{"bashOutput": {
            "command": "npm test",
            "output": FAILING_TEST_OUTPUT,
            "exitCode": 1,
        }}],
    )


def _step_agent_explains(session: dict) -> None:
    add_activity(
        session, "agent", "Agent message", "agentMessaged",
        {"agentMessage":
            "Found it. formatBytes() indexes the UNITS array with an "
            "unclamped exponent, so any size of 1 TB or more falls off the "
            "end of the array and renders as 'undefined'. Negative and "
            "non-finite input slips through as NaN as well. I'm clamping the "
            "exponent, adding a TB unit, and returning 'unknown' for input "
            "that is not a usable size."},
    )


def _step_tests_passing(session: dict) -> None:
    add_activity(
        session, "agent", "Progress update", "progressUpdated",
        {"title": "Re-running the test suite",
         "description": "All green, including the three new cases."},
        artifacts=[{"bashOutput": {
            "command": "npm test",
            "output": PASSING_TEST_OUTPUT,
            "exitCode": 0,
        }}],
    )


def _step_change_set(session: dict) -> None:
    add_activity(
        session, "agent", "Change set ready", "progressUpdated",
        {"title": "Prepared the change set",
         "description": "Three files changed across the fix and its tests."},
        artifacts=[{"changeSet": {"gitPatch": {
            "unidiffPatch": UNIDIFF_PATCH,
            "baseCommitId": "9f2c41d8e7b3a05c6d1e8f4a2b7c093e5d6a1b84",
            "suggestedCommitMessage": SUGGESTED_COMMIT_MESSAGE,
        }}}],
    )


def _step_complete(session: dict) -> None:
    session["state"] = "COMPLETED"
    session["outputs"] = [{"pullRequest": {
        "url": "https://github.com/example/repo/pull/1",
        "title": "Handle oversized and invalid byte counts in formatBytes",
        "description":
            "formatBytes() indexed UNITS with an unclamped exponent, so sizes "
            "of 1 TB and above rendered as 'undefined' and negative or "
            "non-finite input rendered as NaN.\n\n"
            "Clamps the exponent, adds a TB unit, and returns 'unknown' for "
            "input that is not a usable size. Adds unit tests for all three "
            "cases.",
        "baseRef": "main",
        "headRef": "jules/format-bytes-clamping",
    }}]
    add_activity(session, "agent", "Session completed", "sessionCompleted", {})


LIFECYCLE = [
    _step_start_planning,
    _step_generate_plan,
    _step_auto_approve,
    _step_setup,
    _step_tests_failing,
    _step_agent_explains,
    _step_tests_passing,
    _step_change_set,
    _step_complete,
]

# Index of the step that _step_auto_approve occupies; :approvePlan skips past it.
_APPROVAL_STEP = LIFECYCLE.index(_step_auto_approve)


def advance(session: dict) -> None:
    """Move the session on by exactly one step. Called on each activities poll."""
    # Answering the user always takes priority over making progress.
    if session["_pending_replies"]:
        reply = session["_pending_replies"].pop(0)
        add_activity(session, "agent", "Agent message", "agentMessaged",
                     {"agentMessage": reply})
        return

    if session["state"] == "AWAITING_PLAN_APPROVAL":
        return  # blocked until :approvePlan
    if session["archived"] or session["_step"] >= len(LIFECYCLE):
        return

    step = LIFECYCLE[session["_step"]]
    session["_step"] += 1
    step(session)


def public_session(session: dict) -> dict:
    """Strip internal bookkeeping and drop empty repeated fields, as the real
    API does."""
    out = {k: v for k, v in session.items() if not k.startswith("_") and v is not None}
    if not out.get("outputs"):
        out.pop("outputs", None)
    return out


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------

def error_body(code: int, message: str, status: str, reason: str) -> dict:
    return {"error": {
        "code": code,
        "message": message,
        "status": status,
        "details": [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            "reason": reason,
            "domain": "googleapis.com",
            "metadata": {"service": "jules.googleapis.com"},
        }],
    }}


# The real, thoroughly confusing 401 you get from a key that is not a valid
# Jules key. Note it says API keys are not supported even though they are -
# clients must surface this verbatim rather than trying to interpret it.
UNAUTHENTICATED_MESSAGE = (
    "API keys are not supported by this API. Expected OAuth2 access token or "
    "other authentication credentials that assert a principal. See "
    "https://cloud.google.com/docs/authentication"
)


# --------------------------------------------------------------------------
# Pagination
# --------------------------------------------------------------------------

def paginate(items, params, default_size: int, max_size: int = 100):
    def first(name, fallback=None):
        values = params.get(name)
        return values[0] if values else fallback

    try:
        size = int(first("pageSize") or default_size)
    except ValueError:
        size = default_size
    size = max(1, min(size, max_size))

    try:
        start = max(0, int(first("pageToken") or 0))
    except ValueError:
        start = 0

    page = items[start:start + size]
    token = str(start + size) if start + size < len(items) else None
    return page, token


_CREATE_TIME_RE = re.compile(
    r"create_?time\s*>\s*[\"']?([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+\-Z]+)[\"']?",
    re.IGNORECASE,
)
_ARCHIVED_RE = re.compile(r"archived\s*=\s*(true|false)", re.IGNORECASE)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

_REQUEST_COUNT = [0]


class MockJulesHandler(BaseHTTPRequestHandler):
    server_version = "MockJules/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------

    def _cors_headers(self) -> None:
        # Mirrors the real Jules API: open to any origin, and the key header is
        # explicitly allowed so the browser preflight succeeds.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, DELETE, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "x-goog-api-key, content-type, authorization")
        self.send_header("Access-Control-Max-Age", "3600")
        # Without this the browser cannot read Retry-After off a 429.
        self.send_header("Access-Control-Expose-Headers",
                         "retry-after, content-type")

    def respond(self, status: int, payload=None, extra_headers=None) -> None:
        body = b"" if payload is None else json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=UTF-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def fail(self, code: int, message: str, status: str, reason: str,
             extra_headers=None) -> None:
        self.respond(code, error_body(code, message, status, reason), extra_headers)

    def not_found(self, what: str) -> None:
        self.fail(404, f"{what} not found.", "NOT_FOUND", "RESOURCE_NOT_FOUND")

    def bad_request(self, message: str) -> None:
        self.fail(400, message, "INVALID_ARGUMENT", "INVALID_ARGUMENT")

    def read_json(self):
        """Returns (parsed, ok). An empty body parses as {} - :approvePlan and
        friends legitimately send nothing."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}, True
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, False
        return (parsed, True) if isinstance(parsed, dict) else (None, False)

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    # -- entry points ------------------------------------------------------

    def do_OPTIONS(self):
        # Preflight must never require auth: browsers do not send the API key
        # on the preflight request.
        self.respond(204)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_DELETE(self):
        self.dispatch("DELETE")

    # -- routing -----------------------------------------------------------

    def dispatch(self, method: str) -> None:
        if RATE_LIMIT:
            with STATE_LOCK:
                _REQUEST_COUNT[0] += 1
                throttled = _REQUEST_COUNT[0] % 3 == 0
            if throttled:
                self.fail(
                    429,
                    "Quota exceeded for quota metric 'Requests' and limit "
                    "'Requests per minute' of service 'jules.googleapis.com'.",
                    "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED",
                    extra_headers={"Retry-After": "1"},
                )
                return

        raw_path, _, raw_query = self.path.partition("?")
        path = urllib.parse.unquote(raw_path)
        params = urllib.parse.parse_qs(raw_query)

        if not path.startswith(BASE_PATH):
            self.not_found(f'Path "{path}"')
            return
        rest = path[len(BASE_PATH):]

        # Custom methods hang off the final segment: /sessions/123:archive
        custom = None
        if ":" in rest:
            rest, _, custom = rest.rpartition(":")

        segments = [s for s in rest.split("/") if s]

        # Auth applies to every real endpoint (preflight already returned).
        if self.headers.get("X-Goog-Api-Key") != VALID_API_KEY:
            self.fail(401, UNAUTHENTICATED_MESSAGE,
                      "UNAUTHENTICATED", "CREDENTIALS_MISSING")
            return

        with STATE_LOCK:
            self.route(method, segments, custom, params)

    def route(self, method, segments, custom, params) -> None:
        if segments == ["sources"] and method == "GET" and not custom:
            self.list_sources(params)
            return

        if segments == ["sessions"] and not custom:
            if method == "POST":
                self.create_session()
                return
            if method == "GET":
                self.list_sessions(params)
                return

        if len(segments) == 2 and segments[0] == "sessions":
            session = SESSIONS.get(segments[1])
            if session is None:
                self.not_found(f'Session "sessions/{segments[1]}"')
                return
            if custom:
                if method != "POST":
                    self.not_found(f"Method {method} on :{custom}")
                    return
                self.custom_method(session, custom)
                return
            if method == "GET":
                self.respond(200, public_session(session))
                return
            if method == "DELETE":
                SESSIONS.pop(session["id"], None)
                self.respond(200, {})
                return

        if (len(segments) in (3, 4) and segments[0] == "sessions"
                and segments[2] == "activities" and method == "GET" and not custom):
            session = SESSIONS.get(segments[1])
            if session is None:
                self.not_found(f'Session "sessions/{segments[1]}"')
                return
            if len(segments) == 4:
                self.get_activity(session, segments[3])
            else:
                self.list_activities(session, params)
            return

        self.not_found(f"{method} /{'/'.join(segments)}")

    # -- handlers ----------------------------------------------------------

    def list_sources(self, params) -> None:
        items = [] if EMPTY_SOURCES else SOURCES
        page, token = paginate(items, params, default_size=30, max_size=100)
        body = {}
        if page:
            body["sources"] = page
        if token:
            body["nextPageToken"] = token
        self.respond(200, body)

    def create_session(self) -> None:
        payload, ok = self.read_json()
        if not ok:
            self.bad_request("Request body is not valid JSON.")
            return

        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            self.bad_request(
                "Invalid JSON payload received. Field 'prompt' is required.")
            return

        source_context = payload.get("sourceContext")
        if source_context is not None and not isinstance(source_context, dict):
            self.bad_request(
                "Invalid JSON payload received. Field 'sourceContext' must be "
                "an object.")
            return
        if isinstance(source_context, dict):
            source = source_context.get("source")
            known = {s["name"] for s in SOURCES}
            if not isinstance(source, str) or (not EMPTY_SOURCES and source not in known):
                self.bad_request(
                    f'Invalid sourceContext.source "{source}". Expected one of '
                    "the names returned by ListSources.")
                return

        created = next_timestamp()
        session_id = _new_session_id()
        title = payload.get("title")
        if not isinstance(title, str) or not title.strip():
            title = prompt.strip().splitlines()[0][:80]

        session = {
            "name": f"sessions/{session_id}",
            "id": session_id,
            "prompt": prompt,
            "title": title,
            "state": "QUEUED",
            "url": f"https://jules.google.com/task/{session_id}",
            "archived": False,
            "createTime": created,
            "updateTime": created,
            "requirePlanApproval": bool(payload.get("requirePlanApproval", False)),
            "outputs": [],
            # internals
            "_activities": [],
            "_activity_seq": 0,
            "_step": 0,
            "_plan_id": None,
            "_plan_approved": False,
            "_pending_replies": [],
        }
        if source_context is not None:
            session["sourceContext"] = source_context
        if payload.get("automationMode"):
            session["automationMode"] = payload["automationMode"]

        SESSIONS[session_id] = session
        self.respond(200, public_session(session))

    def list_sessions(self, params) -> None:
        filter_text = (params.get("filter") or [""])[0]
        match = _ARCHIVED_RE.search(filter_text)
        want_archived = bool(match) and match.group(1).lower() == "true"

        # Archived sessions are excluded unless explicitly asked for.
        items = [s for s in SESSIONS.values() if bool(s["archived"]) == want_archived]
        items.sort(key=lambda s: s["createTime"], reverse=True)

        page, token = paginate(items, params, default_size=30, max_size=100)
        body = {}
        if page:
            body["sessions"] = [public_session(s) for s in page]
        if token:
            body["nextPageToken"] = token
        self.respond(200, body)

    def list_activities(self, session, params) -> None:
        # Polling is what drives the scripted lifecycle forward.
        advance(session)

        activities = sorted(session["_activities"], key=lambda a: a["createTime"])

        filter_text = (params.get("filter") or [""])[0]
        match = _CREATE_TIME_RE.search(filter_text)
        if match:
            cutoff = parse_rfc3339(match.group(1))
            if cutoff is not None:
                activities = [
                    a for a in activities
                    if (parse_rfc3339(a["createTime"]) or cutoff) > cutoff
                ]

        page, token = paginate(activities, params, default_size=50, max_size=100)
        body = {}
        if page:
            body["activities"] = page
        if token:
            body["nextPageToken"] = token
        self.respond(200, body)

    def get_activity(self, session, activity_id) -> None:
        for activity in session["_activities"]:
            if activity["id"] == activity_id:
                self.respond(200, activity)
                return
        self.not_found(
            f'Activity "sessions/{session["id"]}/activities/{activity_id}"')

    def custom_method(self, session, custom) -> None:
        payload, ok = self.read_json()
        if not ok:
            self.bad_request("Request body is not valid JSON.")
            return

        if custom == "approvePlan":
            if session["_plan_approved"]:
                self.fail(400, "The plan for this session was already approved.",
                          "FAILED_PRECONDITION", "PLAN_ALREADY_APPROVED")
                return
            if session["_plan_id"] is None:
                self.fail(400, "This session has no plan awaiting approval.",
                          "FAILED_PRECONDITION", "NO_PLAN_PENDING")
                return
            _emit_plan_approved(session, "user")
            session["_step"] = max(session["_step"], _APPROVAL_STEP + 1)
            self.respond(200, {})
            return

        if custom == "sendMessage":
            prompt = payload.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                self.bad_request(
                    "Invalid JSON payload received. Field 'prompt' is required.")
                return
            add_activity(session, "user", "User message", "userMessaged",
                         {"userMessage": prompt})
            # The agent answers on the next activities poll, like the real thing.
            session["_pending_replies"].append(
                "Thanks - noting that: " + prompt.strip() +
                " I'll take it into account as I keep going.")
            self.respond(200, {})
            return

        if custom in ("archive", "unarchive"):
            session["archived"] = (custom == "archive")
            session["updateTime"] = next_timestamp()
            self.respond(200, public_session(session))
            return

        self.not_found(f"Custom method :{custom}")


def main() -> int:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), MockJulesHandler)
    server.daemon_threads = True

    print(f"Mock Jules API on http://localhost:{PORT}{BASE_PATH}")
    print(f"  API key      {VALID_API_KEY}   (anything else gets a real-shaped 401)")
    print(f"  sources      {'EMPTY (EMPTY=1)' if EMPTY_SOURCES else str(len(SOURCES)) + ' repositories'}")
    print(f"  rate limits  {'on - every 3rd request is a 429' if RATE_LIMIT else 'off (set RATELIMIT=1)'}")
    print()
    print("  Point the app at it with:")
    print(f"    ?apiBase=http://localhost:{PORT}{BASE_PATH}")
    print()
    print("  Each GET .../activities advances that session one step.")
    print("  Ctrl-C to stop.")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
