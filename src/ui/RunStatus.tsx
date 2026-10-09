// How far the sandbox has got with a selection, and what the last run took.
import { useEffect, useState } from "react";
import type { RunProgress, RunStats } from "../shared/messages";
import { FrameIcon } from "./icons";

/** A run in progress, as the plugin window tracks it. */
export interface Run {
  startedAt: number;
  layers?: number;
  progress?: RunProgress;
}

/** Reading the layers is most of a run; generating the code is the last stretch. */
function percent(run: Run): number | null {
  const p = run.progress;
  if (!p) return null;
  if (p.phase === "generate") return 95;
  return p.total > 0 ? Math.round((p.done / p.total) * 90) : 0;
}

function describe(run: Run): string {
  const p = run.progress;
  if (p?.phase === "generate") return "Generating code";
  const total = p?.total ?? run.layers;
  if (!total) return "Reading layers";
  return `Reading layers ${(p?.done ?? 0).toLocaleString("en")} / ${total.toLocaleString("en")}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} m ${String(whole % 60).padStart(2, "0")} s`;
}

/** Milliseconds since `since`, re-rendering a few times a second. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [since]);
  return Math.max(0, now - since);
}

/** First run of a selection: nothing to show yet but how far it has got. */
export function LoadingState({ run }: { run: Run }) {
  const elapsed = useElapsed(run.startedAt);
  const pct = percent(run);
  return (
    <div className="empty">
      <div className="empty-card">
        <span className="empty-tile loading">
          <FrameIcon />
        </span>
        <h2>Generating…</h2>
        <p className="run-caption">
          {describe(run)} · {formatDuration(elapsed)}
        </p>
        <ProgressTrack pct={pct} />
      </div>
    </div>
  );
}

function ProgressTrack({ pct }: { pct: number | null }) {
  return (
    <div className="run-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      {pct === null ? <span className="indeterminate" /> : <span style={{ width: `${pct}%` }} />}
    </div>
  );
}

/** Thin bar under the top bar while a new result is on its way. */
export function ProgressBar({ run }: { run: Run }) {
  const pct = percent(run);
  if (pct === null) return <div className="progress" />;
  return (
    <div className="progress determinate">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Tab bar note: live progress during a run, otherwise how long the last one took. */
export function RunInfo({ run, stats }: { run: Run | null; stats: RunStats | null }) {
  if (run) return <LiveRunInfo run={run} />;
  if (!stats) return null;
  const total = stats.readMs + stats.generateMs;
  return (
    <span
      className="run-info"
      title={`${stats.layers.toLocaleString("en")} layers: read in ${formatDuration(stats.readMs)}, code generated in ${formatDuration(stats.generateMs)}`}
    >
      {stats.layers.toLocaleString("en")} layers · {formatDuration(total)}
    </span>
  );
}

function LiveRunInfo({ run }: { run: Run }) {
  const elapsed = useElapsed(run.startedAt);
  const pct = percent(run);
  return (
    <span className="run-info live" title={describe(run)}>
      {pct === null ? "Starting" : `${pct}%`} · {formatDuration(elapsed)}
    </span>
  );
}
