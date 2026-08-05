#!/usr/bin/env python3
"""A stand-in for the Bitbucket Cloud REST API, for local end-to-end tests.

Nothing here talks to Atlassian. It mimics the parts of api.bitbucket.org/2.0
that this app uses, closely enough that the same client code works against
both:

  * CORS on every response, including errors and preflights, with
    Access-Control-Allow-Origin: *  (this is what the real API does as of
    Aug 2026, and it is the reason the app can be backend-free).
  * The real error envelope: {"type": "error", "error": {"message": ...}}.
  * Bitbucket's `values` / `next` / `pagelen` pagination shape.

Usage:
    python3 tools/mock_bitbucket.py

Environment:
    PORT=8788         port to listen on
    EMPTY=1           report zero repositories (for empty-state tests)
    UNAUTHORIZED=1    reject every credential (for diagnostics tests)

Valid credentials:
    Basic  base64("test@example.com:test-bb-token")
    Bearer test-bb-token
"""

import base64
import json
import os
import re
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8788"))
EMPTY = os.environ.get("EMPTY") == "1"
UNAUTHORIZED = os.environ.get("UNAUTHORIZED") == "1"

VALID_TOKEN = "test-bb-token"
VALID_EMAIL = "test@example.com"

WORKSPACES = [
    {"slug": "cwrusdle", "name": "CWRU-SDLE"},
    {"slug": "personal-ws", "name": "Personal"},
]

REPOS = {
    "cwrusdle": [
        ("degradation-models", "main", ["main", "develop", "feature/spectra"], True),
        ("field-data-pipeline", "main", ["main", "staging"], True),
        ("lab-notebook", "master", ["master"], False),
    ],
    "personal-ws": [
        ("scratch", "main", ["main"], False),
    ],
}

CREATED_PULL_REQUESTS = []


def now_iso(offset_minutes: int = 0) -> str:
    stamp = datetime.now(timezone.utc) + timedelta(minutes=offset_minutes)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+00:00"


def repo_payload(workspace: str, slug: str, main_branch: str, private: bool, index: int) -> dict:
    full_name = f"{workspace}/{slug}"
    return {
        "type": "repository",
        "uuid": "{%s}" % full_name,
        "name": slug,
        "slug": slug,
        "full_name": full_name,
        "is_private": private,
        "updated_on": now_iso(-index * 90),
        "mainbranch": {"type": "branch", "name": main_branch},
        "workspace": {"slug": workspace, "name": workspace},
        "links": {"html": {"href": f"https://bitbucket.org/{full_name}"}},
    }


def branches_for(workspace: str, slug: str):
    for name, _main, branches, _private in REPOS.get(workspace, []):
        if name == slug:
            return branches
    return []


def repo_record(workspace: str, slug: str):
    for index, (name, main, _branches, private) in enumerate(REPOS.get(workspace, [])):
        if name == slug:
            return repo_payload(workspace, name, main, private, index)
    return None


class MockBitbucketHandler(BaseHTTPRequestHandler):
    server_version = "MockBitbucket/1.0"

    # -- plumbing ---------------------------------------------------------

    def _cors(self) -> None:
        # Mirrors the real service: a wildcard origin, which is precisely why
        # the browser client must send credentials:'omit' and set Authorization
        # explicitly.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Vary", "origin")
        self.send_header(
            "Access-Control-Allow-Methods", "DELETE, GET, OPTIONS, PATCH, POST, PUT"
        )
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Max-Age", "86400")

    def respond(self, status: int, payload=None) -> None:
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def fail(self, status: int, message: str, detail: str = "") -> None:
        error = {"message": message}
        if detail:
            error["detail"] = detail
        self.respond(status, {"type": "error", "error": error})

    def log_message(self, fmt, *args):  # quieter test output
        pass

    def authorized(self) -> bool:
        if UNAUTHORIZED:
            return False
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[7:].strip() == VALID_TOKEN
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:].strip()).decode("utf-8")
            except Exception:
                return False
            email, _, token = decoded.partition(":")
            return token == VALID_TOKEN and email == VALID_EMAIL
        return False

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return None

    # -- verbs ------------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    # -- routing ----------------------------------------------------------

    def dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        path = parsed.path

        if not path.startswith("/2.0/"):
            self.fail(404, "Resource not found")
            return

        if not self.authorized():
            # The wording Atlassian actually returns for a bad credential.
            self.fail(
                401,
                "Invalid or expired authentication credentials",
                "The access token is invalid, has expired, or lacks the required scopes.",
            )
            return

        segments = [s for s in path[len("/2.0/"):].split("/") if s]

        if method == "GET" and segments == ["workspaces"]:
            self.list_workspaces(params)
            return

        # The bare cross-workspace listing was sunset on 2026-04-14.
        if method == "GET" and segments == ["repositories"]:
            self.fail(410, "This endpoint has been removed", "Use /2.0/repositories/{workspace}.")
            return

        if segments and segments[0] == "repositories":
            rest = segments[1:]
            if method == "GET" and len(rest) == 1:
                self.list_repos(rest[0], params)
                return
            if method == "GET" and len(rest) == 2:
                self.get_repo(rest[0], rest[1])
                return
            if method == "GET" and len(rest) == 4 and rest[2:] == ["refs", "branches"]:
                self.list_branches(rest[0], rest[1], params)
                return
            if method == "POST" and len(rest) == 3 and rest[2] == "pullrequests":
                self.create_pull_request(rest[0], rest[1])
                return

        self.fail(404, "Resource not found")

    # -- endpoints --------------------------------------------------------

    def page(self, values, params):
        try:
            pagelen = min(int(params.get("pagelen", ["100"])[0]), 100)
        except ValueError:
            pagelen = 100
        return {
            "pagelen": pagelen,
            "page": 1,
            "size": len(values),
            "values": values[:pagelen],
        }

    def list_workspaces(self, params) -> None:
        values = [
            {
                "type": "workspace",
                "uuid": "{%s}" % ws["slug"],
                "slug": ws["slug"],
                "name": ws["name"],
            }
            for ws in WORKSPACES
        ]
        self.respond(200, self.page(values, params))

    def list_repos(self, workspace: str, params) -> None:
        if workspace not in REPOS:
            self.fail(404, "Workspace %s not found" % workspace)
            return
        if EMPTY:
            self.respond(200, self.page([], params))
            return
        values = [
            repo_payload(workspace, name, main, private, index)
            for index, (name, main, _branches, private) in enumerate(REPOS[workspace])
        ]
        self.respond(200, self.page(values, params))

    def get_repo(self, workspace: str, slug: str) -> None:
        record = repo_record(workspace, slug)
        if not record:
            self.fail(404, "Repository %s/%s not found" % (workspace, slug))
            return
        self.respond(200, record)

    def list_branches(self, workspace: str, slug: str, params) -> None:
        names = branches_for(workspace, slug)
        if not names:
            self.fail(404, "Repository %s/%s not found" % (workspace, slug))
            return
        values = [
            {"type": "branch", "name": name, "target": {"hash": "%040x" % (i + 1)}}
            for i, name in enumerate(names)
        ]
        self.respond(200, self.page(values, params))

    def create_pull_request(self, workspace: str, slug: str) -> None:
        payload = self.read_json()
        if payload is None:
            self.fail(400, "Invalid JSON")
            return

        title = payload.get("title")
        source = ((payload.get("source") or {}).get("branch") or {}).get("name")
        destination = ((payload.get("destination") or {}).get("branch") or {}).get("name")

        if not title:
            self.fail(400, "title is required")
            return
        if not source:
            self.fail(400, "source.branch.name is required")
            return

        known = branches_for(workspace, slug)
        if known and source not in known and not source.startswith("jules/"):
            # What Bitbucket says when the branch was never pushed.
            self.fail(400, "branch %s not found in %s/%s" % (source, workspace, slug))
            return

        number = len(CREATED_PULL_REQUESTS) + 1
        record = {
            "type": "pullrequest",
            "id": number,
            "title": title,
            "description": payload.get("description", ""),
            "state": "OPEN",
            "source": {"branch": {"name": source}},
            "destination": {"branch": {"name": destination or "main"}},
            "close_source_branch": bool(payload.get("close_source_branch")),
            "created_on": now_iso(),
            "links": {
                "html": {
                    "href": "https://bitbucket.org/%s/%s/pull-requests/%d"
                    % (workspace, slug, number)
                }
            },
        }
        CREATED_PULL_REQUESTS.append(record)
        self.respond(201, record)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), MockBitbucketHandler)
    mode = []
    if EMPTY:
        mode.append("EMPTY")
    if UNAUTHORIZED:
        mode.append("UNAUTHORIZED")
    print(
        "Mock Bitbucket API on http://127.0.0.1:%d/2.0%s"
        % (PORT, (" [" + ", ".join(mode) + "]") if mode else "")
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
