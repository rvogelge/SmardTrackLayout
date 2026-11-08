// SmardTrackLayout for macOS — a native shell around the web editor.
// The editor's /api requests are answered in-process by a WKURLSchemeHandler,
// so the app works standalone (no server, no Node). Library files are fetched
// from SourceForge on demand and cached; layouts are stored as JSON files.
import Cocoa
import WebKit
import UniformTypeIdentifiers

let appName = "SmardTrackLayout"
let sfParams = "https://sourceforge.net/p/xtrkcad-fork/xtrkcad/ci/default/tree/app/lib/params"
let scheme = "stl"

struct APIError: Error { let status: Int; let message: String }

// MARK: - Storage

final class Store {
    let fm = FileManager.default
    let base: URL, cache: URL, layouts: URL, web: URL, seed: URL
    private(set) var libraries: [String] = []
    private var listFile: URL { base.appendingPathComponent("libraries.json") }

    init() {
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        base = support.appendingPathComponent(appName)
        cache = base.appendingPathComponent("cache")
        layouts = base.appendingPathComponent("layouts")
        let res = Bundle.main.resourceURL!
        web = res.appendingPathComponent("web")
        seed = res.appendingPathComponent("seed")
        for d in [cache, layouts] { try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
        loadLibraryList()
    }

    private func loadLibraryList() {
        var fresh = false
        if let data = try? Data(contentsOf: listFile), let list = try? JSONDecoder().decode([String].self, from: data) {
            libraries = list
            if let m = (try? fm.attributesOfItem(atPath: listFile.path))?[.modificationDate] as? Date {
                fresh = Date().timeIntervalSince(m) < 7 * 86400
            }
        }
        if libraries.isEmpty, let data = try? Data(contentsOf: seed.appendingPathComponent("libraries.json")),
           let list = try? JSONDecoder().decode([String].self, from: data) { libraries = list }
        if !fresh { refreshLibraryList() }
    }

    private func refreshLibraryList() {
        guard let url = URL(string: sfParams + "/") else { return }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let html = String(data: data, encoding: .utf8),
                  let re = try? NSRegularExpression(pattern: "href=\"([^\"/?]+\\.xtp)\"", options: .caseInsensitive) else { return }
            var names = Set<String>()
            for m in re.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
                if let r = Range(m.range(at: 1), in: html) { names.insert(String(html[r]).removingPercentEncoding ?? String(html[r])) }
            }
            guard names.count >= 50 else { return }
            let list = names.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
            DispatchQueue.main.async {
                self.libraries = list
                try? JSONEncoder().encode(list).write(to: self.listFile)
            }
        }.resume()
    }

    func library(_ name: String, done: @escaping (Result<Data, APIError>) -> Void) {
        guard libraries.contains(name), !name.contains("/") else { return done(.failure(APIError(status: 404, message: "unknown library"))) }
        let cached = cache.appendingPathComponent(name)
        if let d = try? Data(contentsOf: cached) { return done(.success(d)) }
        if let d = try? Data(contentsOf: seed.appendingPathComponent(name)) { try? d.write(to: cached); return done(.success(d)) }
        let enc = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? name
        guard let url = URL(string: "\(sfParams)/\(enc)?format=raw") else { return done(.failure(APIError(status: 400, message: "bad name"))) }
        var req = URLRequest(url: url); req.timeoutInterval = 30
        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err { return done(.failure(APIError(status: 502, message: "SourceForge: \(err.localizedDescription)"))) }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200, let data else { return done(.failure(APIError(status: 502, message: "SourceForge returned HTTP \(code)"))) }
            let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1252) ?? ""
            let head = text.prefix(200).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if text.isEmpty || head.hasPrefix("<!doctype") || head.hasPrefix("<html") {
                return done(.failure(APIError(status: 502, message: "SourceForge returned an HTML page instead of the file")))
            }
            let utf8 = Data(text.utf8)
            try? utf8.write(to: cached)
            done(.success(utf8))
        }.resume()
    }

    // layouts
    func layoutURL(_ name: String) -> URL? {
        guard name.range(of: "^[\\p{L}\\p{N} _.-]{1,64}$", options: .regularExpression) != nil, !name.hasPrefix(".") else { return nil }
        return layouts.appendingPathComponent(name + ".json")
    }

    func listLayouts() -> Data {
        let files = (try? fm.contentsOfDirectory(at: layouts, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])) ?? []
        let iso = ISO8601DateFormatter()
        let items: [(String, Date, Int)] = files.filter { $0.pathExtension == "json" }.map {
            let v = try? $0.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            return ($0.deletingPathExtension().lastPathComponent, v?.contentModificationDate ?? .distantPast, v?.fileSize ?? 0)
        }.sorted { $0.1 > $1.1 }
        let arr = items.map { ["name": $0.0, "modified": iso.string(from: $0.1), "size": $0.2] as [String: Any] }
        return (try? JSONSerialization.data(withJSONObject: arr)) ?? Data("[]".utf8)
    }
}

// MARK: - stl:// scheme handler (static files + API)

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let store: Store
    private var live = Set<ObjectIdentifier>()
    init(store: Store) { self.store = store }

    static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml", "json": "application/json", "png": "image/png", "ico": "image/x-icon", "txt": "text/plain; charset=utf-8",
    ]

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { live.remove(ObjectIdentifier(task)) }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        let req = task.request
        guard let url = req.url else { return fail(task, APIError(status: 400, message: "bad request")) }
        let path = url.path, method = req.httpMethod ?? "GET"
        let json = "application/json"

        if path == "/api/libraries" {
            let data = (try? JSONEncoder().encode(store.libraries)) ?? Data("[]".utf8)
            return send(task, 200, data, json)
        }
        if path == "/api/library" {
            let file = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "file" }?.value ?? ""
            return store.library(file) { r in
                switch r {
                case .success(let d): self.send(task, 200, d, "text/plain; charset=utf-8")
                case .failure(let e): self.fail(task, e)
                }
            }
        }
        if path == "/api/layouts" { return send(task, 200, store.listLayouts(), json) }
        if path.hasPrefix("/api/layouts/") {
            let name = String(path.dropFirst("/api/layouts/".count))
            guard let file = store.layoutURL(name) else { return fail(task, APIError(status: 400, message: "invalid layout name")) }
            switch method {
            case "GET":
                if let d = try? Data(contentsOf: file) { return send(task, 200, d, json) }
                return fail(task, APIError(status: 404, message: "not found"))
            case "PUT":
                let body = bodyData(req)
                guard (try? JSONSerialization.jsonObject(with: body)) != nil else { return fail(task, APIError(status: 400, message: "invalid JSON")) }
                do { try body.write(to: file, options: .atomic) } catch { return fail(task, APIError(status: 500, message: error.localizedDescription)) }
                return send(task, 200, Data("{\"ok\":true}".utf8), json)
            case "DELETE":
                try? FileManager.default.removeItem(at: file)
                return send(task, 200, Data("{\"ok\":true}".utf8), json)
            default: return fail(task, APIError(status: 405, message: "method not allowed"))
            }
        }
        if path.hasPrefix("/api/") { return fail(task, APIError(status: 404, message: "not found")) }

        // static files from the bundled web folder
        let rel = (path == "/" || path.isEmpty) ? "index.html" : String(path.drop { $0 == "/" })
        let file = store.web.appendingPathComponent(rel).standardizedFileURL
        guard file.path.hasPrefix(store.web.standardizedFileURL.path + "/"), let data = try? Data(contentsOf: file) else {
            return fail(task, APIError(status: 404, message: "not found"))
        }
        send(task, 200, data, Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream")
    }

    private func bodyData(_ req: URLRequest) -> Data {
        if let b = req.httpBody { return b }
        guard let s = req.httpBodyStream else { return Data() }
        s.open(); defer { s.close() }
        var data = Data(); var buf = [UInt8](repeating: 0, count: 65536)
        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
        return data
    }

    private func fail(_ task: WKURLSchemeTask, _ e: APIError) {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": e.message])) ?? Data()
        send(task, e.status, body, "application/json")
    }

    private func send(_ task: WKURLSchemeTask, _ status: Int, _ data: Data, _ type: String) {
        let go = {
            guard self.live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
            let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": "\(data.count)", "Cache-Control": "no-cache"])!
            task.didReceive(resp); task.didReceive(data); task.didFinish()
            self.live.remove(ObjectIdentifier(task))
        }
        Thread.isMainThread ? go() : DispatchQueue.main.async(execute: go)
    }
}

// MARK: - Window / web view

final class EditorWindowController: NSWindowController, WKUIDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    private var titleObservation: NSKeyValueObservation?

    init(store: Store) {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(SchemeHandler(store: store), forURLScheme: scheme)
        // the self-test must never touch the user's autosaved work
        if ProcessInfo.processInfo.environment["STL_SELFTEST"] != nil { cfg.websiteDataStore = .nonPersistent() }
        let ucc = WKUserContentController()
        cfg.userContentController = ucc
        webView = WKWebView(frame: .zero, configuration: cfg)
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        win.title = appName
        win.minSize = NSSize(width: 760, height: 520)
        win.contentView = webView
        win.center()
        win.setFrameAutosaveName("MainWindow")
        win.tabbingMode = .disallowed
        super.init(window: win)
        ucc.add(self, name: "stl")
        webView.uiDelegate = self
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        // mirror the page title ("• Layout name — SmardTrackLayout") in the window title
        titleObservation = webView.observe(\.title, options: [.new]) { [weak win] wv, _ in
            if let t = wv.title, !t.isEmpty { win?.title = t }
        }
        webView.load(URLRequest(url: URL(string: "\(scheme)://app/index.html")!))
    }
    required init?(coder: NSCoder) { fatalError() }

    func js(_ code: String) { webView.evaluateJavaScript("window.stlApp && \(code)", completionHandler: nil) }

    // STL_SELFTEST=1: run a scripted smoke test in the real web view, print the result and quit.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ProcessInfo.processInfo.environment["STL_SELFTEST"] != nil else { return }
        let test = """
        await new Promise(r => { const t = setInterval(() => { if (document.querySelector('.pitem')) { clearInterval(t); r(); } }, 100); });
        localStorage.clear();
        const click = async pn => { [...document.querySelectorAll('.pitem')].find(b => b.querySelector('.pn').textContent === pn).click(); await new Promise(r => setTimeout(r, 30)); };
        for (const pn of ['24130','24130','24130','24130','24130','24130','24188','24130','24130','24130','24130','24130','24130','24188']) await click(pn);
        const counts = document.querySelector('#stCounts').textContent;
        const lib = await (await fetch('api/library?file=' + encodeURIComponent('HO-Piko-A.xtp'))).text();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
        stlApp.copy(); await stlApp.paste();
        const afterPaste = document.querySelector('#stCounts').textContent;
                const doc = JSON.parse(stlApp.docFor('Testname')); stlApp.savedAs('Testname');
        await new Promise(r => setTimeout(r, 100));
        const legal = (await (await fetch('legal/THIRD_PARTY_NOTICES.txt')).text()).split('\\n')[0] + ' / ' + (await (await fetch('legal/GPL-2.0.txt')).text()).trim().split('\\n')[0].trim();
        return JSON.stringify({ legal, counts, afterPaste, piko: lib.split('\\n')[0], docName: doc.name, title: document.title, window: (window.__winTitle || '') });
        """
        let testFile = ProcessInfo.processInfo.environment["STL_SELFTEST_FILE"].map { URL(fileURLWithPath: $0) }
        currentURL = testFile  // pretend this layout was opened from that file, so "Save" writes there
        webView.callAsyncJavaScript(test, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): print("SELFTEST OK", v as? String ?? "\(v)", "| NSWindow.title:", self.window?.title ?? "-")
            case .failure(let e): print("SELFTEST FAIL", e)
            }
            guard let testFile else { fflush(stdout); NSApp.terminate(nil); return }
            webView.evaluateJavaScript("stlApp.save()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                let saved = (try? String(contentsOf: testFile, encoding: .utf8)) ?? ""
                let doc = (try? JSONSerialization.jsonObject(with: Data(saved.utf8))) as? [String: Any]
                print("SELFTEST SAVE", doc == nil ? "FAIL (nothing written)" : "OK name=\(doc!["name"] ?? "-") parts=\((doc!["parts"] as? [Any])?.count ?? -1) title=\(self.window?.title ?? "-")")
                fflush(stdout); NSApp.terminate(nil)
            }
        }
    }

    // Keep navigation inside the app; open external links in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url); return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // Save panels for the web page: "saveAs" (layout; the chosen file name becomes the layout name)
    // and "download" (e.g. parts list CSV, content supplied by the page).
    // File handling for the web page. The app remembers the current file, so "save" writes back
    // to it; "saveAs" / "open" use the standard panels; "download" saves page-supplied content (CSV).
    private var currentURL: URL?

    private static func layoutBase(_ url: URL) -> String {
        var base = url.lastPathComponent
        for ext in [".json", ".stl"] where base.lowercased().hasSuffix(ext) { base = String(base.dropLast(ext.count)) }
        return base
    }

    private func saveLayout(to url: URL, name: String) {
        webView.callAsyncJavaScript("return stlApp.docFor(n)", arguments: ["n": name], in: nil, in: .page) { res in
            guard case .success(let v) = res, let text = v as? String else { return }
            if self.write(text, to: url) {
                self.currentURL = url
                self.window?.representedURL = url
                self.webView.callAsyncJavaScript("stlApp.savedAs(n)", arguments: ["n": name], in: nil, in: .page, completionHandler: nil)
            }
        }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String, let window else { return }
        let name = body["name"] as? String ?? "Untitled.stl.json"

        switch type {
        case "new":
            currentURL = nil; window.representedURL = nil
            return
        case "save":
            if let url = currentURL {
                // keep the layout name typed in the editor; write to the same file
                webView.callAsyncJavaScript("return stlApp.name()", arguments: [:], in: nil, in: .page) { res in
                    let n = (try? res.get()) as? String ?? Self.layoutBase(url)
                    self.saveLayout(to: url, name: n)
                }
                return
            }
            fallthrough // no file yet: behave like Save As
        case "saveAs", "download":
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.canCreateDirectories = true
            panel.isExtensionHidden = false
            if type != "download", let dir = currentURL?.deletingLastPathComponent() { panel.directoryURL = dir }
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return }
                if type == "download" { if let text = body["text"] as? String { self.write(text, to: url) }; return }
                self.saveLayout(to: url, name: Self.layoutBase(url))
            }
        case "open":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.json]
            panel.allowsMultipleSelection = false
            if let dir = currentURL?.deletingLastPathComponent() { panel.directoryURL = dir }
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return }
                do {
                    let text = try String(contentsOf: url, encoding: .utf8)
                    let n = Self.layoutBase(url)
                    self.webView.callAsyncJavaScript("await stlApp.openText(t, n)", arguments: ["t": text, "n": n], in: nil, in: .page) { res in
                        if case .failure(let e) = res {
                            let a = NSAlert(); a.messageText = "Could not open “\(url.lastPathComponent)”"; a.informativeText = e.localizedDescription
                            a.beginSheetModal(for: window)
                        } else { self.currentURL = url; window.representedURL = url }
                    }
                } catch { NSAlert(error: error).beginSheetModal(for: window) }
            }
        default: return
        }
    }

    @discardableResult
    private func write(_ text: String, to url: URL) -> Bool {
        do { try Data(text.utf8).write(to: url, options: .atomic); return true }
        catch { if let window { NSAlert(error: error).beginSheetModal(for: window) }; return false }
    }

    // JS dialogs
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window!) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window!) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        p.canChooseDirectories = false
        p.beginSheetModal(for: window!) { completionHandler($0 == .OK ? p.urls : nil) }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    var store: Store!
    var wc: EditorWindowController!

    func applicationDidFinishLaunching(_ n: Notification) {
        store = Store()
        buildMenu()
        wc = EditorWindowController(store: store)
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    @objc func cmd(_ sender: NSMenuItem) { if let c = sender.representedObject as? String { wc.js(c) } }
    @objc func showAbout(_ s: Any?) {
        let text = """
        Model railway track layout editor.

        Track geometry: XTrackCAD parameter libraries, © the XTrackCAD developers and contributors, \
        licensed under the GNU General Public License v2 or later. Source: sourceforge.net/p/xtrkcad-fork

        Manufacturer names and article numbers (e.g. Märklin, C-Gleis) are trademarks of their owners \
        and are used only to identify track pieces. Not affiliated with or endorsed by them.

        Help ▸ Licenses shows the full notices and license text.
        """
        let credits = NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.labelColor])
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func openXTrackCAD(_ s: Any?) { NSWorkspace.shared.open(URL(string: "https://sourceforge.net/p/xtrkcad-fork/xtrkcad/")!) }

    private func item(_ title: String, _ js: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: #selector(cmd(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = mods; i.representedObject = js; i.target = self
        return i
    }

    private func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title); items.forEach(m.addItem)
            let host = NSMenuItem(); host.submenu = m; main.addItem(host); return m
        }
        _ = sub(appName, [
            NSMenuItem(title: "About \(appName)", action: #selector(showAbout(_:)), keyEquivalent: ""),
            .separator(),
            NSMenuItem(title: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        _ = sub("File", [
            item("New Layout", "stlApp.newLayout()", "n"),
            item("Open…", "stlApp.openFile()", "o"),
            .separator(),
            item("Save", "stlApp.save()", "s"),
            item("Save As…", "stlApp.saveAs()", "s", [.command, .shift]),
            .separator(),
            NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
        ])
        _ = sub("Edit", [
            item("Undo", "stlApp.undo()", "z"),
            item("Redo", "stlApp.redo()", "z", [.command, .shift]),
            .separator(),
            NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
            item("Duplicate", "stlApp.duplicate()", "d"),
        ])
        _ = sub("Arrange", [
            item("Rotate Clockwise", "stlApp.rotate()", "r", [.command, .option]),
            item("Rotate Counter-Clockwise", "stlApp.rotate(-(parseFloat(document.getElementById('rotStep').value)||15))", "r", [.command, .option, .shift]),
            item("Rotate 90° Clockwise", "stlApp.rotate(90)", ""),
            item("Rotate 180°", "stlApp.rotate(180)", ""),
        ])
        _ = sub("Tools", [
            item("Select / Move   V", "stlApp.tool('select')", ""),
            .separator(),
            item("Line   L", "stlApp.tool('line')", ""),
            item("Polyline / Outline   P", "stlApp.tool('poly')", ""),
            item("Rectangle   B", "stlApp.tool('rect')", ""),
            item("Circle   O", "stlApp.tool('circle')", ""),
            item("Dimension   D", "stlApp.tool('dim')", ""),
            item("Text   T", "stlApp.tool('text')", ""),
        ])
        _ = sub("View", [
            item("Zoom to Fit", "stlApp.fit()", "0"),
            item("Toggle Part Labels", "stlApp.toggleLabels()", "l"),
            item("Parts List", "stlApp.partsList()", "p", [.command, .shift]),
            .separator(),
            NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f"),
        ]).items.last?.keyEquivalentModifierMask = [.command, .control]
        let win = sub("Window", [
            NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
            NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""),
        ])
        let xtc = NSMenuItem(title: "XTrackCAD Libraries on SourceForge", action: #selector(openXTrackCAD(_:)), keyEquivalent: "")
        xtc.target = self
        let help = sub("Help", [item("\(appName) Help", "stlApp.help()", "?"), item("Licenses…", "stlApp.licenses()"), xtc])
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
        NSApp.helpMenu = help
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
