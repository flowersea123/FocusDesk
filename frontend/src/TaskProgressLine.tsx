import type { ProjectStatus } from '../../contracts/project-progress';

function minuteLabel(minute: number) {
  const hours = Math.floor(minute / 60).toString().padStart(2, '0');
  return hours + ':' + (minute % 60).toString().padStart(2, '0');
}

function PaperVisitStrip({ visits }: { visits: NonNullable<ProjectStatus['paperVisits']> }) {
  const minutes = visits.minutes;
  const start = Math.floor(minutes[0] / 60) * 60;
  const end = (Math.floor(minutes[minutes.length - 1] / 60) + 1) * 60;
  return <div>
    <div className="task-progress-caption"><span>论文访问 · {visits.documents} 个标题</span><span>页码未知</span></div>
    <div className="paper-visit-ticks" role="img"
      aria-label={`${visits.date} 论文窗口采样，${minuteLabel(minutes[0])} 至 ${minuteLabel(minutes[minutes.length - 1])} 有 ${visits.count} 次记录`}>
      {minutes.map(minute => <i key={minute} title={minuteLabel(minute)} aria-hidden="true"
        style={{ left: `${100 * (minute - start) / (end - start)}%` }} />)}
    </div>
    <div className="paper-visit-axis" aria-hidden="true"><span>{minuteLabel(start)}</span><span>{minuteLabel(end)}</span></div>
  </div>;
}

function TaskMeter({ title, label, value, detail }: { title:string; label:string; value:number; detail:string }) {
  return <div>
    <div className="task-progress-caption"><span>{label}</span><strong>{detail}</strong></div>
    <progress aria-label={title + ' · ' + label} aria-valuetext={detail} value={value} max={100} />
  </div>;
}

export default function TaskProgressLine({ status }: { status: ProjectStatus }) {
  const { title, readingPosition, readingBookmark, percent, paperVisits } = status;
  if (!readingPosition && !readingBookmark && percent === null && !paperVisits?.minutes.length) return null;
  return <div className="task-progress-line">
    {readingPosition ? <TaskMeter title={title} label="阅读位置" value={Math.round(100 * readingPosition.page / readingPosition.total)}
      detail={`第 ${readingPosition.page} / ${readingPosition.total} 页`} /> :
      !!paperVisits?.minutes.length && <PaperVisitStrip visits={paperVisits} />}
    {!readingPosition && readingBookmark && <span>读到 {readingBookmark.current.section}</span>}
    {percent !== null && <TaskMeter title={title} label="任务完成度" value={percent}
      detail={status.total !== null ? `${status.completed.length} / ${status.total} 步` : `${percent}%`} />}
  </div>;
}
