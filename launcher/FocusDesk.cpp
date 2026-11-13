#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <commdlg.h>
#include <string>
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cwctype>

namespace {
constexpr UINT PIPE_LINE = WM_APP + 1, PIPE_END = WM_APP + 2, TRAY = WM_APP + 3, COMMAND = WM_APP + 10;
constexpr UINT DASHBOARD = 101, CONNECT = 102, LOGS = 103, IMPORT = 104, NETWORK = 105, EXIT_APP = 106;
HWND windowHandle{}; HANDLE job{}, host{}, inputPipe{}, instanceMutex{};
NOTIFYICONDATAW tray{}; std::wstring root, userRoot, windowClass;
bool quitting = false, ready = false, testMode = false; unsigned port = 8787; int resultCode = 0;
HANDLE reader{};

std::wstring widen(const std::string& value) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out(n, 0); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), out.data(), n); return out;
}
std::string utf8(const std::wstring& value) {
  int n = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, 0); WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), n, nullptr, nullptr); return out;
}
std::wstring parent(const std::wstring& value) { return value.substr(0, value.find_last_of(L"\\/")); }
std::wstring quote(const std::wstring& value) {
  std::wstring out = L"\""; unsigned slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    if (c == L'"') { out.append(slashes * 2 + 1, L'\\'); out += c; }
    else { out.append(slashes, L'\\'); out += c; }
    slashes = 0;
  }
  out.append(slashes * 2, L'\\'); return out + L'"';
}
void logEvent(const char* event) {
  const auto directory = userRoot + L"\\logs";
  SHCreateDirectoryExW(nullptr, directory.c_str(), nullptr);
  const auto file = directory + L"\\launcher.log";
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &info) && (info.nFileSizeHigh || info.nFileSizeLow > 128 * 1024)) {
    DeleteFileW((file + L".3").c_str());
    MoveFileExW((file + L".2").c_str(), (file + L".3").c_str(), MOVEFILE_REPLACE_EXISTING);
    MoveFileExW((file + L".1").c_str(), (file + L".2").c_str(), MOVEFILE_REPLACE_EXISTING);
    MoveFileExW(file.c_str(), (file + L".1").c_str(), MOVEFILE_REPLACE_EXISTING);
  }
  FILE* output = _wfopen(file.c_str(), L"ab");
  if (!output) return;
  SYSTEMTIME time{}; GetSystemTime(&time);
  std::fprintf(output, "%04u-%02u-%02uT%02u:%02u:%02uZ %s\n", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, event);
  std::fclose(output);
}
void testState(const char* phase) {
  if (!testMode) return;
  FILE* out = _wfopen((userRoot + L"\\logs\\test-state.json").c_str(), L"wb");
  if (out) { std::fprintf(out, "{\"pid\":%lu,\"phase\":\"%s\",\"port\":%u}", GetCurrentProcessId(), phase, port); std::fclose(out); }
}
void tell(const std::wstring& text, bool error = false) {
  if (!testMode) MessageBoxW(windowHandle, text.c_str(), L"FocusDesk", MB_OK | (error ? MB_ICONERROR : MB_ICONINFORMATION));
}
std::wstring explanation(const std::string& code) {
  if (code == "PORT_IN_USE") return L"FocusDesk 的端口已被占用。请先检查是否有旧版 FocusDesk 正在运行，或在设置文件中调整端口。不会终止占用端口的其他程序。";
  if (code == "DATA_LOCKED") return L"这份任务数据正由另一个 FocusDesk 服务使用。请先退出旧实例再启动。";
  if (code == "USER_DATA_UNAVAILABLE") return L"无法访问用户数据目录或程序文件不完整。请确认当前用户有写入权限，或重新安装 FocusDesk。现有任务不会被重置。";
  if (code == "STARTUP_TIMEOUT") return L"FocusDesk 启动超时。请打开日志目录检查，然后重新启动。";
  if (code == "DATA_INVALID") return L"任务数据暂时无法读取，或 Dashboard 文件缺失。请检查日志和数据备份；程序不会用演示任务覆盖原数据。";
  if (code == "CONFIG_INVALID" || code == "INVALID_BINDING") return L"FocusDesk 的配置无效。请将 host 设置为 0.0.0.0，并使用有效端口，再重新启动。";
  if (code.rfind("RUNTIME", 0) == 0) return L"FocusDesk 内置运行环境缺失或版本不符。请重新安装完整的 FocusDesk 安装包。";
  return L"FocusDesk 后台服务发生错误。请查看日志后重新启动。错误代码：" + widen(code);
}
void send(const std::string& line) {
  if (!inputPipe) return;
  const auto body = line + "\n"; DWORD written{};
  WriteFile(inputPipe, body.data(), static_cast<DWORD>(body.size()), &written, nullptr);
}
void openUrl(const wchar_t* suffix) {
  if (!ready) { tell(L"FocusDesk 正在启动，或后台服务尚未就绪。"); return; }
  logEvent(suffix[0] ? "OPEN_CONNECTION" : "OPEN_DASHBOARD");
  if (!testMode) {
    const auto url = L"http://127.0.0.1:" + std::to_wstring(port) + L"/" + suffix;
    if (reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) tell(L"无法自动打开浏览器。请检查默认浏览器设置。", true);
  }
}
void stopHost() {
  if (quitting) return; quitting = true; KillTimer(windowHandle, 1); logEvent("EXIT_REQUESTED");
  send("STOP");
  if (host && WaitForSingleObject(host, 12000) == WAIT_TIMEOUT) { logEvent("STOP_TIMEOUT"); if (job) TerminateJobObject(job, 1); WaitForSingleObject(host, 3000); }
  if (job) { CloseHandle(job); job = nullptr; }
  if (inputPipe) { CloseHandle(inputPipe); inputPipe = nullptr; }
  if (reader) { WaitForSingleObject(reader, INFINITE); CloseHandle(reader); reader = nullptr; }
  testState("stopped"); logEvent("APPLICATION_STOPPED"); Shell_NotifyIconW(NIM_DELETE, &tray);
  DestroyWindow(windowHandle);
}
void chooseImport() {
  if (!ready) { tell(L"请等待 FocusDesk 启动完成。"); return; }
  wchar_t filename[32768]{};
  OPENFILENAMEW dialog{}; dialog.lStructSize = sizeof(dialog); dialog.hwndOwner = windowHandle;
  dialog.lpstrFilter = L"FocusDesk 任务文件 (*.json)\0*.json\0所有文件\0*.*\0";
  dialog.lpstrFile = filename; dialog.nMaxFile = 32768; dialog.lpstrTitle = L"选择原 FocusDesk-LAN 的 tasks.json";
  dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
  if (GetOpenFileNameW(&dialog)) send("IMPORT\t" + utf8(filename));
}
void perform(UINT action) {
  if (action == DASHBOARD) openUrl(L"");
  else if (action == CONNECT) openUrl(L"connect");
  else if (action == LOGS) { logEvent("OPEN_LOGS"); if (!testMode) ShellExecuteW(nullptr, L"open", (userRoot + L"\\logs").c_str(), nullptr, nullptr, SW_SHOWNORMAL); }
  else if (action == IMPORT) chooseImport();
  else if (action == NETWORK) { logEvent("NETWORK_CHECK_REQUESTED"); send("NETWORK"); }
  else if (action == EXIT_APP) stopHost();
}
void onLine(const std::string& line) {
  if (line.rfind("READY|", 0) == 0) {
    const auto value = line.substr(6);
    if (value.empty() || value.find_first_not_of("0123456789") != std::string::npos) return;
    unsigned long number = std::strtoul(value.c_str(), nullptr, 10); if (!number || number > 65535) return;
    port = static_cast<unsigned>(number); ready = true; KillTimer(windowHandle, 1);
    logEvent("BACKEND_READY"); testState("ready"); openUrl(L"");
  } else if (line.rfind("ERROR|", 0) == 0) {
    resultCode = 1; logEvent("HOST_ERROR"); tell(explanation(line.substr(6)), true); stopHost();
  } else if (line.rfind("IMPORT_CONFIRM|", 0) == 0) {
    logEvent("IMPORT_CONFIRM");
    const auto text = L"文件已通过校验。导入将替换当前任务和专注状态，并先备份现有数据。原文件保持不变。\n\n确定导入吗？";
    if (!testMode && MessageBoxW(windowHandle, text, L"导入旧任务", MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) == IDYES) send("IMPORT_COMMIT");
    else send("IMPORT_CANCEL");
  } else if (line.rfind("IMPORT_RESULT|", 0) == 0) {
    const auto code = line.substr(14); logEvent(code == "OK" ? "IMPORT_OK" : "IMPORT_FAILED");
    if (code == "OK") tell(L"导入成功，原有数据已备份。刷新 Dashboard 即可查看。电子纸会按原有同步间隔更新。");
    else if (code == "IMPORT_TIMEOUT" || code == "IMPORT_BACKEND_UNAVAILABLE" || code == "IMPORT_UNAVAILABLE")
      tell(L"导入结果尚未确认，可能已经保存。请先刷新 Dashboard 并检查备份，再决定是否重新导入。\n错误代码：" + widen(code), true);
    else if (code != "IMPORT_CANCELLED") tell(L"导入请求未成功。请检查文件格式；如果任务已发生变化，请核对最新任务后重新选择文件。\n错误代码：" + widen(code), true);
  } else if (line.rfind("NETWORK|", 0) == 0) {
    logEvent("NETWORK_CHECK_COMPLETED");
    std::wstring summary = L"暂时无法自动读取 Windows 防火墙状态。";
    if (line.find("|ENABLED|") != std::string::npos) summary = L"Windows 防火墙已启用。";
    else if (line.find("|DISABLED|") != std::string::npos) summary = L"Windows 专用网络防火墙当前未启用；FocusDesk 没有更改此设置。";
    if (line.find("|PRIVATE|") != std::string::npos) summary += L"\n当前有专用网络连接。";
    else if (line.find("|OTHER|") != std::string::npos) summary += L"\n未检测到专用网络，请确认正在使用的网络是否可信。";
    if (line.find("ALLOW_RULE_FOUND") != std::string::npos) summary += L"\n找到了内置运行时的专用网络允许规则。";
    else summary += L"\n尚未确认内置运行时的专用网络访问许可。";
    tell(summary + L"\n\n可按 Windows 提示允许 FocusDesk 访问专用网络，或从同一局域网另一设备打开连接页地址检查。诊断不等于设备已连通，程序不会关闭或自动放宽防火墙。");
  }
}
LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == PIPE_LINE) { auto* line = reinterpret_cast<std::string*>(lParam); if (!quitting) onLine(*line); delete line; return 0; }
  if (message == PIPE_END) { if (!quitting) { logEvent("HOST_UNEXPECTED_EXIT"); resultCode = 1; tell(L"FocusDesk 后台服务已停止，请查看日志后重新启动。", true); stopHost(); } return 0; }
  if (message == COMMAND) { perform(static_cast<UINT>(wParam)); return 0; }
  if (message == WM_TIMER) { resultCode = 1; tell(explanation("STARTUP_TIMEOUT"), true); stopHost(); return 0; }
  if (message == TRAY) {
    if (lParam == WM_LBUTTONDBLCLK) perform(DASHBOARD);
    if (lParam == WM_RBUTTONUP || lParam == WM_CONTEXTMENU) {
      HMENU menu = CreatePopupMenu();
      AppendMenuW(menu, MF_STRING, DASHBOARD, L"打开 Dashboard"); AppendMenuW(menu, MF_STRING, CONNECT, L"设备连接");
      AppendMenuW(menu, MF_STRING, IMPORT, L"导入旧任务…"); AppendMenuW(menu, MF_STRING, LOGS, L"打开日志目录");
      AppendMenuW(menu, MF_STRING, NETWORK, L"检查专用网络访问"); AppendMenuW(menu, MF_SEPARATOR, 0, nullptr); AppendMenuW(menu, MF_STRING, EXIT_APP, L"退出 FocusDesk");
      POINT cursor{}; GetCursorPos(&cursor); SetForegroundWindow(hwnd);
      UINT selected = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, hwnd, nullptr); DestroyMenu(menu); if (selected) perform(selected);
    } return 0;
  }
  if (message == WM_QUERYENDSESSION) { send("STOP"); return TRUE; }
  if (message == WM_ENDSESSION && wParam) { stopHost(); return 0; }
  if (message == WM_CLOSE) { stopHost(); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  if (message == RegisterWindowMessageW(L"TaskbarCreated")) {
    if (!quitting && !Shell_NotifyIconW(NIM_ADD, &tray)) { logEvent("TRAY_UNAVAILABLE"); resultCode = 1; tell(L"无法恢复 FocusDesk 托盘入口，应用将安全退出。", true); stopHost(); }
    return 0;
  }
  return DefWindowProcW(hwnd, message, wParam, lParam);
}
bool startHost() {
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE childInput{}, childOutput{}, outputPipe{};
  if (!CreatePipe(&childInput, &inputPipe, &security, 0)) return false;
  SetHandleInformation(inputPipe, HANDLE_FLAG_INHERIT, 0);
  if (!CreatePipe(&outputPipe, &childOutput, &security, 0)) { CloseHandle(childInput); return false; }
  SetHandleInformation(outputPipe, HANDLE_FLAG_INHERIT, 0);
  job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit))) { CloseHandle(childInput); CloseHandle(childOutput); CloseHandle(outputPipe); return false; }
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
  startup.hStdInput = childInput; startup.hStdOutput = childOutput; startup.hStdError = childOutput;
  PROCESS_INFORMATION process{};
  const auto runtime = root + L"\\runtime\\node.exe";
  auto command = quote(runtime) + L" " + quote(root + L"\\scripts\\desktop-host.mjs") + L" --user-data-dir " + quote(userRoot);
  SetEnvironmentVariableW(L"NODE_OPTIONS", nullptr); SetEnvironmentVariableW(L"NODE_PATH", nullptr);
  bool created = CreateProcessW(runtime.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, root.c_str(), &startup, &process);
  CloseHandle(childInput); CloseHandle(childOutput);
  if (!created) { CloseHandle(outputPipe); return false; }
  if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 1); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(outputPipe); return false; }
  host = process.hProcess; ResumeThread(process.hThread); CloseHandle(process.hThread);
  reader = CreateThread(nullptr, 0, [](LPVOID parameter) -> DWORD {
    const auto outputPipe = static_cast<HANDLE>(parameter);
    char buffer[1024]; DWORD count{}; std::string pending;
    while (ReadFile(outputPipe, buffer, sizeof(buffer), &count, nullptr) && count) {
      pending.append(buffer, count); size_t end;
      while ((end = pending.find('\n')) != std::string::npos) {
        auto line = pending.substr(0, end); pending.erase(0, end + 1); if (!line.empty() && line.back() == '\r') line.pop_back();
        auto* copy = new std::string(line); if (!PostMessageW(windowHandle, PIPE_LINE, 0, reinterpret_cast<LPARAM>(copy))) delete copy;
      }
      if (pending.size() > 8192) pending.clear();
    }
    CloseHandle(outputPipe); PostMessageW(windowHandle, PIPE_END, 0, 0);
    return 0;
  }, outputPipe, 0, nullptr);
  if (!reader) { CloseHandle(outputPipe); TerminateJobObject(job, 1); return false; }
  return true;
}
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  int argc{}; auto argv = CommandLineToArgvW(GetCommandLineW(), &argc); if (!argv) return 1;
  wchar_t module[32768]{}; GetModuleFileNameW(nullptr, module, 32768); root = parent(parent(module));
  wchar_t local[32768]{}; GetEnvironmentVariableW(L"LOCALAPPDATA", local, 32768); userRoot = std::wstring(local) + L"\\FocusDesk";
  bool shutdown = false; UINT command = DASHBOARD; bool commandOnly = false;
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg(argv[i]);
    if (arg == L"--user-data-dir" && i + 1 < argc) userRoot = argv[++i];
    else if (arg == L"--test-mode") testMode = true;
    else if (arg == L"--shutdown") shutdown = true;
    else if (arg == L"--command" && i + 1 < argc) {
      commandOnly = true; const std::wstring name(argv[++i]);
      command = name == L"connect" ? CONNECT : name == L"logs" ? LOGS : name == L"network" ? NETWORK : name == L"exit" ? EXIT_APP : DASHBOARD;
    }
  }
  LocalFree(argv);
  wchar_t canonical[32768]{}; if (!GetFullPathNameW(userRoot.c_str(), 32768, canonical, nullptr)) return 1; userRoot = canonical;
  auto key = userRoot; for (auto& c : key) c = static_cast<wchar_t>(std::towlower(c));
  unsigned long long hash = 1469598103934665603ULL; for (auto c : key) { hash ^= static_cast<unsigned>(c); hash *= 1099511628211ULL; }
  windowClass = L"FocusDesk.M1." + std::to_wstring(hash); const auto mutexName = L"Local\\" + windowClass;
  if (shutdown || commandOnly) {
    auto existing = FindWindowW(windowClass.c_str(), nullptr);
    if (!existing) {
      HANDLE starting = OpenMutexW(SYNCHRONIZE, FALSE, mutexName.c_str());
      if (!starting) return 0;
      for (int i = 0; i < 30 && !existing; ++i) { Sleep(100); existing = FindWindowW(windowClass.c_str(), nullptr); }
      CloseHandle(starting); if (!existing) return 1;
    }
    DWORD pid{}; GetWindowThreadProcessId(existing, &pid); HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if ((shutdown || command == EXIT_APP) && !process) return 1;
    DWORD_PTR sent{};
    bool ok = SendMessageTimeoutW(existing, COMMAND, shutdown ? EXIT_APP : command, 0, SMTO_ABORTIFHUNG, 18000, &sent) != 0;
    if ((shutdown || command == EXIT_APP) && process) ok = WaitForSingleObject(process, 18000) == WAIT_OBJECT_0;
    if (process) CloseHandle(process); return ok ? 0 : 1;
  }
  instanceMutex = CreateMutexW(nullptr, TRUE, mutexName.c_str());
  if (!instanceMutex) return 1;
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND existing{}; for (int i = 0; i < 30 && !existing; ++i) { existing = FindWindowW(windowClass.c_str(), nullptr); if (!existing) Sleep(100); }
    if (existing) PostMessageW(existing, COMMAND, DASHBOARD, 0);
    CloseHandle(instanceMutex); return existing ? 0 : 1;
  }
  WNDCLASSW klass{}; klass.lpfnWndProc = procedure; klass.hInstance = instance; klass.lpszClassName = windowClass.c_str();
  if (!RegisterClassW(&klass)) return 1;
  windowHandle = CreateWindowExW(0, windowClass.c_str(), L"FocusDesk", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
  if (!windowHandle) return 1;
  tray.cbSize = sizeof(tray); tray.hWnd = windowHandle; tray.uID = 1; tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  tray.uCallbackMessage = TRAY; tray.hIcon = LoadIconW(nullptr, IDI_APPLICATION); lstrcpynW(tray.szTip, L"FocusDesk — 右键打开菜单", 128);
  if (!Shell_NotifyIconW(NIM_ADD, &tray)) {
    logEvent("TRAY_UNAVAILABLE"); tell(L"无法创建 FocusDesk 托盘图标，因此没有启动后台服务。请检查 Windows 通知区域后重新启动。", true);
    DestroyWindow(windowHandle); ReleaseMutex(instanceMutex); CloseHandle(instanceMutex); return 1;
  }
  logEvent("APPLICATION_START"); testState("starting");
  if (!startHost()) { resultCode = 1; logEvent("HOST_START_FAILED"); tell(explanation("RUNTIME_MISSING"), true); stopHost(); }
  else SetTimer(windowHandle, 1, 30000, nullptr);
  MSG message{}; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  if (host) CloseHandle(host);
  ReleaseMutex(instanceMutex); CloseHandle(instanceMutex); return resultCode;
}
