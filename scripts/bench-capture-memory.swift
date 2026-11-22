// Build with the production capture helper and -D FOCUSDESK_CAPTURE_FIXTURES.
// Only windows created by this process are eligible. No desktop permission prompt.
import AppKit
import Darwin
import Foundation
import ScreenCaptureKit

private func memory() -> [String: UInt64] {
    var info = mach_task_basic_info()
    var size = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.stride / MemoryLayout<natural_t>.stride)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &size)
        }
    }
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return ["rss": result == KERN_SUCCESS ? info.resident_size : 0, "maxRSS": UInt64(usage.ru_maxrss)]
}

private func emit(_ row: [String: Any]) {
    var bytes = try! JSONSerialization.data(withJSONObject: row)
    bytes.append(10)
    FileHandle.standardOutput.write(bytes)
}

private final class Scene: NSView {
    var tick = 0
    override var isOpaque: Bool { true }
    override func draw(_ rect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        let style: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                                                     .foregroundColor: NSColor.black]
        for n in 0..<29 {
            let label = "Section \(n + 1)    Synthetic document — Local run \(tick)    Read, review, write."
            (label as NSString).draw(at: NSPoint(x: 18, y: 16 + 19 * n), withAttributes: style)
        }
        for y in 0..<26 { for x in 0..<19 {
            let hue = CGFloat((x * 17 + y * 23 + tick) % 180) / 180
            NSColor(calibratedHue: hue, saturation: 0.65, brightness: 0.8, alpha: 1).setFill()
            NSRect(x: 710 + 12 * x, y: 20 + 21 * y, width: 11, height: 19).fill()
        }}
    }
}

@MainActor private final class Fixture: NSObject, NSApplicationDelegate {
    let count: Int
    var windows: [NSWindow] = []
    init(_ count: Int) { self.count = count }
    func applicationDidFinishLaunching(_ note: Notification) {
        for i in 0..<count {
            let size = NSRect(x: 22 + 6 * i, y: 35 + 6 * i, width: 960, height: 600)
            let win = NSWindow(contentRect: size, styleMask: .borderless, backing: .buffered, defer: false)
            win.title = "FocusDesk synthetic memory fixture \(i)"
            win.isReleasedWhenClosed = false; win.hasShadow = false
            win.contentView = Scene(frame: NSRect(origin: .zero, size: size.size)); win.orderBack(nil)
            windows.append(win)
        }
        emit(["ready": true, "native": memory()])
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() {
                let finished = DispatchSemaphore(value: 0)
                Task { @MainActor in await self.sample(line); finished.signal() }
                finished.wait()
            }
            Task { @MainActor in NSApp.terminate(nil) }
        }
    }
    func sample(_ line: String) async {
        if line == "memory" { emit(["native": memory()]); return }
        guard #available(macOS 14.4, *), let index = Int(line), windows.indices.contains(index) else {
            emit(["error":"invalid fixture index or macOS version"]); return
        }
        do {
            let win = windows[index], scene = win.contentView as! Scene
            scene.tick += 1; scene.needsDisplay = true; win.displayIfNeeded()
            // currentProcess cannot return other apps' windows. Reacquire the tested window each time.
            let exposed = try await SCShareableContent.currentProcess
            guard let own = exposed.windows.first(where: { $0.windowID == CGWindowID(win.windowNumber) &&
                $0.owningApplication?.processID == getpid() }) else { emit(["error":"own window unavailable"]); return }
            let before = ProcessInfo.processInfo.systemUptime
            guard let image = try await captureContentWindow(own), let encoded = jpeg(image) else {
                emit(["error":"capture/encoding failed"]); return
            }
            emit(["image": encoded, "width": image.width, "height": image.height, "bytesPerRow":image.bytesPerRow,
                  "ms": (ProcessInfo.processInfo.systemUptime - before) * 1000, "native": memory()])
        } catch { let failure = error as NSError
            emit(["error":"\(failure.domain) \(failure.code): \(failure.localizedDescription)"]) }
    }
}

@main private struct CaptureBench {
    @MainActor static func main() {
        let count = Int(CommandLine.arguments[1])!
        guard (1...4).contains(count) else { return }
        let app = NSApplication.shared, fixture = Fixture(count)
        app.setActivationPolicy(.accessory); app.delegate = fixture
        withExtendedLifetime(fixture) { app.run() }
    }
}
