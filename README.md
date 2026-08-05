# Jules for iPad

A touch-friendly way to use [Google Jules](https://jules.google.com) — Google's AI coding
agent — from an iPad.

Jules' own site is built for a desktop browser. This is a small web app designed for a
tablet: big tap targets, one screen at a time, readable diffs, and no fiddly hover menus.
You give Jules a task ("fix the login bug on the staging branch"), it works on your GitHub
repository in the background, and this app shows you what it's doing and hands you the pull
request at the end.

**Your API key stays on your device.** It is saved in your browser's own storage and sent
only to Google's servers, exactly like the official site does it. There is no server in the
middle, no account to make here, and no analytics.

**This repository contains no secrets and is safe to publish.** There is no key, token, or
password anywhere in these files — the key you paste lives in your browser, not in the code.

It is a plain static website: HTML, CSS, and JavaScript. Nothing to compile, nothing to
install, no npm.

---

## Get your Jules API key

You need a key before the app can do anything. It takes about a minute.

1. Go to **<https://jules.google.com>** and sign in with your Google account.
2. Open **Settings**, then the **API** tab — or go straight to
   <https://jules.google.com/settings#api>.
3. Click **Create key**.
4. Copy the key immediately. Google shows it once.

Two things worth knowing:

- **You can have at most 3 keys** on an account. If you're out, delete an old one first.
- **Treat the key like a password.** Anyone who has it can use your Jules account and see
  the repositories you've connected to Jules. Don't paste it into a chat, an email, a
  screenshot, or a file you commit.

---

## Run it privately now

You don't have to put this on the internet to use it. You can serve it from a Mac or PC on
your home Wi-Fi and open it on the iPad. Nothing leaves your network except the app's calls
to Google.

**On the computer** (it needs to stay awake and on the same Wi-Fi as the iPad):

1. Open Terminal (Mac) or Command Prompt (Windows).
2. Go into this folder — type `cd `, then drag the folder onto the window, then press Enter.
3. Start the tiny web server that comes with Python:

   ```
   python3 -m http.server 8080
   ```

   Leave that window open. Closing it stops the server.

4. Find the computer's address on the network:

   - **Mac:** System Settings → Wi-Fi → Details, and read **IP Address**.
     (Or run `ipconfig getifaddr en0`.)
   - **Windows:** run `ipconfig` and read **IPv4 Address**.

   It will look something like `192.168.1.42`.

**On the iPad:** open Safari and go to `http://192.168.1.42:8080` — your computer's address,
then `:8080`. Substitute your own number.

That's it. The app works fully this way: create tasks, watch progress, chat with Jules,
approve plans, read diffs, open pull requests.

> **One small limitation over Wi-Fi.** Two extras — adding the app to your Home Screen so it
> opens like a real app, and offline caching — are switched off by Apple unless a site is
> served over **HTTPS**. A plain `http://` address on your home network isn't. Nothing is
> broken and nothing is missing from the app itself; those two features simply light up on
> their own once the app is published to a real web address (next section).

---

## Publish to a website later, after approval

If you'd rather have a permanent link — and you have whatever approval you need to make the
repository public — GitHub can host this for free. Pick **one** of these.

### Option A — the simple one (no workflow involved)

1. On GitHub, open this repository and go to **Settings → Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Pick this branch, and folder **`/ (root)`**. Click **Save**.
4. Wait a minute or two, then reload the page — GitHub shows the address at the top.

### Option B — the manual button

1. **Settings → Pages → Source: GitHub Actions**.
2. Go to the **Actions** tab, choose **Deploy to GitHub Pages** in the left-hand list, then
   click **Run workflow**.

Option B exists because this repository ships a deploy workflow
(`.github/workflows/deploy-pages.yml`) that is **deliberately inert**: it has no automatic
trigger at all, so it never runs on its own or on a push. It only ever runs when you press
the button. Until then, publishing nothing is the default.

### Then, on the iPad

Open **`https://YOUR-USERNAME.github.io/REPO-NAME/`** in Safari, tap the **Share** button,
and choose **Add to Home Screen**. Now it opens full-screen from your Home Screen like any
other app, and it keeps working when the Wi-Fi drops out.

---

## First run on the iPad

1. Open the app. It asks for your API key — that's expected on a first visit.
2. Paste the key and tap **Test & save**.
3. You should see **Connected**, and your repositories appear.

If it doesn't connect, the app shows you **exactly what Google said**, word for word,
rather than a made-up message. The one worth translating:

> *"API keys are not supported by this API..."*

This message is confusing and it is Google's wording, not a bug in the app. In practice it
almost always means: **this isn't a valid Jules key.** Keys from other Google products
(Cloud, Gemini, Maps) will not work here. Go to
<https://jules.google.com/settings#api> and create a key there specifically.

---

## What you can do

- **Create a task** — pick a repository and a branch, describe what you want, and send it.
  Or start a task with no repository at all, for scratch work on a throwaway machine.
- **Require plan approval** — optional. Jules writes out its plan first and waits for your
  go-ahead. (Left off, tasks created through the API approve their own plans and start
  straight away.)
- **Watch the activity feed live** — planning, progress updates, command output with exit
  codes, and the agent's own messages, as they happen.
- **Chat** — reply to Jules mid-task to redirect it or answer a question.
- **Read the diff** — every changed file, laid out for a touchscreen, with the commit
  message Jules suggests.
- **Open the pull request** — one tap through to GitHub when it's done.
- **Tidy up** — archive tasks you're finished with, or delete them.
- **Work from Bitbucket** — see the next section.

---

## Using Bitbucket instead of GitHub

**The thing to know first:** Jules can only read GitHub repositories. That is Google's
limitation, not this app's — Jules' own documentation says it "can only access repositories
you explicitly allow through GitHub", and support for other version-control systems is
listed as future work. So there is no switch anywhere that makes Jules read Bitbucket
directly.

What this app does instead is bridge the gap, two ways. Open **Settings → Bitbucket** (or
the Bitbucket tab on the New Task screen) to set either one up.

### First, connect Bitbucket

You need an **Atlassian API token**. Bitbucket app passwords were removed in July 2026, so
tokens are the only option now.

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Create an **API token with scopes** and tick these Bitbucket scopes:
   `read:workspace:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`,
   `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`.
3. Paste it into the app along with the email address of your Atlassian account.

The token is stored on your device only, exactly like the Jules key, and the app talks to
`api.bitbucket.org` straight from the browser — still no server in the middle.

If you would rather not hand over an account-wide token, use a **repository access token**
instead (Repository settings → Access tokens in Bitbucket) and pick "Repo token" in the app.
It can do less, which is the point.

### Path 1 — mirror to a private GitHub repo (recommended)

Bitbucket stays the place your code lives. A private GitHub repo holds a copy, and that copy
is what Jules is connected to. Everything Jules can normally do keeps working, and the
branches it creates come back to Bitbucket on their own.

The app generates both files for you, filled in with your repository names:

- `bitbucket-pipelines.yml` — goes in your Bitbucket repo. Every push mirrors to GitHub.
- `.github/workflows/sync-jules-to-bitbucket.yml` — goes in the GitHub mirror. It pushes
  branches Jules created (`jules/**`) back to Bitbucket.

Follow the numbered steps on the Bitbucket screen — create the private mirror repo, enable
Pipelines, add the SSH deploy key, paste the two files, connect Jules to the mirror at
jules.google.com, then come back and **link** the mirror so the app knows the two belong
together. After that, starting a task on that Bitbucket repo just works.

One detail worth knowing, because most tutorials online get it wrong: the generated pipeline
pushes with `git push --force --all`, **not** `git push --mirror`. `--mirror` deletes
branches on the far end that don't exist locally, which would wipe out every branch Jules
creates on GitHub on the very next sync.

### Path 2 — let Jules clone Bitbucket itself (experimental)

Jules starts on a blank machine, clones your Bitbucket repo, does the work, and pushes a
`jules/...` branch straight back. GitHub is never involved.

Two honest caveats:

- **It may not work at all.** This depends on Jules' sandbox being allowed to reach the
  internet, which Google does not document either way. The Bitbucket screen has a
  **connectivity check** — one tap, one throwaway task, and you'll know for certain on your
  own account. Run that before relying on this path.
- **Your Bitbucket token goes to Google.** It has to travel inside the task text so Jules can
  clone, which means it is stored with the session on Google's side. Use a repository access
  token with a short expiry for this, not your account-wide one.

### Opening the pull request

Jules cannot open a Bitbucket pull request — it doesn't know Bitbucket exists. So when a task
that started from Bitbucket finishes, the app shows a **Bitbucket PR** button and opens the
pull request for you through Bitbucket's API.

If you used the mirror path, give the back-sync workflow a moment to carry the branch across
before pressing it.

---

## Privacy and security

- **Your key is stored on your device only** — in Safari's local storage for this site. It
  is never sent anywhere except `jules.googleapis.com`, and it is never written into any
  file in this repository.
- **Forget key** — in Settings. It wipes the key off the device immediately.
- **No server, no account, no analytics, no cookies, no tracking.** There is nothing between
  your iPad and Google.
- **Everything Jules sends back is treated as untrusted text.** Agent messages, task titles,
  diffs, and command output are inserted into the page as plain text, never as markup, so a
  repository containing something malicious can't do anything to the app.
- **If a key ever leaks**, delete it at <https://jules.google.com/settings#api> and make a
  new one. Google also automatically disables keys it detects as publicly exposed — which is
  a safety net, not a substitute for keeping it private.

---

## Development

No build step. No dependencies to install for the app itself. Edit a file, reload the page.

### Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole page. Every screen is drawn into it by JavaScript. |
| `manifest.webmanifest` | Name, colours, and icons — what makes it installable. |
| `sw.js` | Service worker: caches the app so it opens offline. |
| `css/app.css` | All styling, including dark mode and safe-area insets. |
| `js/config.js` | Every tunable constant, including the one API base URL. |
| `js/api.js` | The only module that talks to the Jules API. |
| `js/bitbucket.js` | The only module that talks to the Bitbucket API. |
| `js/bridge.js` | Builds the two ways a Bitbucket repo reaches Jules. |
| `js/storage.js` | Reading and writing the keys and settings, defensively. |
| `js/ui.js` | The `el()` DOM builder and shared interface pieces. |
| `js/activity.js` | Renders one activity from the feed. |
| `js/diff.js` | Renders a unified diff. |
| `js/poller.js` | Polling that backs off, pauses when hidden, resumes on wake. |
| `js/router.js` | Hash-based routing (`#/task/123`). |
| `js/views/` | One module per screen. |
| `icons/` | App icons — generated, not hand-drawn. See below. |
| `tools/gen_icons.py` | Regenerates those icons. |
| `tools/mock_jules.py` | A fake Jules API for offline development and tests. |
| `.github/workflows/deploy-pages.yml` | Manual "publish" button. Never runs on its own. |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is. |

Two rules the code sticks to, both of which matter more than they look:

- **Every path is relative** (`./js/app.js`, never `/js/app.js`). The single exception is
  the Jules API URL itself. This is what lets the app work unchanged from a local folder, a
  `python3 -m http.server`, and a GitHub Pages sub-path like `/REPO-NAME/`.
- **`innerHTML` is never used** for anything derived from the API. See `js/ui.js`.

### The mock API

`tools/mock_jules.py` imitates the Jules API — the standard library only, no `pip install`:

```
python3 tools/mock_jules.py
```

Then open the app in a **desktop** browser with the override, and use the key `test-key-123`:

```
http://localhost:8080/?apiBase=http://localhost:8787/v1alpha
```

The `?apiBase=` override deliberately only accepts `localhost` and `127.0.0.1`. That's a
safety measure: it means nobody can send you a link that quietly points the app — and your
API key — at their own server. (It also means the mock is for desktop development; the iPad
can't reach a `localhost` on another machine.)

The mock runs a scripted task from `QUEUED` to `COMPLETED`, advancing **one step every time
the app polls for activities**, so tests are deterministic rather than timing-dependent. It
reproduces the real API's quirks on purpose: wide-open CORS, Google's exact error envelope
(including that misleading 401), and omitting empty lists from responses instead of sending
`[]`.

Environment variables for testing edge cases:

| Variable | Effect |
| --- | --- |
| `PORT=8787` | Which port to listen on. |
| `EMPTY=1` | `GET /sources` returns nothing — exercises the "no repositories" state. |
| `RATELIMIT=1` | Every 3rd request answers `429` with `Retry-After: 1`. |

End-to-end tests run against this mock, never against the real API, so they cost nothing and
can't touch your repositories:

```
python3 tools/test_e2e.py
```

### The icons

`icons/` is generated — don't edit the PNGs by hand, they'll be overwritten:

```
python3 -m pip install pillow
python3 tools/gen_icons.py
```

The "J" is drawn from rectangles and an arc rather than set in a font, so it comes out
identical on any machine. The script checks its own output: correct dimensions, and the
maskable icon's artwork staying inside the safe zone Android crops to.

---

## Troubleshooting

**It's asking for my key again, and I definitely saved it.**
Safari clears local storage for sites you haven't opened in about a week. This is Apple's
behaviour and it hits every website. Nothing is wrong — paste the key again. Adding the app
to your Home Screen after publishing it makes this much less likely.

**"API keys are not supported by this API."**
The key isn't a valid Jules key. Create one at <https://jules.google.com/settings#api>. Keys
from other Google products don't work. See [First run on the iPad](#first-run-on-the-ipad).

**"Rate limit" or "quota exceeded" messages.**
These come from your Jules plan, not from this app. It waits and retries automatically, so
usually you just carry on. If it keeps happening, you're making requests faster than your
plan allows — give it a few minutes.

**No repositories in the list.**
Jules can only see repositories you've connected to it. Go to
<https://jules.google.com>, connect the repository there, then pull to refresh in the app.

**The iPad can't load the page over Wi-Fi.**
Check that the computer is still running `python3 -m http.server 8080` in an open window,
that both devices are on the *same* Wi-Fi network (not a guest network), and that you typed
`http://` rather than `https://`. Some networks — university and public Wi-Fi especially —
block devices from talking to each other, in which case publishing to GitHub Pages is the
way around it.

**A task is stuck at "Awaiting plan approval".**
That's what you asked for when you ticked *Require plan approval*. Open the task and approve
the plan to let it continue.
