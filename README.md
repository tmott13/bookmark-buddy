# 🦥 Bookmark Buddy

<img src="public/art/sloth-hanging.webp" alt="Mochi the sloth hanging from a bookmarks bar" width="160" align="right" />

**Your messy bookmarks, tidied while you put your feet up.** Meet Mochi, the sloth who does the tidying 🦥🍡

Bookmark Buddy sorts your bookmarks into clean folders, catches duplicates, and keeps everything tidy as you save new ones. The sorting is done by **Gemma running in your browser** with [WebLLM](https://webllm.mlc.ai), so your bookmarks (your bank, your job search, your health sites…) never leave your device.

It comes two ways:

- **🧩 Chrome / Edge extension (the lazy way):** tidies your real bookmarks in place, with one-click **Undo everything**, then **sorts new bookmarks automatically as you save them.**
- **🌐 Web app:** [bookmark-buddy.onrender.com](https://bookmark-buddy.onrender.com). Works in any WebGPU browser. Drop in a bookmarks export and download a tidy file to import back.

Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 3: Slow and Steady.

## Install the extension

1. Download `bookmark-buddy-extension.zip` from the [latest release](https://github.com/tmott13/bookmark-buddy/releases/latest) and unzip it.
2. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Pin Mochi from the puzzle-piece menu and click it.

Coming soon to the Chrome Web Store and Edge Add-ons for a one-click install with automatic updates. Chrome and Edge only for now: Firefox and Safari don't have the offscreen pages the auto-sorter uses.

## How it works

1. **Read your bookmarks.** The extension reads them right in the browser (the web app reads an exported HTML file). Duplicates are found on their own, even when links differ by http/https, `www`, a trailing slash or tracking codes like `utm_source`. Old `localhost` links get flagged too.
2. **Pick your folders.** Gemma suggests 6–9 folders from a sample of your bookmark titles. Rename, remove or add any. Already organized? **Keep my folders** keeps your folders and subfolders (two levels), leaves the bookmarks in them alone, and only sorts the loose ones. **Add Gemma's ideas** adds new folders that don't repeat yours.
3. **Mochi sorts, slow and steady.** Gemma sorts a few bookmarks at a time, with already-sorted examples so similar bookmarks land together. Obvious matches (a title or site that names a folder, like "taco recipe" → Recipes) are filed by the app without asking Gemma. Once a site has a folder, the rest of its bookmarks follow (except "everything" sites like YouTube or Reddit).
4. **Review everything.** Drag bookmarks between folders or into a new order. Rename, add, remove or reorder folders and subfolders, add your own subfolders, or let Gemma **split a big folder into subfolders** (Recipes › Dinners, Desserts). Delete anything you don't want (🗑), restorable until you finish.
5. **Apply** (extension) or **download** (web app). In the extension, a backup is saved first, your bookmarks move into the new folders in your Bookmarks bar, and old folders that end up empty are cleared out. **Undo everything** puts every bookmark and folder back exactly where it was.

## New bookmarks sort themselves

Save a bookmark loose in your Bookmarks bar (or Other bookmarks) and Mochi files it for you:

- Already have it? It goes to "Maybe delete?".
- A site you always keep in one folder? It follows that folder.
- A title that names a folder or subfolder ("Easy chicken dinner" → Recipes › Dinners)? Filed right away.
- Anything else gets a quick look from Gemma, running in a hidden offscreen page on your GPU.
- A notification tells you where it went, with an **Undo** button. Undo also makes Mochi forget that guess.
- Saved a bookmark straight into a folder yourself? Mochi leaves it alone and learns from it.
- If Gemma isn't available (not downloaded yet, or no WebGPU), the bookmark waits in **"Needs a home"** and the app sorts it next time you open it.

Gemma closes a few minutes after the last bookmark to give the memory back. It only uses a model you already downloaded, and never starts a download on its own.

## Safety rules (the app owns these, not the model)

- **Nothing is deleted unless you say so.** Duplicates and old dev links go into a "Maybe delete?" folder with a reason, so you decide. Anything you delete can be restored until you apply or download.
- **Nothing gets lost.** If Gemma skips a bookmark or invents a folder name, it lands in "Other". Every bookmark you keep ends up in a folder.
- **Gemma never sees or writes a URL.** It only sees titles and site names and replies with folder names. Links, dates and icons are copied by the app.
- **A full backup comes first.** In the extension, a backup is saved before anything changes. Only folders that end up empty are removed, and Undo brings back everything, deleted bookmarks included.
- **Your exported file is never touched.** The web app's download imports as a new folder.
- **No network calls with your data.** No favicons are fetched; the avatars are drawn locally.

**Extension permissions:** `bookmarks` (to read and move them), `storage` + `unlimitedStorage` (settings, the Undo backup and the Gemma model cache), `notifications` (the "Mochi filed this…" message with Undo), `offscreen` (to run Gemma in the background) and `alarms` (to close Gemma when it's idle). No host permissions, no content scripts, and it can't see the pages you visit. [Privacy policy](https://bookmark-buddy.onrender.com/privacy.html)

## Models

| Model | Size | Notes |
|---|---|---|
| `gemma-2-2b-it-q4f16_1-MLC` | ~1.4 GB | Better sorting. Best on a laptop. |
| `gemma3-1b-it-q4f16_1-MLC` | ~700 MB | Lighter. The only option on iPhone/iPad (web app). |

Needs a browser with WebGPU: Chrome or Edge on desktop, or Safari on iOS 26+ for the web app.

## Run it yourself

```bash
npm install
npm run dev        # web app at http://localhost:4200
npm run build      # static files in dist/bookmark-buddy/browser
npm run build:ext  # the extension in ./extension, plus bookmark-buddy-extension.zip
```

Load the `extension` folder with **Load unpacked**. The zip has `manifest.json` at the top level, ready for the Chrome Web Store or Edge Add-ons. Gemma's WebGPU engine code (`ext/lib/*.wasm`) is bundled in the package, so the extension never runs downloaded code; only the model weights download.

## Deploy on Render

`render.yaml` defines a free static site. In Render: **New → Blueprint**, pick this repo, and deploy.

## Coming in 1.1

- Chrome Web Store and Edge Add-ons listings (one-click install, automatic updates)
- Right-click "Ask Mochi to file this" for any bookmark
- A weekly tidy-up nudge for bookmarks that need a home
- A toolbar popup with what's waiting and the auto-sort switch
- A first-run welcome and model picker

## Stack

Angular 22 (signals, zoneless), `@mlc-ai/web-llm`, Gemma, Render static hosting. The extension is Manifest V3: the same Angular app as its page, plus a small background worker and an offscreen document bundled with esbuild.

## Credits

Mochi and the app icon were created with ChatGPT image generation.

The on-device Gemma loader is adapted from my earlier projects, [Off-Grid Trails](https://github.com/tmott13/off-grid-trails) and [Ripple](https://github.com/tmott13/ripple). Everything else was built new for this challenge. Built with Claude as a pair programmer.
