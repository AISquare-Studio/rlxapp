import { useEffect, useRef, useState } from "react";
import { useNow } from "../engine/hooks.ts";
import { useApp } from "../state/context.ts";
import { Icon } from "../ui/Icon.tsx";
import { formatClock } from "./time.ts";

/**
 * Hours and minutes only: calmer than a ticking seconds display, and the page repaints once a
 * minute instead of every second, which lets WebKit release idle graphics memory.
 */
export function ClockWidget() {
  const now = useNow(5_000);
  const date = new Date(now);
  return (
    <div className="clock">
      <div className="clock__time" data-testid="clock-time">
        {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
      <div className="clock__date">{date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
    </div>
  );
}

/** A countdown that ticks once a second while running. */
function useCountdown(initialSeconds: number, onDone: () => void) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          setRunning(false);
          onDone();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [running, onDone]);
  return { remaining, setRemaining, running, setRunning };
}

export function TimerWidget() {
  const { toast } = useApp();
  const [minutes, setMinutes] = useState(5);
  const { remaining, setRemaining, running, setRunning } = useCountdown(5 * 60, () => toast("Timer finished", "success"));
  return (
    <div className="timer">
      <div className="timer__display" data-testid="timer-display" aria-live="polite">
        {formatClock(remaining)}
      </div>
      <div className="timer__row">
        <label className="field field--inline">
          <span>Minutes</span>
          <input
            type="number"
            min={1}
            max={180}
            value={minutes}
            disabled={running}
            onChange={(e) => {
              const value = Math.max(1, Math.min(180, Number(e.target.value) || 1));
              setMinutes(value);
              setRemaining(value * 60);
            }}
          />
        </label>
      </div>
      <div className="button-row">
        <button type="button" className="button button--primary" onClick={() => setRunning(!running)} disabled={remaining === 0}>
          <Icon name={running ? "pause" : "play"} size={16} /> {running ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setRunning(false);
            setRemaining(minutes * 60);
          }}
        >
          <Icon name="reset" size={16} /> Reset
        </button>
      </div>
    </div>
  );
}

const WORK = 25 * 60;
const BREAK = 5 * 60;

interface Pomodoro {
  phase: "focus" | "break";
  remaining: number;
  done: number;
}

const START: Pomodoro = { phase: "focus", remaining: WORK, done: 0 };

export function PomodoroWidget() {
  const { toast } = useApp();
  const [pomo, setPomo] = useState<Pomodoro>(START);
  const [running, setRunning] = useState(false);
  const current = useRef(pomo);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      const cur = current.current;
      let next: Pomodoro;
      if (cur.remaining > 1) {
        next = { ...cur, remaining: cur.remaining - 1 };
      } else if (cur.phase === "focus") {
        next = { phase: "break", remaining: BREAK, done: cur.done + 1 };
        toast("Focus session done. Take a 5-minute break.", "success");
      } else {
        next = { phase: "focus", remaining: WORK, done: cur.done };
        setRunning(false);
        toast("Break over.", "info");
      }
      current.current = next;
      setPomo(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, toast]);

  const { phase, remaining, done } = pomo;
  const total = phase === "focus" ? WORK : BREAK;
  const progress = 1 - remaining / total;
  return (
    <div className="pomodoro">
      <div className="pomodoro__ring" style={{ ["--progress" as string]: String(progress) }}>
        <div className="pomodoro__display" data-testid="pomodoro-display" aria-live="polite">
          {formatClock(remaining)}
        </div>
        <div className="pomodoro__phase">{phase === "focus" ? "Focus" : "Break"}</div>
      </div>
      <p className="muted">Sessions done today: {done}</p>
      <div className="button-row">
        <button type="button" className="button button--primary" onClick={() => setRunning(!running)}>
          <Icon name={running ? "pause" : "play"} size={16} /> {running ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setRunning(false);
            const reset = { ...START, done: current.current.done };
            current.current = reset;
            setPomo(reset);
          }}
        >
          <Icon name="reset" size={16} /> Reset
        </button>
      </div>
    </div>
  );
}
