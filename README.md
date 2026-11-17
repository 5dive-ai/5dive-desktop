# 5dive for Mac and Windows

Your AI team in its own window. The menu bar (Mac) or tray (Windows) shows when an agent needs you.

**[Download for Mac](https://github.com/5dive-ai/5dive/releases/latest/download/5dive.dmg)** · macOS 12 or newer · Apple Silicon and Intel

**[Download for Windows](https://github.com/5dive-ai/5dive/releases/latest/download/5dive-setup.exe)** · Windows 10 or 11 · 64-bit

Free and open source (MIT).

![5dive for Mac: your team in its own window, a chat open beside the list, and the menu-bar badge counting who needs you](docs/screenshot.png)

## What it does

- Opens [5dive.app](https://5dive.app) in its own window and keeps you signed in.
- The menu-bar icon gets a dot and a number when an agent is waiting on you (a decision, an approval, a key). Click a line to open that task.
- A notification when a new one arrives, and the same number on the Dock icon (Mac) or a red dot on the taskbar button (Windows).
- Closing the window keeps the icon running. Quit from the icon's menu.

## First launch

**Mac:** the app is not notarized by Apple yet, so macOS asks once. Open the .dmg, drag 5dive to Applications, open it, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

**Windows:** the installer is not signed yet, so Windows may say it protected your PC. Click **More info**, then **Run anyway**. It installs for you only (no admin needed) and adds 5dive to the Start menu.

## Build it yourself

```sh
npm ci
npm start        # run it
npm test         # unit tests
npm run dist     # build dist/5dive.dmg (on a Mac)
npm run dist:win # build dist/5dive-setup.exe (on Windows)
```

Every tag `v*` builds the .dmg on a Mac and the installer on Windows in GitHub Actions, checks each one (on Windows: a silent install, a launch and the sign-in hand-back), and attaches both to the release here. Downloads are served from the main repo, [5dive-ai/5dive](https://github.com/5dive-ai/5dive/releases/latest): its `mac-app-mirror` workflow copies this repo's latest `5dive.dmg` and `5dive-setup.exe` onto its Latest release within the hour. This repo stays the source.

## Privacy

The app is the 5dive web page plus a menu-bar or tray icon. It keeps no token of its own: once a minute it asks the signed-in page the same "who needs me" question the web app's Needs-you badge asks. Nothing else is sent anywhere.

## License

[MIT](LICENSE)
