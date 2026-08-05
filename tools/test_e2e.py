#!/usr/bin/env python3
"""End-to-end tests for Jules for iPad.

Drives the real app in a headless browser against the two mock servers, at both
iPad orientations. Nothing here touches Google or Atlassian.

Run:
    python3 -m http.server 8080 &          # serve the app from the repo root
    python3 tools/mock_jules.py &          # :8787
    python3 tools/mock_bitbucket.py &      # :8788
    python3 tools/test_e2e.py

Or just `python3 tools/test_e2e.py --serve`, which starts all three itself.

Requires the `playwright` Python package. Chromium is expected to be already
installed (this repo's dev container ships one under /opt/pw-browsers); the
runner finds it automatically.
"""

import argparse
import glob
import os
import subprocess
import sys
import time
from contextlib import contextmanager

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sys.exit("playwright is not installed:  pip install playwright")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PORT = 8080
JULES_PORT = 8787
BB_PORT = 8788

BASE = (
    "http://127.0.0.1:%d/index.html"
    "?apiBase=http://localhost:%d/v1alpha"
    "&bitbucketApiBase=http://localhost:%d/2.0" % (APP_PORT, JULES_PORT, BB_PORT)
)

JULES_KEY = "test-key-123"
BB_EMAIL = "test@example.com"
BB_TOKEN = "test-bb-token"

LANDSCAPE = {"width": 1180, "height": 820}
PORTRAIT = {"width": 820, "height": 1180}

SHOTS = os.environ.get("SHOT_DIR", os.path.join(ROOT, "screenshots"))

passed = 0
failed = []


def check(name, condition, detail=""):
    global passed
    if condition:
        passed += 1
        print("  PASS  %s" % name)
    else:
        failed.append(name)
        print("  FAIL  %s %s" % (name, ("- " + detail) if detail else ""))


def find_chromium():
    for pattern in (
        "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
        "/opt/pw-browsers/chromium/chrome-linux/chrome",
        "/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell",
    ):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    return None


@contextmanager
def servers(enabled):
    """Optionally run the app server and both mocks for the duration."""
    procs = []
    if enabled:
        env = dict(os.environ)
        procs.append(
            subprocess.Popen(
                [sys.executable, "-m", "http.server", str(APP_PORT)],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        procs.append(
            subprocess.Popen(
                [sys.executable, os.path.join(ROOT, "tools", "mock_jules.py")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        procs.append(
            subprocess.Popen(
                [sys.executable, os.path.join(ROOT, "tools", "mock_bitbucket.py")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )
        time.sleep(2.0)
    try:
        yield
    finally:
        for proc in procs:
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()


def new_page(browser, viewport, console_errors):
    page = browser.new_page(viewport=viewport)

    def on_console(message):
        if message.type == "error":
            text = message.text
            # A deliberate 401/400 probe logs a network error in the console.
            # Those are the tests working, not the app breaking.
            if "401" in text or "400" in text or "Failed to load resource" in text:
                return
            console_errors.append(text)

    page.on("console", on_console)
    page.on("pageerror", lambda err: console_errors.append("pageerror: %s" % err))
    return page


def onboard(page):
    """Get past the key screen with a working key."""
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("input[type=password]", timeout=10000)
    page.fill("input[type=password]", JULES_KEY)
    page.click("button:has-text('Test')")
    page.wait_for_selector(".diag--ok", timeout=10000)
    page.wait_for_timeout(2200)


def connect_bitbucket(page):
    page.evaluate("location.hash = '#/bitbucket'")
    page.wait_for_selector("input[type=email]", timeout=8000)
    page.fill("input[type=email]", BB_EMAIL)
    page.fill("input[type=password]", BB_TOKEN)
    page.click("button:has-text('Test & connect')")
    page.wait_for_timeout(2500)


def shot(page, name):
    try:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_onboarding(page):
    print("\nOnboarding")
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_selector("input[type=password]", timeout=10000)

    page.fill("input[type=password]", "definitely-not-a-key")
    page.click("button:has-text('Test')")
    page.wait_for_selector(".diag", timeout=10000)
    diag = page.inner_text(".diag")
    check(
        "bad key explains it is not a Jules key",
        "Jules API key" in diag,
        diag.replace("\n", " ")[:90],
    )
    check("bad key shows the raw server message", page.locator(".diag-raw").count() > 0)

    page.fill("input[type=password]", JULES_KEY)
    page.click("button:has-text('Test')")
    page.wait_for_selector(".diag--ok", timeout=10000)
    check("good key is accepted", True)
    page.wait_for_timeout(2200)
    check("lands on the dashboard", page.evaluate("location.hash") in ("#/", ""))
    shot(page, "dashboard")


def test_dashboard(page):
    print("\nDashboard")
    page.wait_for_timeout(1500)
    body = page.inner_text("body")
    check("session list renders", page.locator(".badge").count() > 0 or "No sessions" in body)
    check("a state badge is shown", page.locator(".badge .badge-text").count() > 0)


def test_jules_task_lifecycle(page):
    print("\nJules task: create -> plan -> approve -> complete")
    page.evaluate("location.hash = '#/new'")
    page.wait_for_selector("textarea", timeout=8000)

    # The GitHub repo picker is a filter-as-you-type list.
    search = page.locator("input[type=search]").first
    if search.count():
        search.fill("atlas")
        page.wait_for_timeout(500)
    rows = page.locator(".repo-row")
    check("repo search narrows the list", rows.count() > 0, "no repo rows")
    if rows.count():
        rows.first.click()
        page.wait_for_timeout(400)

    branch = page.locator("select.branch-select")
    check(
        "branch defaults to the repo default",
        branch.count() > 0 and branch.first.input_value() in ("main", "master"),
    )

    plan_switch = page.locator(".switch-row:has-text('Review plan') input")
    check(
        "plan review defaults ON",
        plan_switch.count() > 0 and plan_switch.first.is_checked(),
    )

    page.fill("textarea", "Add a dark mode toggle to the settings page")
    page.click("button:has-text('Start task')")
    page.wait_for_timeout(2500)
    check("navigates to the new session", "#/session/" in page.evaluate("location.hash"))
    shot(page, "session-detail")

    # Poll until the plan arrives, then approve it.
    approved = False
    for _ in range(30):
        page.wait_for_timeout(1200)
        approve = page.locator("button:has-text('Approve')")
        if approve.count() and approve.first.is_enabled():
            approve.first.click()
            approved = True
            break
    check("plan appears and can be approved", approved)

    # Then run to completion. Read the *detail* badge, not the sidebar's.
    def detail_state():
        badge = page.locator(".detail-badge .badge-text")
        return badge.first.inner_text() if badge.count() else ""

    completed = False
    for _ in range(60):
        page.wait_for_timeout(1200)
        # The UI labels COMPLETED as "Done".
        if detail_state().strip() in ("Done", "Completed"):
            completed = True
            break
    check("session reaches Completed", completed, "state was %r" % detail_state())
    check("pull request button appears", page.locator("button:has-text('Pull request')").count() > 0)
    check("bash output rendered with its command", page.locator(".term-command").count() > 0)
    check("diff rendered with +/- lines", page.locator(".dl--add, .dl--del").count() > 0)

    # Polling must stop once there is nothing left to watch.
    before = page.locator(".act").count()
    page.wait_for_timeout(6000)
    check("feed is stable once complete", page.locator(".act").count() == before)

    # No duplicate activities after repeated polls.
    names = page.evaluate(
        "Array.from(document.querySelectorAll('.act[data-name]')).map(n => n.dataset.name)"
    )
    check(
        "activity feed has no duplicates",
        bool(names) and len(names) == len(set(names)),
        "%d nodes, %d unique" % (len(names), len(set(names))),
    )


def test_chat(page):
    print("\nChat")
    composer = page.locator(".composer textarea, textarea").last
    if not composer.count():
        check("composer present", False)
        return
    message = "Please also update the README"
    composer.fill(message)
    send = page.locator("button:has-text('Send'), .composer button").last
    send.click()
    page.wait_for_timeout(600)

    # Count the user's own bubbles only. The agent quotes the message back in
    # its reply, so counting the whole page would always find it twice.
    def user_bubbles():
        return page.evaluate(
            "m => Array.from(document.querySelectorAll('.act--user')).filter(n => (n.innerText||'').includes(m)).length",
            message,
        )

    check("sent message appears immediately", user_bubbles() == 1, "%d bubbles" % user_bubbles())
    check("composer clears after sending", composer.input_value() == "")
    page.wait_for_timeout(7000)
    count = user_bubbles()
    check("optimistic message reconciles to one copy", count == 1, "seen %d times" % count)


def test_bitbucket_connect(page):
    print("\nBitbucket: connect")
    page.evaluate("location.hash = '#/bitbucket'")
    page.wait_for_selector("input[type=email]", timeout=8000)

    page.fill("input[type=email]", BB_EMAIL)
    page.fill("input[type=password]", "wrong-token")
    page.click("button:has-text('Test & connect')")
    page.wait_for_selector(".diag", timeout=8000)
    check("bad token is diagnosed", "rejected" in page.inner_text(".diag").lower())

    page.fill("input[type=password]", BB_TOKEN)
    page.click("button:has-text('Test & connect')")
    page.wait_for_timeout(2500)
    check("connects and reports status", "Connected" in page.inner_text("body"))
    check("workspace + repository pickers appear", page.locator("select").count() >= 2)


def test_mirror_wizard(page):
    print("\nBitbucket: mirror wizard")
    selects = page.locator("select")
    selects.nth(1).select_option("degradation-models")
    page.wait_for_timeout(1500)

    blocks = page.locator(".code-block")
    check("both setup files are generated", blocks.count() >= 2, "%d blocks" % blocks.count())
    if blocks.count() < 2:
        return

    pipelines = blocks.nth(0).inner_text()
    backsync = blocks.nth(1).inner_text()

    # The whole point: --mirror would delete Jules' branches on every sync.
    script_lines = [
        line for line in pipelines.splitlines()
        if line.strip().startswith("- git push")
    ]
    check("mirror pushes with --force --all", any("--force --all" in l for l in script_lines))
    check("no push --mirror in the actual script", not any("--mirror" in l for l in script_lines),
          str(script_lines))
    check("tags are mirrored too", any("--tags" in l for l in script_lines))
    check("mirror step is branch-filtered", "jules/**" in pipelines or "{main,master" in pipelines)

    check("back-sync only fires for jules branches", "'jules/**'" in backsync)
    check("back-sync reads a secret, not a literal token", "${{ secrets.BITBUCKET_TOKEN }}" in backsync)
    check("back-sync uses the API-token git user", "x-bitbucket-api-token-auth" in backsync)
    check("no real token leaked into the files", BB_TOKEN not in pipelines and BB_TOKEN not in backsync)
    shot(page, "bitbucket-wizard")


def test_bitbucket_task(page):
    print("\nBitbucket: task creation")
    page.evaluate("location.hash = '#/new'")
    page.wait_for_selector("textarea", timeout=8000)
    page.click("button:has-text('Bitbucket')")
    page.wait_for_timeout(2000)

    selects = page.locator("select")
    check("bitbucket pickers render on the task screen", selects.count() >= 2)
    if selects.count() < 2:
        return
    selects.nth(1).select_option("degradation-models")
    page.wait_for_timeout(1500)

    body = page.inner_text("body")
    check("explains Jules cannot read Bitbucket directly", "mirror" in body.lower())

    # With no mirror linked, the app should fall back to the Direct path and say
    # plainly that it is experimental.
    check("direct mode is labelled experimental", "xperimental" in body)

    page.fill("textarea", "Fix the failing spectra test")
    start = page.locator("button:has-text('Start task')")
    check("task can be started", start.count() > 0 and start.first.is_enabled())
    shot(page, "bitbucket-newtask")

    if start.count() and start.first.is_enabled():
        start.first.click()
        page.wait_for_timeout(2500)
        check("bitbucket task creates a session", "#/session/" in page.evaluate("location.hash"))
        # The prompt carries a token; it must never be shown in the UI.
        check("token is not displayed anywhere", BB_TOKEN not in page.inner_text("body"))


def test_settings(page):
    print("\nSettings")
    page.evaluate("location.hash = '#/settings'")
    page.wait_for_timeout(1200)
    body = page.inner_text("body")
    check("masked key is shown", "••" in body or "…" in body)
    check("bitbucket row is present", "Bitbucket" in body)
    check("shows bitbucket as connected", "Connected" in body)

    page.click("button:has-text('Forget key')")
    page.wait_for_timeout(600)
    confirm = page.locator(".sheet-actions button:has-text('Forget key')")
    if confirm.count():
        confirm.last.click()
        page.wait_for_timeout(1500)
    check("forgetting the key returns to onboarding", "onboarding" in page.evaluate("location.hash"))


def test_empty_sources(browser, console_errors):
    """With no repositories connected, the app must say how to fix that."""
    print("\nEmpty state (no connected repos)")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "tools", "mock_jules.py")],
        cwd=ROOT,
        env=dict(os.environ, PORT="8799", EMPTY="1"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    try:
        page = new_page(browser, LANDSCAPE, console_errors)
        page.goto(
            "http://127.0.0.1:%d/index.html?apiBase=http://localhost:8799/v1alpha" % APP_PORT,
            wait_until="networkidle",
        )
        page.wait_for_selector("input[type=password]", timeout=8000)
        page.fill("input[type=password]", JULES_KEY)
        page.click("button:has-text('Test')")
        page.wait_for_timeout(3000)
        page.evaluate("location.hash = '#/new'")
        page.wait_for_timeout(2500)
        body = page.inner_text("body")
        check("tells the user to connect GitHub at jules.google.com", "jules.google.com" in body)
        page.close()
    finally:
        proc.terminate()


def test_static_hygiene():
    """Absolute paths would break the app on a GitHub Pages sub-path."""
    print("\nStatic checks")
    offenders = []
    for pattern in ("*.html", "css/*.css", "js/*.js", "js/views/*.js", "*.webmanifest", "sw.js"):
        for path in glob.glob(os.path.join(ROOT, pattern)):
            with open(path, "r", encoding="utf-8") as handle:
                text = handle.read()
            for needle in ('src="/', "href=\"/", "url(/"):
                if needle in text:
                    offenders.append("%s contains %s" % (os.path.relpath(path, ROOT), needle))
    check("no absolute paths", not offenders, "; ".join(offenders))

    with open(os.path.join(ROOT, "sw.js"), "r", encoding="utf-8") as handle:
        sw = handle.read()
    shipped = set()
    for pattern in ("js/*.js", "js/views/*.js", "css/*.css"):
        for path in glob.glob(os.path.join(ROOT, pattern)):
            shipped.add("./" + os.path.relpath(path, ROOT))
    missing = sorted(name for name in shipped if name not in sw)
    check("service worker caches every shipped file", not missing, ", ".join(missing))


# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", help="start the app server and mocks")
    args = parser.parse_args()

    console_errors = []

    with servers(args.serve):
        with sync_playwright() as p:
            exe = find_chromium()
            browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()

            for label, viewport in (("landscape 1180x820", LANDSCAPE), ("portrait 820x1180", PORTRAIT)):
                print("\n" + "=" * 62)
                print("VIEWPORT: %s" % label)
                print("=" * 62)

                page = new_page(browser, viewport, console_errors)
                test_onboarding(page)
                test_dashboard(page)
                test_jules_task_lifecycle(page)
                test_chat(page)
                test_bitbucket_connect(page)
                test_mirror_wizard(page)
                test_bitbucket_task(page)
                test_settings(page)
                page.close()

            test_empty_sources(browser, console_errors)
            browser.close()

    test_static_hygiene()

    print("\nUnexpected console errors: %d" % len(console_errors))
    for err in console_errors[:10]:
        print("   %s" % err[:200])
    check("console is clean", not console_errors)

    print("\n" + "=" * 62)
    print("%d passed, %d failed" % (passed, len(failed)))
    if failed:
        for name in failed:
            print("   FAILED: %s" % name)
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
