// src/panels/chart-panel.tsx
//
// A canvas chart of the mid prices. It exists for the session replay. A canvas has no DOM nodes to
// record, so the recorder reads its pixels, and only with replay.recordCanvas. The setting is off
// by default, because it costs time and memory. With it off, the replay shows an empty canvas.

import { type ReactElement, useEffect, useRef } from "react";
import { profiler } from "@utk09/ui-observability";
import { PAIRS, type Pair } from "../api/types";
import { getHistory, subscribeMarket } from "../data/market-store";

const REDRAW_MS = 100;
const COLORS: Record<Pair, string> = {
  EURUSD: "#5aa2ff",
  GBPUSD: "#f2b14a",
  USDJPY: "#5bd08a",
  AUDUSD: "#ff7b72",
};
const BASIS_POINTS = 10_000;
const MARGIN = { left: 48, right: 12, top: 12, bottom: 24 };

// The probe is at module scope. While profiler.enabled is false, begin() reads no clock.
const drawProbe = profiler.probe("chart.draw");

/**
 * Draws the move of each pair since its first price in the history, in basis points.
 * @param canvas The canvas.
 * @param ratio The device pixel ratio of the window that shows the canvas.
 */
function draw(canvas: HTMLCanvasElement, ratio: number): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const moves = PAIRS.map((pair) => {
    const mids = getHistory(pair);
    const first = mids[0];

    return { pair, values: first ? mids.map((mid) => ((mid - first) / first) * BASIS_POINTS) : [] };
  });
  const all = moves.flatMap((move) => move.values);
  const low = Math.min(0, ...all);
  const high = Math.max(0, ...all, low + 1);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const y = (value: number): number =>
    MARGIN.top + plotHeight - ((value - low) / (high - low)) * plotHeight;

  context.strokeStyle = "rgba(128, 128, 128, 0.4)";
  context.fillStyle = getComputedStyle(canvas).color;
  context.font = "11px system-ui, sans-serif";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(MARGIN.left, y(0));
  context.lineTo(width - MARGIN.right, y(0));
  context.stroke();
  context.fillText("0 bp", 8, y(0) + 4);
  context.fillText(high.toFixed(1), 8, y(high) + 4);
  context.fillText(low.toFixed(1), 8, y(low) + 4);

  context.lineWidth = 2;
  moves.forEach((move, row) => {
    context.strokeStyle = COLORS[move.pair];
    context.beginPath();
    move.values.forEach((value, index) => {
      const x = MARGIN.left + (index / Math.max(1, move.values.length - 1)) * plotWidth;
      if (index === 0) {
        context.moveTo(x, y(value));
      } else {
        context.lineTo(x, y(value));
      }
    });
    context.stroke();
    context.fillStyle = COLORS[move.pair];
    context.fillText(move.pair, MARGIN.left + row * 64, height - 6);
  });
}

/**
 * Renders the chart.
 * @returns The panel.
 */
export function ChartPanel(): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // A timer and not requestAnimationFrame, because the panel can sit in a popout window, and a
  // frame callback of the opener stops when the opener is hidden. The cleanup stops each listener
  // and the timer, so StrictMode can mount, unmount and mount again.
  useEffect(() => {
    const element = canvas.current;
    const box = host.current;
    if (!element || !box) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const ratio = (): number => element.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const paint = (): void => {
      timer = undefined;
      const token = drawProbe.begin();
      draw(element, ratio());
      drawProbe.end(token);
    };
    const schedule = (): void => {
      timer ??= setTimeout(paint, REDRAW_MS);
    };
    const resize = (): void => {
      element.width = Math.max(1, Math.round(box.clientWidth * ratio()));
      element.height = Math.max(1, Math.round(box.clientHeight * ratio()));
      schedule();
    };

    const unsubscribe = subscribeMarket(schedule);
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    resize();

    return () => {
      unsubscribe();
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  return (
    <section className="panel chart-panel" aria-label="Chart">
      <p className="muted">
        The move of each pair in the last minute, in basis points. The replay shows this canvas only
        with <code>replay.recordCanvas</code> on.
      </p>
      <div className="chart-host" ref={host} data-observability-live>
        <canvas ref={canvas} aria-label="Price chart" role="img" />
      </div>
    </section>
  );
}
