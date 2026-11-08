# SmardTrackLayout

A browser-based model railway track layout editor built on the
[XTrackCAD](https://sourceforge.net/p/xtrkcad-fork/xtrkcad/) parameter libraries (`.xtp` files) from SourceForge.

- Choose any of the ~350 XTrackCAD libraries, for example **Märklin C-Gleis** (`mrklnhoc-de`, the default), `HO-Marklin C-Track`, K-/M-Track, Roco, Piko, Peco and others.
- Click a piece to place it. It connects to the active open end (blue). Use **Tab / Flip end** to attach it by its other end, so a curve bends right instead of left.
- Drag pieces near an open end and they snap together. The app detects connections automatically.
- It also has rotate, delete, undo/redo, box select, double-click to select a connected group, zoom/pan, part number labels and a parts list (CSV).
- Layouts are saved on the server, exported or imported as JSON, and autosaved in the browser.

## Run locally

```sh
node server.js          # http://localhost:8080
```

No dependencies are required (Node ≥ 20).

## Deploy (Raspberry Pi)

```sh
./deploy.sh             # rsync to pi@192.168.178.74 and docker compose up -d --build
```

The app runs at `http://192.168.178.74:8080/`. Saved layouts and cached library files live in the `stl-data` Docker volume.

## macOS desktop app

```sh
./macos/build.sh        # → dist/SmardTrackLayout.app (+ zip); universal, macOS 13+
```

The macOS app is a native Swift/WebKit shell around the same editor. It doesn't need a server or Node: a `WKURLSchemeHandler` answers the editor's `/api` calls inside the app.
- Layouts are stored in `~/Library/Application Support/SmardTrackLayout/layouts` (File ▸ Show Layouts Folder in Finder).
- Library files are fetched from SourceForge and cached next to the layouts. The Märklin C-track files work offline.
- Export and parts-list CSV open a native save dialog. The usual shortcuts work: ⌘N/O/S, ⌘Z/⇧⌘Z, ⌘0 fit, ⌘L labels.
- `STL_SELFTEST=1 dist/SmardTrackLayout.app/Contents/MacOS/SmardTrackLayout` runs a scripted smoke test and prints the result.

The app is ad-hoc signed. On another Mac, Gatekeeper blocks it the first time; right-click ▸ Open to allow it.

## How it works

- `server.js` serves the UI and proxies library files from SourceForge (`/api/library?file=…`), caching them in `/data/cache`. The library list is refreshed weekly. The two Märklin C-track libraries ship in `seed/`, so they work offline.
- `public/xtp.js` parses `.xtp` files. It reads endpoints (`E`), straight/curved/bezier track (`S`, `C`, `W`) and outline drawing (`L`, `A`, `F`, `G`, plus the `*3` variants). Units are inches and angles are compass degrees.
- `public/editor.js` is the SVG editor: placement, snapping, connection detection and persistence.
