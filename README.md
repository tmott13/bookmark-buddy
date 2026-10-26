# 🦥 Bookmark Buddy

<img src="public/art/sloth-hanging.webp" alt="Bookmark Buddy sloth" width="160" align="right" />

**Your messy bookmarks, tidied while you put your feet up.** Meet Mochi, the sloth who does the tidying 🦥🍡

Drop in your browser's bookmarks export and Bookmark Buddy sorts everything into clean folders, catches duplicates, and gives you a tidy file to import back. The sorting is done by **Gemma running in your browser** with [WebLLM](https://webllm.mlc.ai), so your bookmarks (your banks, job searches, health sites…) never leave your device.

It comes two ways:

- **🧩 Chrome / Edge extension (the lazy way):** tidies your real bookmarks in place, with one-click Undo, then **sorts new bookmarks automatically as you save them.**
- **🌐 Web app:** works in any WebGPU browser. Drop in a bookmarks export, download a tidy file to import back.

Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 3: Slow and Steady.

## How it works

1. **Export** your bookmarks as HTML from Chrome, Edge, Safari or Firefox (they all use the same format).
2. **Drop the file in.** The app reads it locally and finds exact duplicates on its own, ignoring http/https, `www`, trailing slashes and tracking codes like `utm_source`. Old `localhost` links get flagged too.
3. **Gemma suggests 6–9 folders** from a sample of your bookmark titles. Rename, remove or add any. Already organized? **Keep my folders** keeps your folders and subfolders (two levels), leaves the bookmarks in them alone, and only sorts the loose ones. **Add Gemma's ideas** adds new folders that don't repeat yours.
4. **Gemma sorts everything**, a few bookmarks at a time, with already-sorted examples so similar bookmarks land together. Obvious matches (a title or site that names a folder, like "taco recipe" → Recipes) are filed by the app without asking Gemma. Once Gemma has put the same site in the same folder twice, the rest of that site's bookmarks follow automatically (except big "everything" sites like YouTube or Reddit).
5. **Review**: drag bookmarks between folders or into a new order, rename, add, remove or reorder folders and subfolders (add your own, or let Gemma **split a big folder into subfolders**), delete anything you don't want (🗑, restorable until you finish), and **download** a clean bookmarks file to import back.

## The extension

1. Click the 🦥 icon and hit **Read my bookmarks**. No exporting needed.
2. Gemma suggests folders and sorts everything, just like the web app. Review it and drag anything that's off.
3. **Apply to my bookmarks.** A backup of where everything lived is saved first. Your bookmarks move into the new folders in your Bookmarks bar, and old folders that end up empty are cleared out.
4. **Undo everything** puts every bookmark and folder back exactly where it was.

**Auto-sort new bookmarks.** Save a bookmark loose in your Bookmarks bar (or Other bookmarks) and Buddy files it for you:

- Already have it? It goes to "Maybe delete?".
- A site you always keep in one folder? It follows that folder.
- Anything else gets a quick look from Gemma, running in a hidden offscreen page on your GPU.
- A notification tells you where it went, with an **Undo** button. Undo also makes Buddy forget that guess.
- Saved a bookmark straight into a folder yourself? Buddy leaves it alone and learns from it.
- If Gemma isn't available (not downloaded yet, or no WebGPU), the bookmark waits in **"Needs a home"** and the app sorts it next time you open it.

Gemma is closed a few minutes after the last bookmark so it gives the memory back. It only ever uses a model you already downloaded, and never starts a download on its own.

### Install it (Load unpacked)

```bash
npm install
npm run build:ext   # builds into ./extension
```

Then in Chrome go to `chrome://extensions` (or `edge://extensions` in Edge), turn on **Developer mode**, click **Load unpacked**, and pick the `extension` folder. Chrome and Edge only: Firefox and Safari don't have the offscreen pages the auto-sorter uses.

The build also writes `bookmark-buddy-extension.zip` (manifest at the top level), ready to upload to the Chrome Web Store or Edge Add-ons. Gemma's WebGPU engine code (`ext/lib/*.wasm`) is bundled in the package, so the extension never runs downloaded code. Only the model weights download. The privacy policy lives at `/privacy.html` on the website.

**Permissions:** `bookmarks` (to read and move them), `storage` + `unlimitedStorage` (settings, the Undo backup, and the Gemma model cache), `notifications` (the "Filed in…" message with Undo), `offscreen` (to run Gemma in the background) and `alarms` (to close Gemma when it's idle). No host permissions, no content scripts, and it can't see the pages you visit.

## Safety rules (the app owns these, not the model)

- **Nothing is deleted unless you say so.** Duplicates and old dev links go into a "Maybe delete?" folder with a reason, so you decide. Anything you delete can be restored until you apply or download.
- **Every bookmark ends up in the new file.** If Gemma skips one or invents a folder name, it lands in "Other".
- **Gemma never sees or writes a URL.** It only sees titles and domains and replies with folder names. Links, dates and icons are copied by the app.
- **Your original file is never touched.** Browsers import the result as a new folder.
- **In the extension, Buddy only moves bookmarks.** It deletes only the ones you picked, and a full backup is saved before anything changes. Only folders that end up empty are removed, and Undo brings back everything, deleted bookmarks included.
- **No network calls with your data.** No favicons are fetched; the avatars are drawn locally.

## Models

| Model                       | Size    | Notes                                    |
| --------------------------- | ------- | ---------------------------------------- |
| `gemma-2-2b-it-q4f16_1-MLC` | ~1.4 GB | Better sorting. Best on a laptop.        |
| `gemma3-1b-it-q4f16_1-MLC`  | ~700 MB | Lighter. The only option on iPhone/iPad. |

Needs a browser with WebGPU: Chrome or Edge on desktop, or Safari on iOS 26+.

## Run it

```bash
npm install
npm run dev      # http://localhost:4200
npm run build    # static files in dist/bookmark-buddy/browser
npm run build:ext  # the Chrome / Edge extension in ./extension
```

## Deploy on Render

`render.yaml` defines a free static site. In Render: **New → Blueprint**, pick this repo, and deploy.

## Stack

Angular 22 (signals, zoneless), `@mlc-ai/web-llm`, Gemma, Render static hosting. The extension is Manifest V3: the same Angular app as its page, plus a small background worker and an offscreen document bundled with esbuild.

## Credits

Sloth illustrations and the app icon were created with ChatGPT image generation.

The on-device Gemma loader is adapted from my earlier projects, [Off-Grid Trails](https://github.com/tmott13/off-grid-trails) and [Ripple](https://github.com/tmott13/ripple). Everything else was built new for this challenge. Built with Claude as a pair programmer.
