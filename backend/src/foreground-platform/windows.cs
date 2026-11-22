// This desktop helper draws its own persistent Stop button. PrintWindow asks
// the selected HWND to paint into an in-memory bitmap, without sampling a monitor.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class Recorder : Form {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    delegate void EventHook(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr target, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder value, int length, out int needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, EventHook callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1500000 };
    static readonly object Output = new object();
    static Regex sensitive, ownPage;
    static int ourSession;
    readonly Button stop = new Button();
    IntPtr windowHandle, stopHandle, hook;
    EventHook onForeground;
    int changed, busy;
    volatile bool ended;

    static void Emit(object message) {
        lock (Output) {
            try { Console.WriteLine(Json.Serialize(message)); Console.Out.Flush(); }
            catch (IOException) { Environment.Exit(0); }
        }
    }
    static bool UnlockedDesktop() {
        if (!Environment.UserInteractive || ourSession != WTSGetActiveConsoleSessionId()) return false;
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
        if (desktop == IntPtr.Zero) return false;
        try {
            StringBuilder name = new StringBuilder(256);
            int needed;
            return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) &&
                String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }
    bool IndicatorVisible() {
        Rect area;
        if (!IsWindowVisible(windowHandle) || IsIconic(windowHandle) || !GetWindowRect(stopHandle, out area)) return false;
        Point center = new Point((area.left + area.right)/2, (area.top + area.bottom)/2);
        return GetAncestor(WindowFromPoint(center), 2) == windowHandle;
    }
    class Target {
        public IntPtr handle;
        public uint pid;
        public string app, title;
        public int width, height;
        public bool Matches(Target b) {
            return b != null && handle == b.handle && pid == b.pid && app == b.app && title == b.title && width == b.width && height == b.height;
        }
    }
    Target Front() {
        if (ended || !IndicatorVisible() || !UnlockedDesktop()) return null;
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero || h == windowHandle || h == GetDesktopWindow() || h == GetShellWindow() ||
            h != GetAncestor(h,2) || !IsWindowVisible(h) || IsIconic(h)) return null;
        int cloaked;
        if (DwmGetWindowAttribute(h,14,out cloaked,4) != 0 || cloaked != 0) return null;
        uint affinity;
        bool affinityKnown = GetWindowDisplayAffinity(h,out affinity);
        if (affinityKnown ? affinity != 0 : (GetWindowLong(h,-20) & 0x00080000) != 0) return null;
        uint pid;
        if (GetWindowThreadProcessId(h,out pid) == 0 || pid == 0) return null;
        StringBuilder className = new StringBuilder(256), title = new StringBuilder(4097);
        if (GetClassName(h,className,className.Capacity) == 0 || GetWindowText(h,title,title.Capacity) == 0 || title.Length >= 4096) return null;
        if (Regex.IsMatch(className.ToString(), "^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$")) return null;
        using (Process process = Process.GetProcessById((int)pid)) {
            string app = process.ProcessName;
            string caption = Regex.Replace(title.ToString(), @"[\p{Cc}\p{Zl}\p{Zp}]", " ").Trim();
            if (process.SessionId != ourSession || caption.Length == 0 || sensitive.IsMatch(app+" "+className+" "+caption) ||
                ownPage.IsMatch(caption) || Regex.IsMatch(app,"^FocusDesk(?:Capture|Recorder|Host|Hub)?$",RegexOptions.IgnoreCase)) return null;
            Rect client;
            if (!GetClientRect(h,out client) || client.right < 32 || client.bottom < 32 ||
                client.right > 8192 || client.bottom > 8192 || (long)client.right * client.bottom > 18000000L) return null;
            return new Target {handle=h,pid=pid,app=app,title=caption,width=client.right,height=client.bottom};
        }
    }
    object CaptureFrame() {
        int epoch = Volatile.Read(ref changed);
        Target first = Front();
        if (first == null) return null;
        using (Bitmap raw = new Bitmap(first.width, first.height, PixelFormat.Format24bppRgb)) {
            using (Graphics surface = Graphics.FromImage(raw)) {
                surface.Clear(Color.Black);
                IntPtr dc = surface.GetHdc();
                bool success;
                try { success = PrintWindow(first.handle,dc,3); } // CLIENTONLY | RENDERFULLCONTENT
                finally { surface.ReleaseHdc(dc); }
                if (!success) return null;
            }
            if (epoch != Volatile.Read(ref changed) || !first.Matches(Front())) return null;
            double scale = Math.Min(1.0,1440.0/Math.Max(raw.Width,raw.Height));
            using (Bitmap resized = new Bitmap(Math.Max(1,(int)(raw.Width*scale)),Math.Max(1,(int)(raw.Height*scale)))) {
                using (Graphics g = Graphics.FromImage(resized)) {
                    g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                    g.DrawImage(raw,0,0,resized.Width,resized.Height);
                }
                // Some GPU and protected windows respond successfully with a blank surface.
                bool varied = false;
                int firstColor = resized.GetPixel(0,0).ToArgb();
                for (int y=0; y<resized.Height && !varied; y+=Math.Max(1,resized.Height/32))
                    for (int x=0; x<resized.Width && !varied; x+=Math.Max(1,resized.Width/32))
                        varied = resized.GetPixel(x,y).ToArgb() != firstColor;
                if (!varied) return null;
                ImageCodecInfo codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                using (MemoryStream bytes = new MemoryStream())
                using (EncoderParameters parameters = new EncoderParameters(1)) {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,72L);
                    resized.Save(bytes,codec,parameters);
                    if (bytes.Length > 1048576 || epoch != Volatile.Read(ref changed) || !first.Matches(Front())) return null;
                    return new {image="data:image/jpeg;base64,"+Convert.ToBase64String(bytes.ToArray()),
                        app=first.app,windowId=first.pid+"/"+first.handle.ToInt64(),pageTitle=first.title};
                }
            }
        }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    Recorder() {
        Text="FocusDesk 正在记录前台窗口"; TopMost=true; ShowInTaskbar=true;
        FormBorderStyle=FormBorderStyle.FixedToolWindow; MinimizeBox=false; MaximizeBox=false;
        StartPosition=FormStartPosition.Manual; ClientSize=new Size(300,54);
        Rectangle screen=Screen.PrimaryScreen.WorkingArea;
        Location=new Point(screen.Right-Width-16,screen.Bottom-Height-16);
        Label label=new Label {Text="●  正在记录前台窗口",AutoSize=true,Left=14,Top=18};
        stop.Text="停止 / Stop"; stop.SetBounds(203,10,86,34); stop.Click += delegate { Close(); };
        Controls.Add(label); Controls.Add(stop);
        Shown += delegate {
            windowHandle=Handle; stopHandle=stop.Handle;
            onForeground=delegate { Interlocked.Increment(ref changed); };
            hook=SetWinEventHook(3,3,IntPtr.Zero,onForeground,0,0,0); // EVENT_SYSTEM_FOREGROUND
            if (hook == IntPtr.Zero || !UnlockedDesktop() || !IndicatorVisible()) {
                Emit(new {type="error",message="当前 Windows 桌面未解锁，或停止录制窗口不可见。"}); Close(); return;
            }
            Emit(new {type="ready"});
            // Keep the Stop button and stdin EOF responsive if an application hangs inside PrintWindow.
            Thread reader=new Thread(delegate() {
                try {
                    string command;
                    while ((command=Console.ReadLine()) != null && command == "capture") {
                        if (Interlocked.CompareExchange(ref busy,1,0) != 0) continue;
                        ThreadPool.QueueUserWorkItem(delegate {
                            object frame=null;
                            try { frame=CaptureFrame(); } catch { /* A window may close at any point. */ }
                            Interlocked.Exchange(ref busy,0);
                            if (!ended) Emit(new {type="frame",frame=frame});
                        });
                    }
                    if (!ended) BeginInvoke((Action)Close);
                } catch { if (!ended) Environment.Exit(0); }
            });
            reader.IsBackground=true; reader.Start();
        };
        FormClosing += delegate { ended=true; if (hook!=IntPtr.Zero) UnhookWinEvent(hook); Emit(new {type="stopped"}); };
    }
    [STAThread] static void Main(string[] args) {
        try {
            Console.OutputEncoding=new UTF8Encoding(false);
            sensitive=new Regex(File.ReadAllText(args[0]).Trim(),RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);
            ownPage=new Regex(File.ReadAllText(Path.Combine(Path.GetDirectoryName(args[0]),"focusdesk-pages.txt")).Trim(),RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);
            using (Process current=Process.GetCurrentProcess()) {ourSession=current.SessionId;}
            if (!UnlockedDesktop()) { Emit(new {type="error",message="请从已解锁的 Windows 本机桌面启动录制。"}); return; }
            SetProcessDPIAware(); Application.EnableVisualStyles(); Application.Run(new Recorder());
        } catch { Emit(new {type="error",message="Windows 无法启动可见录制窗口。"}); }
    }
}
