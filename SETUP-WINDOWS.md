# Running Jules for iPad from a Windows PC

This guide takes you from "I have a Windows computer and an iPad" to "the app is open on my
iPad and working." It assumes you have done none of this before.

**What you are setting up:** the app is a plain website with no server behind it. Your PC
hands the files to the iPad over your own Wi-Fi, and the iPad then talks to Google directly.
Nothing you do goes through anyone else's computer.

**Roughly 15 minutes**, most of it waiting for Python to install.

You will need:

- A Windows PC and an iPad **on the same Wi-Fi network**
- A Google account that can use [Jules](https://jules.google.com)

---

## Step 1 — Get the code onto the PC

**The easy way (no extra software):**

1. Open <https://github.com/Aklutes57/Jules-iPad-App> in a browser on the PC.
2. Click the green **Code** button → **Download ZIP**.
3. The file lands in your **Downloads** folder. Right-click it → **Extract All…** →
   **Extract**.
4. You now have a folder called something like `Jules-iPad-App-main`. Move it somewhere you
   can find again — your **Documents** folder is fine.

> **Extract it properly.** Windows lets you open a ZIP and look inside without unpacking it.
> If you run the launcher from inside a ZIP preview it will not work. Make sure you did
> **Extract All** and are working in the real folder.

**If you already use Git:** `git clone https://github.com/Aklutes57/Jules-iPad-App.git`

---

## Step 2 — Install Python

Python is what serves the files. It is free and takes a couple of minutes.

1. Go to <https://www.python.org/downloads/> and click the big **Download Python** button.
2. Run the installer you just downloaded.
3. **On the first screen, tick the box that says "Add python.exe to PATH."** It is at the
   bottom and it is easy to miss. Without it, Windows cannot find Python and the launcher
   will tell you Python is missing even though you installed it.
4. Click **Install Now** and wait. Close the installer when it finishes.

To check it worked: press <kbd>Win</kbd>+<kbd>R</kbd>, type `cmd`, press Enter, then type
`python --version` and press Enter. You should see a version number like `Python 3.13.1`.

> If you get "Python was not found" or the Microsoft Store opens instead, the PATH box was
> not ticked. Re-run the installer, choose **Modify**, and make sure PATH is included — or
> just reinstall and tick the box this time.

---

## Step 3 — Start the server

Open the app folder and **double-click `start-windows.bat`**.

A black window opens and prints something like:

```
 ----------------------------------------------------
  On your iPad, open Safari and go to:

       http://192.168.1.42:8080

  The iPad must be on the same Wi-Fi as this PC.
 ----------------------------------------------------
```

**Write that address down** — you need it on the iPad in a moment. Yours will have different
numbers.

**Leave this window open.** It is the server. Closing it stops the app.

### The firewall prompt

The first time you run it, Windows will probably show **"Windows Defender Firewall has
blocked some features of this app."**

- Tick **Private networks** (your home or campus Wi-Fi).
- Leave **Public networks** unticked.
- Click **Allow access**.

If you click Cancel, the server keeps running but your iPad will not be able to reach it.
See the troubleshooting table below for how to fix that afterwards.

---

## Step 4 — Get your Jules API key

Do this on whichever device is convenient; you will paste it into the iPad.

1. Go to <https://jules.google.com> and sign in with your Google account.
2. Open **Settings**, then the **API** tab — or go straight to
   <https://jules.google.com/settings#api>.
3. Click **Create key** and **copy it immediately**. Google shows it only once.

Two things worth knowing:

- You can have **at most 3 keys** on an account. If you are out, delete an old one first.
- **Treat it like a password.** Anyone with it can use your Jules account and see the
  repositories you have connected. Don't put it in a chat, an email, or a screenshot.

---

## Step 5 — Open it on the iPad

1. Make sure the iPad is on the **same Wi-Fi** as the PC.
2. Open **Safari** (not Chrome — Safari handles this best on iPadOS).
3. Type the address from Step 3 into the address bar, exactly:
   `http://192.168.1.42:8080` — your numbers, and note it is `http`, not `https`.
4. The app loads and asks for your API key. Paste it and tap **Test & save**.
5. You should see **Connected**, and your repositories appear.

That's it. You can now create tasks, watch Jules work, chat with it, approve plans, read
diffs, and open pull requests.

> **Tip:** add the address to your Safari bookmarks or favourites so you don't have to type
> it again.

---

## One limitation to know about

Two extras are switched off, and it is not a bug in the app:

- **Add to Home Screen** (so it opens like a real app, full screen)
- **Offline caching**

Apple only enables those for sites served over **HTTPS**. A plain `http://` address on your
own network isn't. Everything else works normally. If you later publish the app to a real web
address, both light up on their own with no changes — see the "Putting it on the web" section
of [README.md](README.md).

---

## Every time after the first

1. Double-click `start-windows.bat` on the PC.
2. Open the bookmark on the iPad.

The PC must be **awake** and on the **same Wi-Fi** while you are using the app.

---

## Troubleshooting

| What you see | What it usually means |
| --- | --- |
| **"Python is not installed"** in the launcher, but you installed it | The **Add python.exe to PATH** box wasn't ticked. Re-run the installer, choose **Modify**, and include PATH — or reinstall and tick it. |
| Safari: **"Safari cannot open the page"** | Most often the firewall. Go to **Windows Security → Firewall & network protection → Allow an app through firewall**, find **Python**, and tick the **Private** column. |
| Safari can't connect, firewall is fine | Check both devices are on the **same** Wi-Fi. A phone hotspot, a guest network, or the 5GHz and 2.4GHz versions of the same router can isolate devices from each other. |
| It worked yesterday, not today | Your PC's address probably changed after a reboot. Re-run the launcher and use the **new** address it prints. |
| The black window flashes and disappears | Usually port 8080 is already in use. Open `start-windows.bat` in Notepad, change `set PORT=8080` to `set PORT=8090`, save, and use `:8090` in the address on the iPad. |
| **"This site can't provide a secure connection"** | You typed `https://`. It must be `http://` on a local network. |
| Launcher can't find your address | Open Command Prompt, type `ipconfig`, press Enter, and read **IPv4 Address** under your Wi-Fi adapter. Use that with `:8080`. |
| Connected, but no repositories | Jules has none connected yet. Go to <https://jules.google.com>, connect your GitHub account, choose the repositories Jules may use, then tap Refresh in the app. |
| **"API keys are not supported by this API…"** | Google's confusing wording for "this isn't a Jules key." Keys from Google Cloud, Gemini or Maps won't work. Create one at <https://jules.google.com/settings#api>. |
| The app asks for the key again after a while | Safari clears storage for sites you haven't opened in a while. Paste the key again; nothing is broken. |

### Are you on a VPN?

A VPN on either device usually breaks local connections. Turn it off on the iPad (and on the
PC) while using the app.

### Still stuck?

Check the server is really running: in the black window you should see lines appear each time
the iPad loads a page. If nothing appears there when you try on the iPad, the iPad is not
reaching the PC at all — that is a network or firewall problem, not an app problem.
