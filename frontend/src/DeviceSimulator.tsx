import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplaySnapshot } from '../../contracts/display-snapshot';
import { paintDisplaySnapshot } from './simulator/canvas';
import { SNAPSHOT_ENDPOINT } from './simulator/client';
import { guardRemaining, hasPendingFrame } from './simulator/state';
import { useSimulator, type SnapshotReader } from './simulator/use-simulator';
import './device-simulator.css';

function timeLabel(time: number | null): string {
  return time === null ? '尚无记录' : new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
}

export default function DeviceSimulator({ readSnapshot }: { readSnapshot?: SnapshotReader }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [now, setNow] = useState(Date.now);
  const [exportError, setExportError] = useState<string | null>(null);
  const paint = useCallback((snapshot: DisplaySnapshot) => {
    if (!canvas.current) throw new Error('模拟屏尚未准备完成。');
    paintDisplaySnapshot(canvas.current, snapshot);
  }, []);
  const { state, busy, poll, setMode, setOnline } = useSimulator(paint, readSnapshot);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pending = hasPendingFrame(state);
  const guard = Math.ceil(guardRemaining(state, now) / 1000);
  const nextRead = Math.max(0, Math.ceil((state.nextPollAt - now) / 1000));
  const status = !state.online ? '模拟断网 · 保留画面' : state.error ? '同步遇到问题' : busy ? '正在读取 Hub…' :
    pending ? '已读取新版本 · 等待刷新' : state.result === 'unchanged' ? '版本未变 · 无需刷新' :
      state.displayed ? '已在浏览器绘制' : '等待首次读取';
  const transcript = state.displayed?.commands.filter(command => command[0] === 1).map(command => command[5]).join(' ') ?? '';

  function exportPng() {
    if (!canvas.current || !state.displayed) return;
    try {
      const link = document.createElement('a');
      link.href = canvas.current.toDataURL('image/png');
      link.download = `FocusDesk-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      document.body.appendChild(link); link.click(); link.remove(); setExportError(null);
    } catch { setExportError('PNG 导出失败，请重试或更换浏览器。'); }
  }

  return <div className="app-shell simulator-shell">
    <header className="topbar"><a className="brand" href="/">FocusDesk</a>
      <nav aria-label="Main navigation"><a href="/">任务面板</a><a className="nav-current" href="/simulator">模拟屏</a><a href="/connect">设备连接</a></nav>
      <span className="source-badge">本机开发</span></header>
    <main className="simulator-main">
      <div className="page-heading"><div><p className="eyebrow">DEVICE SIMULATOR</p><h1>电子纸模拟屏</h1></div>
        <a className="simulator-editor-link" href="/" target="_blank" rel="noreferrer">另开任务面板 ↗</a></div>
      <p className="simulator-intro">在任务面板保存修改，这里会读取 Hub 发给设备的绘图指令，使用同一套字形绘制 400 × 300 像素画面。</p>
      <div className="simulator-notice">这里的成功只代表浏览器已绘制，不是电子纸真机的在线状态或同步回执。</div>

      <section className="simulator-controls" aria-label="模拟设置">
        <fieldset className="simulator-modes"><legend>更新节奏</legend><div className="simulator-segmented">
          <button type="button" aria-pressed={state.mode === 'fast'} onClick={() => setMode('fast')}>快速检查</button>
          <button type="button" aria-pressed={state.mode === 'device'} onClick={() => setMode('device')}>设备节奏</button>
        </div><p>{state.mode === 'fast' ? '约每 1 秒读取，无 60 秒刷新保护。用于检查修改，不代表设备时序。' :
          '正常每 30 秒读取；两次刷新尝试完成之间至少 60 秒。失败后逐步延长读取间隔。'}</p></fieldset>
        <div className="simulator-actions">
          <button type="button" className="primary-button" onClick={() => void poll()} disabled={busy || !state.online}>{busy ? '正在读取…' : '立即读取'}</button>
          <button type="button" className="secondary-button" aria-pressed={!state.online} onClick={() => setOnline(!state.online)}>{state.online ? '模拟断网' : '恢复网络'}</button>
        </div>
      </section>

      <section className="simulator-screen-card" aria-labelledby="simulator-screen-title">
        <div className="section-heading simulator-screen-heading"><h2 id="simulator-screen-title">设备指令画面</h2>
          <div className="simulator-view-actions"><div className="simulator-segmented" role="group" aria-label="显示倍率">
            <button type="button" aria-pressed={scale === 1} onClick={() => setScale(1)}>1×</button>
            <button type="button" aria-pressed={scale === 2} onClick={() => setScale(2)}>2×</button></div>
            <button type="button" className="secondary-button" onClick={exportPng} disabled={!state.displayed}>导出 PNG</button></div></div>
        <div className="simulator-canvas-scroll"><div className="simulator-canvas-frame" style={{ width: 400 * scale, height: 300 * scale }}>
          <canvas ref={canvas} width={400} height={300} role="img" aria-label="400 × 300 设备指令模拟屏" aria-describedby="simulator-transcript"
            data-displayed-revision={state.displayed?.revision ?? ''} style={{ width: 400 * scale, height: 300 * scale }} />
          {!state.displayed && <div className="simulator-canvas-empty">尚未收到可显示的设备数据</div>}
        </div></div>
        <p id="simulator-transcript" className="sr-only">{transcript || '暂无已绘制内容'}</p>
        <div className="simulator-status" role="status"><span className={!state.online || state.error ? 'simulator-status-dot is-paused' : 'simulator-status-dot'} /><strong>{status}</strong></div>
        {state.online && pending && state.mode === 'device' && <p className="simulator-wait">{guard > 0 ? `刷新保护还需约 ${guard} 秒；之后等待下一次成功读取。` : '刷新保护已结束，等待下一次成功读取。'} 立即读取也不会绕过保护。</p>}
        {!state.online && <p className="simulator-wait">已暂停读取。恢复网络后重新获取最新版本，保留已有刷新保护。</p>}
        {state.error && <p className="simulator-error" role="alert">{state.error} {state.displayed ? '保留上次已绘制画面。' : '暂无可显示画面。'}</p>}
        {exportError && <p className="simulator-error" role="alert">{exportError}</p>}
        <div className="simulator-read-times"><span>最近成功读取：{timeLabel(state.receivedAt)}</span><span>最近成功绘制：{timeLabel(state.displayedAt)}</span>
          <span>{!state.online ? '自动读取已暂停' : busy ? '正在请求新数据' : `下次自动读取约 ${nextRead} 秒后`}</span></div>
      </section>

      <details className="simulator-details"><summary>连接与验证详情</summary>
        <dl><div><dt>读取地址</dt><dd><code>{window.location.origin}{SNAPSHOT_ENDPOINT}</code></dd></div>
          <div><dt>最近读取版本</dt><dd><code>{state.received?.revision ?? '尚未读取'}</code></dd></div>
          <div><dt>当前已绘制版本</dt><dd><code>{state.displayed?.revision ?? '尚未绘制'}</code></dd></div>
          <div><dt>连续失败次数</dt><dd>{state.failures}</dd></div></dl>
        <p>协议、尺寸、指令、字形边界与 4 KiB 内容上限按设备规则校验。错误响应不会清空画面。设备节奏下，失败重试间隔为 30、60、120、240、300 秒；合法但尚不能刷新的新版本等待后续成功读取。</p>
        <p>模拟器不复现物理屏幕的全刷耗时、闪烁、BUSY 信号、供电或 Wi-Fi 射频行为。浏览器在后台时也可能降低更新频率。PNG 始终导出原始 400 × 300 像素。</p>
      </details>
    </main>
  </div>;
}
