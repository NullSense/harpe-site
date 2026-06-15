# Harpe browser extension

A thin launcher into the Harpe site — paste/right-click anything and Harpe
resolves it (museum search · page image-scan · gigapixel deep-zoom · X video ·
YouTube/IG/TikTok via your cobalt backend) and downloads it. Because it runs in
**your** browser (your session, your residential IP) it reaches things a server
can't, while reusing the site's backend — no logic is duplicated here.

## What it does
- **Popup** (toolbar icon): type to search museums, or paste any link to grab it;
  or hit **⤓ this page** to grab the page you're on.
- **Right-click menus**: grab this *link* / *image* / *video* / *page*, or search
  the selected text.
- **⚙ Settings**: point it at your own Harpe deploy (defaults to
  `https://harpe-site.vercel.app`). Set your deploy's `COBALT_API_URL` to unlock
  YouTube/IG/TikTok/etc.

## Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
   (Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → pick
   `manifest.json`.)

## Notes
- MV3, zero dependencies, no bundler — plain JS/HTML.
- It only ever opens `…/?q=<your input>` on the Harpe site; it stores nothing
  except an optional custom site URL (`chrome.storage.sync`).
- Roadmap: in-page media sniffing + one-click download (so logged-in IG/YT works
  without a backend), calling the same `/api/grab` resolver.
