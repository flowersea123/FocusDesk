import AppKit
import Carbon.HIToolbox
import CoreGraphics
import CryptoKit
import Darwin
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let permissionMessage = "请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制（或屏幕录制）」中允许 FocusDesk Capture，然后回到面板重新开始。"

struct FrontWindow: Equatable {
    let pid: pid_t
    let window: CGWindowID
    let app: String
    let title: String
    let rect: CGRect
}

func cleanTitle(_ text: String) -> String {
    text.components(separatedBy: .controlCharacters).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}

func protectedApp(_ bundle: String, _ name: String) -> Bool {
    let id = bundle.lowercased(), name = name.lowercased()
    let privateIDs = ["app.focusdesk.", "com.apple.loginwindow", "com.apple.screensaver", "com.apple.securityagent",
                      "com.apple.keychainaccess", "com.apple.passwords", "com.apple.localauthentication", "com.1password",
                      "com.agilebits.", "com.bitwarden.", "com.bitwarden", "org.keepass", "org.keepassxc.",
                      "com.dashlane", "com.lastpass", "com.sinew.", "me.proton.pass", "com.proton.pass", "com.enpass"]
    let names = ["1password", "bitwarden", "keepass", "keychain access", "passwords", "dashlane",
                 "lastpass", "enpass", "proton pass", "钥匙串访问", "密码管理器", "屏幕保护程序", "loginwindow"]
    return privateIDs.contains(where: id.hasPrefix) || names.contains(where: name.contains) || ["密码", "focusdesk", "focusdesk capture"].contains(name)
}

func protectedTitle(_ title: String) -> Bool {
    let lower = title.lowercased()
    let ownPages = ["focusdesk · 今日概览", "focusdesk · 设备连接", "outlook 邮箱 · focusdesk"]
    if ownPages.contains(where: { lower == $0 || lower.hasPrefix($0 + " - ") || lower.hasPrefix($0 + " — ") }) { return true }
    return ["1password", "bitwarden", "keepass", "password manager", "钥匙串访问", "密码管理", "proton pass", "lastpass", "dashlane", "enpass"].contains(where: lower.contains)
}

/// CGWindowListCopyWindowInfo returns front-to-back order. Never substitute a window behind a disallowed front window.
func selectWindow(pid: pid_t, name: String, bundle: String, windows: [[String: Any]]) -> FrontWindow? {
    guard !protectedApp(bundle, name) else { return nil }
    for row in windows {
        guard let owner = row[kCGWindowOwnerPID as String] as? NSNumber, let level = row[kCGWindowLayer as String] as? NSNumber,
              (row[kCGWindowIsOnscreen as String] as? Bool) != false, (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: bounds),
              frame.width >= 64, frame.height >= 40 else { continue }
        if level.intValue != 0 {
            // A sheet or panel of this app is covering its content. Leave this sample empty.
            if owner.int32Value == pid && level.intValue > 0 { return nil }
            continue
        }
        guard owner.int32Value == pid, let number = row[kCGWindowNumber as String] as? NSNumber,
              (row[kCGWindowSharingState as String] as? NSNumber)?.intValue != 0 else { return nil }
        let title = cleanTitle(row[kCGWindowName as String] as? String ?? "")
        guard !protectedTitle(title) else { return nil }
        return FrontWindow(pid: pid, window: number.uint32Value, app: name, title: title, rect: frame)
    }
    return nil
}

func opaquePageKey(salt: String, window: FrontWindow, title: String) -> String {
    let content = [salt, String(window.pid), String(window.window), title].joined(separator: "\u{0}")
    return SHA256.hash(data: Data(content.utf8)).map { String(format: "%02x", $0) }.joined()
}

func jpeg(_ image: CGImage) -> String? {
    guard image.width > 0, image.height > 0, max(image.width, image.height) <= 1440 else { return nil }
    for quality in [0.72, 0.50, 0.32] {
        let bytes = NSMutableData()
        guard let out = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(out, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        if CGImageDestinationFinalize(out), bytes.length <= 1_048_576 {
            return "data:image/jpeg;base64," + (bytes as Data).base64EncodedString()
        }
    }
    return nil
}

/// Always filters a single SCWindow. The fixture exercises this same production filter and encoder.
func captureContentWindow(_ window: SCWindow) async throws -> CGImage? {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    let pixels = CGFloat(max(1,filter.pointPixelScale)), frame = filter.contentRect
    guard frame.width >= 64, frame.height >= 40 else { return nil }
    let scale = min(pixels, 1440 / max(frame.width,frame.height))
    config.width = max(1,Int(frame.width * scale)); config.height = max(1,Int(frame.height * scale))
    config.showsCursor = false; config.capturesAudio = false; config.ignoreShadowsSingleWindow = true
    if #available(macOS 14.2, *) { config.includeChildWindows = false }
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

/// IPC has no network port. The caller owns an ephemeral mode-0700 directory and a mode-0600 socket.
final class SessionWire {
    private let fd: Int32
    private let writer = DispatchQueue(label: "app.focusdesk.capture.writer")
    let secret: String

    init?(socket path: String) {
        let folder = URL(fileURLWithPath: path).deletingLastPathComponent()
        guard folder.deletingLastPathComponent().path == "/tmp", folder.lastPathComponent.hasPrefix("focusdesk-cap-"),
              URL(fileURLWithPath: path).lastPathComponent == "session.sock" else { return nil }
        var metadata = stat()
        guard lstat(folder.path, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFDIR,
              metadata.st_mode & 0o077 == 0, lstat(path, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFSOCK,
              let token = try? String(contentsOf: folder.appendingPathComponent("secret"), encoding: .utf8), token.utf8.count == 64 else { return nil }
        secret = token
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size); address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < capacity else { Darwin.close(descriptor); return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in raw.copyBytes(from: path.utf8CString.map { UInt8(bitPattern: $0) }) }
        let connected = withUnsafePointer(to: &address) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        } }
        var uid: uid_t = 0, gid: gid_t = 0
        guard connected == 0, getpeereid(descriptor, &uid, &gid) == 0, uid == getuid() else { Darwin.close(descriptor); return nil }
        var one: Int32 = 1, deadline = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &deadline, socklen_t(MemoryLayout.size(ofValue: deadline)))
        fd = descriptor
    }
    deinit { Darwin.close(fd) }

    func listen(_ receive: @escaping ([String: Any]?) -> Void) {
        DispatchQueue.global(qos: .utility).async { [self] in
            var pending = Data(), bytes = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = Darwin.read(fd, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { break }
                pending.append(contentsOf: bytes.prefix(count))
                while let i = pending.firstIndex(of: 10) {
                    guard let command = (try? JSONSerialization.jsonObject(with: Data(pending[..<i]))) as? [String: Any] else {
                        DispatchQueue.main.async { receive(nil) }; return
                    }
                    pending.removeSubrange(...i)
                    DispatchQueue.main.async { receive(command) }
                }
                if pending.count > 4096 { break }
            }
            DispatchQueue.main.async { receive(nil) }
        }
    }
    func send(_ message: [String: Any], completion: (() -> Void)? = nil) {
        writer.async { [self] in
            defer { if let completion { DispatchQueue.main.async(execute: completion) } }
            guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
            data.append(10)
            data.withUnsafeBytes { raw in
                guard let ptr = raw.baseAddress else { return }
                var sent = 0
                while sent < raw.count {
                    let n = Darwin.send(fd, ptr.advanced(by: sent), raw.count - sent, 0)
                    if n < 0 && errno == EINTR { continue }
                    guard n > 0 else { break }
                    sent += n
                }
            }
        }
    }
}

@MainActor
final class CaptureApplication: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let wire: SessionWire
    let salt = UUID().uuidString
    var status: NSStatusItem?
    var active = false, closing = false, menuOpen = false, sleeping = false, locked = false
    var epoch = 0, captureID: Int?
    var captureTask: Task<Void, Never>?
    init(wire: SessionWire) { self.wire = wire }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(self, selector: #selector(changed), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        workspace.addObserver(self, selector: #selector(changed), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            workspace.addObserver(self, selector: #selector(sleepNow), name: name, object: nil)
        }
        for name in [NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            workspace.addObserver(self, selector: #selector(wakeNow), name: name, object: nil)
        }
        let center = DistributedNotificationCenter.default()
        center.addObserver(self, selector: #selector(lockNow), name: Notification.Name("com.apple.screenIsLocked"), object: nil)
        center.addObserver(self, selector: #selector(unlockNow), name: Notification.Name("com.apple.screenIsUnlocked"), object: nil)
        wire.listen { [weak self] command in self?.handle(command) }
        wire.send(["event":"hello", "secret":wire.secret])
    }
    @objc func changed() { epoch += 1 }
    @objc func sleepNow() { sleeping = true; changed() }
    @objc func wakeNow() { sleeping = false; changed() }
    @objc func lockNow() { locked = true; changed() }
    @objc func unlockNow() { locked = false; changed() }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = true; changed() }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; changed() }

    func showStatus() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "◉ FocusDesk · 等待授权"
        item.button?.toolTip = "FocusDesk 前台窗口记录"
        let menu = NSMenu(); menu.delegate = self
        let stop = menu.addItem(withTitle: "停止前台记录", action: #selector(userStop), keyEquivalent: "")
        stop.target = self; item.menu = menu; status = item
    }
    @objc func userStop() { finish("stopped", "USER_STOP", "你已从菜单栏停止前台记录。") }
    func finish(_ event: String, _ code: String, _ message: String) {
        guard !closing else { return }; closing = true; active = false; changed()
        captureTask?.cancel(); if let status { NSStatusBar.system.removeStatusItem(status) }
        wire.send(["event":event,"code":code,"message":message]) { NSApplication.shared.terminate(nil) }
    }
    func handle(_ command: [String: Any]?) {
        guard !closing else { return }
        guard let command, let op = command["op"] as? String else {
            closing = true; captureTask?.cancel(); NSApplication.shared.terminate(nil); return
        }
        switch op {
        case "preflight":
            guard status == nil else { return }
            let granted = CGPreflightScreenCaptureAccess()
            wire.send(["event":"permission", "granted":granted, "message":granted ? "录屏权限已授予。" : permissionMessage]) { NSApplication.shared.terminate(nil) }
        case "begin":
            guard status == nil else { return }; showStatus()
            // This path is reached only after the user starts a session and the Hub authenticates this app.
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else { finish("error","PERMISSION",permissionMessage); return }
            active = true; status?.button?.title = "◉ FocusDesk · 记录中"; wire.send(["event":"ready"])
        case "capture":
            guard let id = command["id"] as? Int, active else { return }
            if captureID != nil { wire.send(["event":"frame","id":id,"frame":NSNull()]); return }
            captureID = id
            captureTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let frame = try await self.capture()
                    if !Task.isCancelled, self.captureID == id, !self.closing {
                        self.wire.send(["event":"frame", "id":id, "frame":(frame as Any?) ?? NSNull()])
                    }
                } catch {
                    if !Task.isCancelled, !self.closing {
                        let failure = error as NSError
                        if !CGPreflightScreenCaptureAccess() || (failure.domain == SCStreamError.errorDomain && failure.code == SCStreamError.Code.userDeclined.rawValue) { self.finish("error","PERMISSION",permissionMessage) }
                        else { self.wire.send(["event":"frame","id":id,"frame":NSNull()]) }
                    }
                }
                if self.captureID == id { self.captureID = nil; self.captureTask = nil }
            }
        case "cancel": if command["id"] as? Int == captureID { captureTask?.cancel(); captureID = nil }
        case "stop": userStop()
        default: return
        }
    }
    func foreground() -> FrontWindow? {
        guard active, !closing, !sleeping, !locked, !menuOpen, !IsSecureEventInputEnabled(),
              CGDisplayIsAsleep(CGMainDisplayID()) == 0,
              let session = CGSessionCopyCurrentDictionary() as? [String:Any],
              session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session[kCGSessionLoginDoneKey as String] as? Bool == true,
              session["CGSSessionScreenIsLocked"] as? Bool != true,
              let running = NSWorkspace.shared.frontmostApplication, running.isActive, !running.isHidden,
              let bundle = running.bundleIdentifier, let name = running.localizedName, !protectedApp(bundle,name),
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] else { return nil }
        return selectWindow(pid: running.processIdentifier, name: name, bundle: bundle, windows: rows)
    }
    func capture() async throws -> [String:Any]? {
        guard CGPreflightScreenCaptureAccess() else { finish("error","PERMISSION",permissionMessage); return nil }
        let generation = epoch
        guard let first = foreground() else { return nil }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard !Task.isCancelled, epoch == generation, foreground() == first,
              let window = content.windows.first(where: { $0.windowID == first.window && $0.isOnScreen && $0.windowLayer == 0 && $0.owningApplication?.processID == first.pid }) else { return nil }
        let scTitle = cleanTitle(window.title ?? "")
        guard !protectedTitle(scTitle), scTitle.isEmpty || first.title.isEmpty || scTitle == first.title else { return nil }
        let title = first.title.isEmpty ? scTitle : first.title
        guard let image = try await captureContentWindow(window) else { return nil }
        if first.title.isEmpty && !scTitle.isEmpty {
            // Compare fresh ScreenCaptureKit metadata when Core Graphics omitted the browser tab title.
            let changed = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let after = changed.windows.first(where: { $0.windowID == first.window && $0.isOnScreen && $0.owningApplication?.processID == first.pid }),
                  cleanTitle(after.title ?? "") == scTitle else { return nil }
        }
        guard !Task.isCancelled, epoch == generation, foreground() == first, let encoded = jpeg(image) else { return nil }
        guard !Task.isCancelled, epoch == generation, foreground() == first else { return nil }
        var result = ["image":encoded,"app":String(first.app.unicodeScalars.prefix(60)),"pageKey":opaquePageKey(salt:salt,window:first,title:title)]
        if !title.isEmpty { result["pageTitle"] = String(title.unicodeScalars.prefix(160)) }
        return result
    }
}

#if !FOCUSDESK_CAPTURE_FIXTURES
@main struct FocusDeskCapture {
    @MainActor static func main() {
        let args = CommandLine.arguments
        guard args.count == 3, args[1] == "--session", let wire = SessionWire(socket:args[2]) else { return }
        let app = NSApplication.shared, delegate = CaptureApplication(wire:wire)
        app.setActivationPolicy(.accessory); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
