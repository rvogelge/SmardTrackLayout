// SmardTrackLayout - model railway track layout editor
// Copyright (C) 2026 Rolf Vogelgesang
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version. It is distributed
// WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
//
// SPDX-License-Identifier: GPL-3.0-or-later

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

// MARK: - Preferences and menu language

/// App-level preferences. The web editor keeps its own settings (language, default library) in
/// WebKit storage; the app mirrors the language for its menus and owns the data folder.
enum Prefs {
    static let selftest = ProcessInfo.processInfo.environment["STL_SELFTEST"] != nil
    /// STL_SELFTEST_PHASE=save, then =restart: checks that Save still writes to the same file after a restart
    static let selftestPhase = ProcessInfo.processInfo.environment["STL_SELFTEST_PHASE"]
    /// the self-test must not change the user's preferences
    static let d: UserDefaults = {
        guard selftest, let t = UserDefaults(suiteName: "com.github.rvogelge.smardtracklayout.selftest") else { return .standard }
        if selftestPhase != "restart" { t.removePersistentDomain(forName: "com.github.rvogelge.smardtracklayout.selftest") }
        return t
    }()
    static let languages = ["en", "de", "fr", "it", "es"]
    static var langPref: String { get { d.string(forKey: "lang") ?? "auto" } set { d.set(newValue, forKey: "lang") } }
    static var lang: String {
        if languages.contains(langPref) { return langPref }
        for l in Locale.preferredLanguages { let k = String(l.prefix(2)).lowercased(); if languages.contains(k) { return k } }
        return "en"
    }
    static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    /// custom data folder, or nil for Documents
    static var customDataDir: URL? {
        get {
            guard let p = d.string(forKey: "dataDir"), FileManager.default.fileExists(atPath: p) else { return nil }
            return URL(fileURLWithPath: p, isDirectory: true)
        }
        set { if let u = newValue { d.set(u.path, forKey: "dataDir") } else { d.removeObject(forKey: "dataDir") } }
    }
    static var dataDir: URL { customDataDir ?? documents }
    /// the file the current layout belongs to, so Save keeps writing there after a restart
    static var currentFile: URL? {
        get { d.string(forKey: "currentFile").map { URL(fileURLWithPath: $0) }.flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil } }
        set { if let u = newValue { d.set(u.path, forKey: "currentFile") } else { d.removeObject(forKey: "currentFile") } }
    }
}

/// menu / dialog texts: English key → [de, fr, it, es]
let menuTexts: [String: [String]] = [
    "About %@": ["Über %@", "À propos de %@", "Informazioni su %@", "Acerca de %@"],
    "Settings…": ["Einstellungen…", "Réglages…", "Impostazioni…", "Ajustes…"],
    "Hide %@": ["%@ ausblenden", "Masquer %@", "Nascondi %@", "Ocultar %@"],
    "Quit %@": ["%@ beenden", "Quitter %@", "Esci da %@", "Salir de %@"],
    "File": ["Ablage", "Fichier", "File", "Archivo"],
    "New Layout": ["Neuer Gleisplan", "Nouveau plan", "Nuovo tracciato", "Nueva maqueta"],
    "Open…": ["Öffnen…", "Ouvrir…", "Apri…", "Abrir…"],
    "Save": ["Sichern", "Enregistrer", "Salva", "Guardar"],
    "Save As…": ["Sichern unter…", "Enregistrer sous…", "Salva come…", "Guardar como…"],
    "Close Window": ["Fenster schließen", "Fermer la fenêtre", "Chiudi finestra", "Cerrar ventana"],
    "Edit": ["Bearbeiten", "Édition", "Modifica", "Edición"],
    "Undo": ["Widerrufen", "Annuler", "Annulla", "Deshacer"],
    "Redo": ["Wiederholen", "Rétablir", "Ripeti", "Rehacer"],
    "Cut": ["Ausschneiden", "Couper", "Taglia", "Cortar"],
    "Copy": ["Kopieren", "Copier", "Copia", "Copiar"],
    "Paste": ["Einsetzen", "Coller", "Incolla", "Pegar"],
    "Select All": ["Alles auswählen", "Tout sélectionner", "Seleziona tutto", "Seleccionar todo"],
    "Duplicate": ["Duplizieren", "Dupliquer", "Duplica", "Duplicar"],
    "Arrange": ["Anordnen", "Disposition", "Disponi", "Organizar"],
    "Rotate Clockwise": ["Im Uhrzeigersinn drehen", "Pivoter dans le sens horaire", "Ruota in senso orario", "Girar en sentido horario"],
    "Rotate Counter-Clockwise": ["Gegen den Uhrzeigersinn drehen", "Pivoter dans le sens antihoraire", "Ruota in senso antiorario", "Girar en sentido antihorario"],
    "Rotate 90° Clockwise": ["Um 90° im Uhrzeigersinn drehen", "Pivoter de 90° (sens horaire)", "Ruota di 90° in senso orario", "Girar 90° en sentido horario"],
    "Rotate 180°": ["Um 180° drehen", "Pivoter de 180°", "Ruota di 180°", "Girar 180°"],
    "Tools": ["Werkzeuge", "Outils", "Strumenti", "Herramientas"],
    "Select / Move": ["Auswählen / Verschieben", "Sélectionner / Déplacer", "Seleziona / Sposta", "Seleccionar / Mover"],
    "Line": ["Linie", "Ligne", "Linea", "Línea"],
    "Polyline / Outline": ["Polylinie / Umriss", "Polyligne / Contour", "Polilinea / Contorno", "Polilínea / Contorno"],
    "Rectangle": ["Rechteck", "Rectangle", "Rettangolo", "Rectángulo"],
    "Circle": ["Kreis", "Cercle", "Cerchio", "Círculo"],
    "Dimension": ["Bemaßung", "Cote", "Quota", "Cota"],
    "Text": ["Text", "Texte", "Testo", "Texto"],
    "View": ["Darstellung", "Présentation", "Vista", "Visualización"],
    "Zoom to Fit": ["Alles einpassen", "Tout afficher", "Mostra tutto", "Ver todo"],
    "Toggle Part Labels": ["Artikelnummern ein/aus", "Afficher/masquer les références", "Mostra/nascondi codici", "Mostrar/ocultar referencias"],
    "Parts List": ["Stückliste", "Liste des pièces", "Distinta dei pezzi", "Lista de piezas"],
    "Show/Hide Layers": ["Ebenen ein-/ausblenden", "Afficher/masquer les calques", "Mostra/nascondi livelli", "Mostrar/ocultar capas"],
    "Enter Full Screen": ["Vollbildmodus", "Plein écran", "Modalità a tutto schermo", "Pantalla completa"],
    "Window": ["Fenster", "Fenêtre", "Finestra", "Ventana"],
    "Minimize": ["Im Dock ablegen", "Placer dans le Dock", "Contrai", "Minimizar"],
    "Zoom": ["Zoomen", "Réduire/agrandir", "Ridimensiona", "Zoom"],
    "Help": ["Hilfe", "Aide", "Aiuto", "Ayuda"],
    "%@ Help": ["%@-Hilfe", "Aide %@", "Aiuto di %@", "Ayuda de %@"],
    "Licenses…": ["Lizenzen…", "Licences…", "Licenze…", "Licencias…"],
    "XTrackCAD Libraries on SourceForge": ["XTrackCAD-Bibliotheken auf SourceForge", "Bibliothèques XTrackCAD sur SourceForge", "Librerie XTrackCAD su SourceForge", "Bibliotecas XTrackCAD en SourceForge"],
    "Could not open “%@”": ["„%@“ konnte nicht geöffnet werden", "Impossible d’ouvrir « %@ »", "Impossibile aprire «%@»", "No se pudo abrir «%@»"],
    "Default data folder": ["Standard-Datenordner", "Dossier de données par défaut", "Cartella dati predefinita", "Carpeta de datos predeterminada"],
    "Choose": ["Auswählen", "Choisir", "Scegli", "Elegir"],
    "Cancel": ["Abbrechen", "Annuler", "Annulla", "Cancelar"],
]
func L(_ key: String, _ arg: String? = nil) -> String {
    var s = key
    if let i = Prefs.languages.firstIndex(of: Prefs.lang), i > 0, let tr = menuTexts[key] { s = tr[i - 1] }
    if let arg { s = s.replacingOccurrences(of: "%@", with: arg) }
    return s
}
func abbreviate(_ url: URL) -> String { (url.path as NSString).abbreviatingWithTildeInPath }

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
        if Prefs.selftest {
            // phases need storage that survives a restart, but separate from the user's
            if Prefs.selftestPhase != nil, #available(macOS 14.0, *) {
                cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "5F0C2A9E-6B1D-4C61-9E0F-2A7B3C4D5E6F")!)
            } else { cfg.websiteDataStore = .nonPersistent() }
        }
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: Self.nativeInfoScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        // the page confirms with a "restore" message whether its autosaved work still belongs to this file
        currentURL = Prefs.currentFile; win.representedURL = currentURL
        webView.load(URLRequest(url: URL(string: "\(scheme)://app/index.html")!))
    }
    required init?(coder: NSCoder) { fatalError() }

    /// tells the page about the data folder before its scripts run
    static func nativeInfoScript() -> String {
        let info: [String: Any] = ["dataDir": Prefs.customDataDir.map(abbreviate) ?? NSNull(), "documents": abbreviate(Prefs.documents)]
        let json = String(data: (try? JSONSerialization.data(withJSONObject: info)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        return "window.__stlNative = \(json);"
    }
    /// called when the page changes its language setting, so the menus follow
    var onLanguageChange: (() -> Void)?

    // links with target=_blank (e.g. the commit link in Settings) open in the browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    func js(_ code: String) { webView.evaluateJavaScript("window.stlApp && \(code)", completionHandler: nil) }

    // STL_SELFTEST=1: run a scripted smoke test in the real web view, print the result and quit.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ProcessInfo.processInfo.environment["STL_SELFTEST"] != nil else { return }
        if Prefs.selftestPhase == "restart" { return restartTest() }
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
        const build = await (await fetch('build.json')).json();
        stlApp.settings(); await new Promise(r => setTimeout(r, 100));
        const langOpts = document.querySelectorAll('#setLang option').length, libOpts = document.querySelectorAll('#setLib option').length;
        document.getElementById('setLang').value = 'de'; document.getElementById('setLang').dispatchEvent(new Event('change'));
        document.getElementById('setLib').value = 'HO-Piko-A.xtp';
        await new Promise(r => setTimeout(r, 300));
        const buildText = document.getElementById('buildInfo').textContent;
        document.getElementById('dlgSettings').close('ok'); await new Promise(r => setTimeout(r, 100));
        const de = [document.getElementById('btnSave').getAttribute('aria-label'), document.querySelector('#emptyHint strong').textContent, document.getElementById('stCounts').textContent, document.querySelector('#dlgHelp li').textContent.slice(0, 30)].join(' | ');
        return JSON.stringify({ legal, counts, afterPaste, piko: lib.split('\\n')[0], docName: doc.name, title: document.title, build, langOpts, libOpts, buildText, de, settings: localStorage.getItem('stl.settings'), nativeInfo: window.__stlNative });
        """
        let testFile = ProcessInfo.processInfo.environment["STL_SELFTEST_FILE"].map { URL(fileURLWithPath: $0) }
        webView.callAsyncJavaScript(test, arguments: [:], in: nil, in: .page) { r in
            if let testFile { self.currentURL = testFile }  // pretend the layout was opened from that file, so "Save" writes there
            switch r {
            case .success(let v): print("SELFTEST OK", v as? String ?? "\(v)", "| NSWindow.title:", self.window?.title ?? "-")
            case .failure(let e): print("SELFTEST FAIL", e)
            }
            guard let testFile else { fflush(stdout); NSApp.terminate(nil); return }
            webView.evaluateJavaScript("stlApp.save()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                if Prefs.selftestPhase == "save" { print("SELFTEST PHASE save done, file:", Prefs.currentFile?.path ?? "-"); fflush(stdout); NSApp.terminate(nil); return }
                let saved = (try? String(contentsOf: testFile, encoding: .utf8)) ?? ""
                let doc = (try? JSONSerialization.jsonObject(with: Data(saved.utf8))) as? [String: Any]
                print("SELFTEST SAVE", doc == nil ? "FAIL (nothing written)" : "OK name=\(doc!["name"] ?? "-") parts=\((doc!["parts"] as? [Any])?.count ?? -1) title=\(self.window?.title ?? "-")")
                print("SELFTEST MENUS", NSApp.mainMenu?.items.compactMap { $0.submenu?.title }.joined(separator: ", ") ?? "-", "| lang pref:", Prefs.langPref)
                // a new layout starts with the default library from the settings
                webView.evaluateJavaScript("window.__stl.dirty = false; stlApp.newLayout()", completionHandler: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    webView.evaluateJavaScript("document.getElementById('libSelect').value + ' / ' + document.getElementById('layoutName').value + ' / ' + document.getElementById('libTitle').textContent") { v, _ in
                        print("SELFTEST NEW", v ?? "-"); fflush(stdout); NSApp.terminate(nil)
                    }
                }
            }
        }
    }

    /// second launch: the autosaved layout must still be linked to its file, so Save writes without a panel
    private func restartTest() {
        let wait = "await new Promise(r => { const t = setInterval(() => { if (window.__stl && __stl.parts.length) { clearInterval(t); r(); } }, 100); }); await new Promise(r => setTimeout(r, 500)); return __stl.parts.length;"
        webView.callAsyncJavaScript(wait, arguments: [:], in: nil, in: .page) { r in
            let file = self.currentURL
            let before = file.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
            self.webView.evaluateJavaScript("window.__stl.dirty = true; stlApp.save()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                let after = file.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
                print("SELFTEST RESTART parts=\((try? r.get()) ?? "-") file=\(file?.lastPathComponent ?? "none") panel=\(self.window?.attachedSheet != nil) rewritten=\(before != nil && after != nil && after! > before!) title=\(self.window?.title ?? "-")")
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
    private var currentURL: URL? {
        didSet { Prefs.currentFile = currentURL; window?.representedURL = currentURL }
    }

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
        case "restore":
            if (body["hasFile"] as? Bool) != true { currentURL = nil }
            return
        case "settings":
            if let l = body["lang"] as? String { Prefs.langPref = l; onLanguageChange?() }
            return
        case "chooseDataDir":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.message = L("Default data folder"); panel.prompt = L("Choose")
            let cur = (body["current"] as? String).map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
            panel.directoryURL = cur ?? Prefs.dataDir
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return }
                self.webView.callAsyncJavaScript("stlApp.dataDirChosen(p)", arguments: ["p": abbreviate(url)], in: nil, in: .page, completionHandler: nil)
            }
            return
        case "setDataDir":
            if let p = body["path"] as? String, !p.isEmpty {
                let url = URL(fileURLWithPath: (p as NSString).expandingTildeInPath, isDirectory: true)
                Prefs.customDataDir = url.standardizedFileURL == Prefs.documents.standardizedFileURL ? nil : url
            } else { Prefs.customDataDir = nil }
            refreshNativeInfo()
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
            panel.directoryURL = (type != "download" ? currentURL?.deletingLastPathComponent() : nil) ?? Prefs.dataDir
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return }
                if type == "download" { if let text = body["text"] as? String { self.write(text, to: url) }; return }
                self.saveLayout(to: url, name: Self.layoutBase(url))
            }
        case "open":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = [.json]
            panel.allowsMultipleSelection = false
            panel.directoryURL = currentURL?.deletingLastPathComponent() ?? Prefs.dataDir
            panel.beginSheetModal(for: window) { r in
                guard r == .OK, let url = panel.url else { return }
                do {
                    let text = try String(contentsOf: url, encoding: .utf8)
                    let n = Self.layoutBase(url)
                    self.webView.callAsyncJavaScript("await stlApp.openText(t, n)", arguments: ["t": text, "n": n], in: nil, in: .page) { res in
                        if case .failure(let e) = res {
                            let a = NSAlert(); a.messageText = L("Could not open “%@”", url.lastPathComponent); a.informativeText = e.localizedDescription
                            a.beginSheetModal(for: window)
                        } else { self.currentURL = url; window.representedURL = url }
                    }
                } catch { NSAlert(error: error).beginSheetModal(for: window) }
            }
        default: return
        }
    }

    /// keep the injected info current for reloads
    private func refreshNativeInfo() {
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        ucc.addUserScript(WKUserScript(source: Self.nativeInfoScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: L("Cancel"))
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
        wc.onLanguageChange = { [weak self] in self?.buildMenu() }
        wc.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    @objc func cmd(_ sender: NSMenuItem) { if let c = sender.representedObject as? String { wc.js(c) } }
    @objc func showAbout(_ s: Any?) {
        let text = """
        Model railway track layout editor.
        © 2026 Rolf Vogelgesang. Free software under the GNU General Public License v3 or later; \
        it comes with ABSOLUTELY NO WARRANTY. Source: github.com/rvogelge/SmardTrackLayout

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
            NSMenuItem(title: L("About %@", appName), action: #selector(showAbout(_:)), keyEquivalent: ""),
            .separator(),
            item(L("Settings…"), "stlApp.settings()", ","),
            .separator(),
            NSMenuItem(title: L("Hide %@", appName), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            NSMenuItem(title: L("Quit %@", appName), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        _ = sub(L("File"), [
            item(L("New Layout"), "stlApp.newLayout()", "n"),
            item(L("Open…"), "stlApp.openFile()", "o"),
            .separator(),
            item(L("Save"), "stlApp.save()", "s"),
            item(L("Save As…"), "stlApp.saveAs()", "s", [.command, .shift]),
            .separator(),
            NSMenuItem(title: L("Close Window"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
        ])
        _ = sub(L("Edit"), [
            item(L("Undo"), "stlApp.undo()", "z"),
            item(L("Redo"), "stlApp.redo()", "z", [.command, .shift]),
            .separator(),
            NSMenuItem(title: L("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: L("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: L("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: L("Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
            item(L("Duplicate"), "stlApp.duplicate()", "d"),
        ])
        _ = sub(L("Arrange"), [
            item(L("Rotate Clockwise"), "stlApp.rotate()", "r", [.command, .option]),
            item(L("Rotate Counter-Clockwise"), "stlApp.rotate(-(parseFloat(document.getElementById('rotStep').value)||15))", "r", [.command, .option, .shift]),
            item(L("Rotate 90° Clockwise"), "stlApp.rotate(90)", ""),
            item(L("Rotate 180°"), "stlApp.rotate(180)", ""),
        ])
        _ = sub(L("Tools"), [
            item(L("Select / Move") + "   V", "stlApp.tool('select')", ""),
            .separator(),
            item(L("Line") + "   L", "stlApp.tool('line')", ""),
            item(L("Polyline / Outline") + "   P", "stlApp.tool('poly')", ""),
            item(L("Rectangle") + "   B", "stlApp.tool('rect')", ""),
            item(L("Circle") + "   O", "stlApp.tool('circle')", ""),
            item(L("Dimension") + "   D", "stlApp.tool('dim')", ""),
            item(L("Text") + "   T", "stlApp.tool('text')", ""),
        ])
        _ = sub(L("View"), [
            item(L("Zoom to Fit"), "stlApp.fit()", "0"),
            item(L("Toggle Part Labels"), "stlApp.toggleLabels()", "l"),
            item(L("Parts List"), "stlApp.partsList()", "p", [.command, .shift]),
            item(L("Show/Hide Layers"), "stlApp.toggleLayers()", "l", [.command, .option]),
            .separator(),
            NSMenuItem(title: L("Enter Full Screen"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f"),
        ]).items.last?.keyEquivalentModifierMask = [.command, .control]
        let win = sub(L("Window"), [
            NSMenuItem(title: L("Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
            NSMenuItem(title: L("Zoom"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""),
        ])
        let xtc = NSMenuItem(title: L("XTrackCAD Libraries on SourceForge"), action: #selector(openXTrackCAD(_:)), keyEquivalent: "")
        xtc.target = self
        let help = sub(L("Help"), [item(L("%@ Help", appName), "stlApp.help()", "?"), item(L("Licenses…"), "stlApp.licenses()"), xtc])
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
