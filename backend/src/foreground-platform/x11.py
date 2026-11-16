"""Local X11 recorder. Only a named per-window XComposite pixmap is read."""
import base64
import io
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading


def emit(**record):
    print(json.dumps(record, ensure_ascii=True, separators=(",", ":")), flush=True)


class NotAvailable(Exception):
    pass


def require_modules():
    try:
        import tkinter
        import dbus
        from Xlib import X, Xatom, display, error
        from Xlib.ext import composite
        from PIL import Image
    except ImportError as issue:
        raise NotAvailable("X11 录制需要 Python 3 的 Tk、D-Bus、python-xlib 和 Pillow。") from issue
    globals().update(tk=tkinter, dbus=dbus, X=X, Xatom=Xatom, Display=display.Display,
                     XErrors=error, composite=composite, Image=Image)


class SessionLock:
    """Require both the caller's local login session and an active desktop lock service."""
    def __init__(self):
        if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
            raise NotAvailable("无法连接该桌面的 D-Bus 锁屏服务。")
        self.session_bus = dbus.SessionBus(private=True)
        self.system_bus = dbus.SystemBus(private=True)
        manager = self.system_bus.get_object("org.freedesktop.login1", "/org/freedesktop/login1", introspect=False)
        session_path = manager.GetSessionByPID(dbus.UInt32(os.getpid()), dbus_interface="org.freedesktop.login1.Manager", timeout=1)
        obj = self.system_bus.get_object("org.freedesktop.login1", session_path, introspect=False)
        self.session = dbus.Interface(obj, "org.freedesktop.DBus.Properties")
        for name in ("org.gnome.ScreenSaver", "org.freedesktop.ScreenSaver", "org.mate.ScreenSaver", "org.xfce.ScreenSaver"):
            if self.session_bus.name_has_owner(name):
                path = "/" + name.replace(".", "/")
                service = self.session_bus.get_object(name, path, introspect=False)
                candidate = dbus.Interface(service, name)
                try:
                    candidate.GetActive(timeout=1)
                except dbus.DBusException:
                    continue
                self.saver = candidate
                break
        else:
            raise NotAvailable("此 X11 桌面未提供可核验的锁屏状态。")

    def close(self):
        self.session_bus.close()
        self.system_bus.close()

    def unlocked(self):
        state = self.session.GetAll("org.freedesktop.login1.Session", timeout=1)
        return (state.get("Type") == "x11" and state.get("Class") == "user" and state.get("Active") and
                "Remote" in state and not state["Remote"] and "LockedHint" in state and not state["LockedHint"] and
                not self.saver.GetActive(timeout=1))


class XDesktop:
    def __init__(self):
        self.display = Display()
        self.root = self.display.screen().root
        self.atoms = {}
        self.sensitive = re.compile(Path(__file__).with_name("sensitive-pattern.txt").read_text().strip(), re.IGNORECASE)
        self.own_page = re.compile(Path(__file__).with_name("focusdesk-pages.txt").read_text().strip(), re.IGNORECASE)
        if not self.display.has_extension("Composite"):
            raise NotAvailable("X11 服务端缺少独立窗口采集需要的 Composite 扩展。")
        version = self.display.composite_query_version()
        if (version.major_version, version.minor_version) < (0, 2):
            raise NotAvailable("XComposite 版本过旧。")
        supported = set(self.prop(self.root, "_NET_SUPPORTED", Xatom.ATOM))
        required = ("_NET_ACTIVE_WINDOW", "_NET_CLIENT_LIST", "_NET_WM_STATE_ABOVE")
        if not all(self.atom(name) in supported for name in required):
            raise NotAvailable("窗口管理器未提供可信的前台窗口或置顶停止按钮。")
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        self.display.sync()

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.display.intern_atom(name)
        return self.atoms[name]

    def prop(self, window, name, kind):
        result = window.get_property(self.atom(name), kind, 0, 4097)
        return result.value if result is not None and not result.bytes_after else []

    def focus_is_within(self, active):
        focus = self.display.get_input_focus().focus
        for _ in range(32):
            if getattr(focus, "id", None) == active.id:
                return True
            if not getattr(focus, "id", 0) or focus.id == self.root.id:
                return False
            focus = focus.query_tree().parent
        return False

    def front(self):
        ids = self.prop(self.root, "_NET_ACTIVE_WINDOW", Xatom.WINDOW)
        if len(ids) != 1 or ids[0] in (0, self.root.id) or ids[0] not in self.prop(self.root, "_NET_CLIENT_LIST", Xatom.WINDOW):
            return None
        window = self.display.create_resource_object("window", int(ids[0]))
        attrs = window.get_attributes()
        if attrs.map_state != X.IsViewable or attrs.win_class != X.InputOutput or attrs.override_redirect or not self.focus_is_within(window):
            return None
        types = self.prop(window, "_NET_WM_WINDOW_TYPE", Xatom.ATOM)
        if types and any(t != self.atom("_NET_WM_WINDOW_TYPE_NORMAL") for t in types):
            return None
        app_class = window.get_wm_class()
        pid = self.prop(window, "_NET_WM_PID", Xatom.CARDINAL)
        caption = self.prop(window, "_NET_WM_NAME", self.atom("UTF8_STRING"))
        if not app_class or len(pid) != 1 or pid[0] == os.getpid() or not isinstance(caption, bytes) or len(caption) > 4096:
            return None
        title = re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", caption.decode("utf-8", "strict")).strip()
        app = app_class[-1].strip()
        if (not app or len(app) > 128 or not title or self.sensitive.search(" ".join((*app_class, title))) or
                self.own_page.search(title) or any(re.fullmatch(r"FocusDesk(?:Capture|Recorder|Host|Hub)?", name, re.I) for name in app_class)):
            return None
        # An X client may omit or misstate a PID, particularly across remote X connections.
        if Path("/proc", str(pid[0])).stat().st_uid != os.getuid():
            return None
        geometry = window.get_geometry()
        if not (32 <= geometry.width <= 8192 and 32 <= geometry.height <= 8192 and geometry.width * geometry.height <= 18_000_000):
            return None
        return window, (window.id, int(pid[0]), app, title, geometry.width, geometry.height)

    def changed(self, target):
        self.display.sync()
        changed = False
        while self.display.pending_events():
            event = self.display.next_event()
            if event.type == X.PropertyNotify:
                if ((event.window.id == self.root.id and event.atom == self.atom("_NET_ACTIVE_WINDOW")) or
                        (event.window.id == target.id and event.atom in (self.atom("_NET_WM_NAME"), self.atom("_NET_WM_PID")))):
                    changed = True
            elif event.type in (X.FocusOut, X.DestroyNotify, X.UnmapNotify, X.ConfigureNotify) and event.window.id == target.id:
                changed = True
        return changed

    def pixels(self, window):
        # A compositor can redirect only the WM frame. Request the actual client subtree,
        # name that specific pixmap and free both the pixmap and our redirect after use.
        # Never call get_image on the root, overlay window, frame or screen.
        rejected = XErrors.CatchError()
        window.composite_redirect_window(composite.RedirectAutomatic, onerror=rejected)
        self.display.sync()
        if rejected.get_error():
            return None
        pixmap = None
        try:
            bad_name = XErrors.CatchError()
            pixmap = window.composite_name_window_pixmap(onerror=bad_name)
            self.display.sync()
            if bad_name.get_error():
                return None
            size = pixmap.get_geometry()
            if not (32 <= size.width <= 8192 and 32 <= size.height <= 8192 and size.width * size.height <= 18_000_000):
                return None
            formats = self.display.display.info.pixmap_formats
            if size.depth not in (24, 32) or not any(f.depth == size.depth and f.bits_per_pixel == 32 for f in formats):
                return None
            visual_id = window.get_attributes().visual
            visuals = (v for d in self.display.screen().allowed_depths for v in d.visuals if v.visual_id == visual_id)
            visual = next(visuals, None)
            if not visual or (visual.red_mask, visual.green_mask, visual.blue_mask) != (0xff0000, 0xff00, 0xff):
                return None
            raw = pixmap.get_image(0, 0, size.width, size.height, X.ZPixmap, 0xffffffff)
            order = "BGRX" if self.display.display.info.image_byte_order == X.LSBFirst else "XRGB"
            image = Image.frombytes("RGB", (size.width, size.height), raw.data, "raw", order)
            if all(low == high for low, high in image.getextrema()):
                return None
            image.thumbnail((1440, 1440))
            data = io.BytesIO()
            image.save(data, "JPEG", quality=72)
            if data.tell() <= 1_048_576:
                return "data:image/jpeg;base64," + base64.b64encode(data.getvalue()).decode("ascii")
        finally:
            if pixmap is not None:
                pixmap.free(onerror=XErrors.CatchError())
            window.composite_unredirect_window(composite.RedirectAutomatic, onerror=XErrors.CatchError())
            self.display.sync()

    def capture(self, lock):
        if not lock.unlocked():
            return None
        first = self.front()
        if not first:
            return None
        window, identity = first
        window.change_attributes(event_mask=X.PropertyChangeMask | X.FocusChangeMask | X.StructureNotifyMask)
        try:
            self.changed(window)  # Discard events before the start of this acquisition.
            current = self.front()
            if not current or current[1] != identity:
                return None
            image = self.pixels(window)
            current = self.front()
            if not image or not current or current[1] != identity or self.changed(window) or not lock.unlocked():
                return None
            wid, pid, app, title, _, _ = identity
            return dict(image=image, app=app, windowId=f"{pid}/{wid}", pageTitle=title)
        finally:
            window.change_attributes(event_mask=0, onerror=XErrors.CatchError())
            self.display.sync()


def available():
    if (os.environ.get("XDG_SESSION_TYPE") != "x11" or os.environ.get("WAYLAND_DISPLAY") or
            not re.fullmatch(r"(?:unix)?:\d+(?:\.\d+)?", os.environ.get("DISPLAY", ""))):
        raise NotAvailable("需要本机 X11 桌面。Wayland 或远程 X 显示暂不支持。")
    require_modules()
    lock = SessionLock()
    try:
        if not lock.unlocked():
            raise NotAvailable("请在已解锁的本机 X11 桌面上开启。")
    finally:
        lock.close()
    desktop = XDesktop()
    desktop.display.close()


def run_session():
    # Keep input and capture separate so the Stop button responds while an X/DBus request is in flight.
    root = tk.Tk(className="FocusDeskRecorder")
    root.title("FocusDesk 正在记录前台窗口")
    root.resizable(False, False)
    root.attributes("-topmost", True)
    root.geometry(f"+{max(0,root.winfo_screenwidth()-335)}+55")
    tk.Label(root, text="●  正在记录前台窗口", padx=12, pady=9).pack(side="left")
    stop = tk.Button(root, text="停止 / Stop", command=root.destroy)
    stop.pack(side="right", padx=8, pady=6)
    root.protocol("WM_DELETE_WINDOW", root.destroy)
    visibility = {"clear":False, "epoch":0}
    results = queue.Queue()
    busy = False

    def visibility_event(event):
        if event.widget is stop:
            clear = str(event.state) == "VisibilityUnobscured"
            if clear != visibility["clear"]:
                visibility.update(clear=clear, epoch=visibility["epoch"]+1)

    def allowed():
        return visibility["clear"] and stop.winfo_viewable() and root.state() == "normal"

    def capture(epoch):
        desktop = lock = None
        try:
            # Xlib and D-Bus connections belong to this worker only.
            lock = SessionLock()
            desktop = XDesktop()
            results.put((epoch, desktop.capture(lock), None))
        except (NotAvailable, dbus.DBusException, XErrors.ConnectionClosedError):
            results.put((epoch, None, "无法继续核验 X11 桌面或锁屏状态，录制已停止。"))
        except (XErrors.XError, OSError, ValueError):
            results.put((epoch, None, None))
        except Exception:
            results.put((epoch, None, "X11 窗口采集失败，录制已停止。"))
        finally:
            if desktop is not None:
                desktop.display.close()
            if lock is not None:
                lock.close()

    def command(file, mask):
        nonlocal busy
        line = file.readline()
        if line != "capture\n":
            root.destroy()
        elif busy or not allowed():
            emit(type="frame",frame=None)
        else:
            busy = True
            threading.Thread(target=capture, args=(visibility["epoch"],), daemon=True).start()

    def poll():
        nonlocal busy
        try:
            epoch, frame, issue = results.get_nowait()
            busy = False
            if issue:
                emit(type="error", message=issue)
                root.destroy()
                return
            emit(type="frame", frame=frame if allowed() and epoch == visibility["epoch"] else None)
        except queue.Empty:
            pass
        root.after(40,poll)

    def announce():
        if not allowed():
            emit(type="error",message="X11 无法验证停止录制按钮可见。")
            root.destroy()
            return
        root.createfilehandler(sys.stdin, tk.READABLE, command)
        emit(type="ready")
        poll()

    stop.bind("<Visibility>",visibility_event)
    root.after(500,announce)
    root.mainloop()
    emit(type="stopped")


def main():
    probe = sys.argv[1:] == ["probe"]
    try:
        available()  # Does not create a Tk window or read any pixels.
        if probe:
            emit(supported=True,message="X11 独立窗口采集可用，录制期间显示可停止的置顶窗口。")
        elif sys.argv[1:] == ["session"]:
            run_session()
    except Exception as issue:
        message = str(issue) if isinstance(issue, NotAvailable) else "无法验证 X11 窗口、桌面锁或显示连接。"
        emit(**({"supported":False,"message":message} if probe else {"type":"error","message":message}))


if __name__ == "__main__":
    main()
