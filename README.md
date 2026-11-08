# SmardTrackLayout

A browser-based model railway track layout editor built on the
[XTrackCAD](https://sourceforge.net/p/xtrkcad-fork/xtrkcad/) parameter libraries (`.xtp` files) from SourceForge.

- Choose any of the ~350 XTrackCAD libraries, for example **Märklin C-Gleis** (`mrklnhoc-de`, the default), `HO-Marklin C-Track`, K-/M-Track, Roco, Piko, Peco and others.
- Click a piece to place it. It connects to the active open end (blue). Use **Tab / Flip end** to attach it by its other end, so a curve bends right instead of left.
- Drag pieces near an open end and they snap together. The app detects connections automatically.
- It also has rotate, delete, undo/redo, box select, double-click to select a connected group, zoom/pan, part number labels and a parts list (CSV).
- **Save as…** writes the layout (track and drawings) to a JSON file, **Open…** loads one. Your current work is autosaved in the browser.
- Drawing tools for baseboard outlines: line, polyline, rectangle, circle, text and dimensions. Dimensions can be linked to edges. Rectangles have edge handles to change only the width or height, and a Properties panel takes exact values from the keyboard.

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
- File ▸ Save As… (⌘S) and Open… (⌘O) use the normal macOS file dialogs. Your current work is autosaved between sessions.
- Library files are fetched from SourceForge and cached next to the layouts. The Märklin C-track files work offline.
- The usual shortcuts work: ⌘N/O/S, ⌘Z/⇧⌘Z, ⌘0 fit, ⌘L labels.
- `STL_SELFTEST=1 dist/SmardTrackLayout.app/Contents/MacOS/SmardTrackLayout` runs a scripted smoke test and prints the result.

The app is ad-hoc signed. On another Mac, Gatekeeper blocks it the first time; right-click ▸ Open to allow it.

## How it works

- `server.js` serves the UI and proxies library files from SourceForge (`/api/library?file=…`), caching them in `/data/cache`. The library list is refreshed weekly. The two Märklin C-track libraries ship in `seed/`, so they work offline.
- `public/xtp.js` parses `.xtp` files. It reads endpoints (`E`), straight/curved/bezier track (`S`, `C`, `W`) and outline drawing (`L`, `A`, `F`, `G`, plus the `*3` variants). Units are inches and angles are compass degrees.
- `public/editor.js` is the SVG editor: placement, snapping, connection detection and persistence.

## License

SmardTrackLayout is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License v3.0 or later**. See [LICENSE](LICENSE).
Copyright © 2026 Rolf Vogelgesang. It comes with no warranty.

### Third-party components

The track geometry comes from the XTrackCAD parameter libraries, licensed under the GNU GPL v2 or later. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The notices and the license text ship with every build: they are in `public/legal/`, shown in the app under Help ▸ Licenses, and included in the Docker image and the macOS app bundle. If you pass the app on, keep these files with it.
