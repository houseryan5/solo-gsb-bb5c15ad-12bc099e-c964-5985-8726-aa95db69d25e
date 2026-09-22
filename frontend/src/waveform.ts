import type {
  Analysis, AugmentedPick, Phase, Pick, Review, Trace,
} from "./types.js";
import { msToIso, niceStep } from "./time.js";

interface Row {
  station: string;
  network: string;
  channel: string;
  trace: Trace;
  blockY: number;
  rowY: number;
  maxAbs: number;
}

interface Block {
  station: string;
  network: string;
  y: number;
  height: number;
  rows: Row[];
}

export interface ViewRange {
  startMs: number;
  endMs: number;
}

const LABEL_W = 132;
const ROW_H = 92;
const BLOCK_HEADER_H = 24;
const BLOCK_GAP = 10;
const RIGHT_PAD = 24;
const PICK_LANE_H = 18;   // chip rows at the top of each block
const MAX_PICK_LANES = 3;
const CHANNEL_COLORS = ["#7fb4ff", "#69c8c0", "#b39ddb"];
const PHASE_COLOR: Record<Phase, string> = { P: "#ff7a59", S: "#46d39a" };

export interface WaveCallbacks {
  onPickAt: (station: string, phase: Phase, timeMs: number) => void;
  onPickDrag: (pick: AugmentedPick | Pick, timeMs: number) => void;
  onPickDragEnd: (pick: AugmentedPick | Pick, timeMs: number) => void;
  onPickDblClick: (pick: AugmentedPick | Pick) => void;
  onSelect: (pickId: number | null) => void;
  onCursor: (timeMs: number | null) => void;
}

export class WaveformView {
  private canvas: HTMLCanvasElement;
  private scroll: HTMLDivElement;
  private cb: WaveCallbacks;

  private traces: Trace[] = [];
  private blocks: Block[] = [];
  private analysis: Analysis | null = null;
  private view: ViewRange = { startMs: 0, endMs: 1 };
  private fullRange: ViewRange = { startMs: 0, endMs: 1 };

  private width = 800;
  private totalHeight = 200;

  private selectedPickId: number | null = null;
  private newPhase: Phase = "P";

  // interaction
  private drag:
    | { kind: "pick"; pick: AugmentedPick | Pick; started: boolean; moved: boolean }
    | { kind: "pan"; startX: number; startY: number; startView: ViewRange }
    | null = null;
  private mouseX: number | null = null;
  private mouseY: number | null = null;

  constructor(canvas: HTMLCanvasElement, scroll: HTMLDivElement, cb: WaveCallbacks) {
    this.canvas = canvas;
    this.scroll = scroll;
    this.cb = cb;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(scroll);
  }

  setData(traces: Trace[], analysis: Analysis) {
    this.traces = traces;
    this.analysis = analysis;
    this.view = { startMs: 0, endMs: 1 };
    this.fullRange = { startMs: 0, endMs: 1 };
    this.selectedPickId = null;
    this.blocks = [];
    this.layout();
    this.resize();
    this.draw();
  }

  clear() {
    this.setData([], { groups: [], conflicts: [], rejected: [], reviews: [] });
  }

  setAnalysis(analysis: Analysis) {
    this.analysis = analysis;
    this.draw();
  }

  setSelected(id: number | null) {
    this.selectedPickId = id;
    this.draw();
  }

  setNewPhase(phase: Phase) {
    this.newPhase = phase;
  }

  resetView() {
    this.view = { ...this.fullRange };
    this.draw();
  }

  /** Zoom so the given station/phase pick cluster is visible. */
  focusTime(timeMs: number, spanMs = 4000) {
    this.view = {
      startMs: Math.max(this.fullRange.startMs, timeMs - spanMs),
      endMs: Math.min(this.fullRange.endMs, timeMs + spanMs),
    };
    this.draw();
  }

  // ------------------------------------------------------------- layout ----
  private layout() {
    const byStation = new Map<string, Trace[]>();
    for (const t of this.traces) {
      const arr = byStation.get(t.station) ?? [];
      arr.push(t);
      byStation.set(t.station, arr);
    }
    this.blocks = [];
    let y = 8;
    for (const station of [...byStation.keys()].sort()) {
      const trs = byStation.get(station)!.sort((a, b) => a.channel.localeCompare(b.channel));
      const rows: Row[] = [];
      trs.forEach((trace, i) => {
        const maxAbs = trace.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
        rows.push({
          station, network: trace.network, channel: trace.channel, trace,
          blockY: y, rowY: y + BLOCK_HEADER_H + PICK_LANE_H * MAX_PICK_LANES + i * ROW_H,
          maxAbs,
        });
      });
      const height = BLOCK_HEADER_H + PICK_LANE_H * MAX_PICK_LANES
        + rows.length * ROW_H + BLOCK_GAP;
      this.blocks.push({
        station, network: trs[0].network, y, height, rows,
      });
      y += height;
    }
    this.totalHeight = y + 8;

    if (this.traces.length) {
      this.fullRange = {
        startMs: Math.min(...this.traces.map(t => t.start_time)),
        endMs: Math.max(...this.traces.map(t => t.end_time)),
      };
      if (this.view.startMs === 0 && this.view.endMs === 1) {
        this.view = { ...this.fullRange };
      }
      this.view.startMs = Math.max(this.fullRange.startMs, this.view.startMs);
      this.view.endMs = Math.min(this.fullRange.endMs, this.view.endMs);
    }
  }

  private resize() {
    this.width = Math.max(600, this.scroll.clientWidth - 2);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.totalHeight * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.totalHeight}px`;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ---------------------------------------------------------- mapping ------
  private xFor(ms: number): number {
    const span = Math.max(1, this.view.endMs - this.view.startMs);
    return LABEL_W + (ms - this.view.startMs) / span
      * (this.width - LABEL_W - RIGHT_PAD);
  }

  private msAt(x: number): number {
    const span = this.view.endMs - this.view.startMs;
    return this.view.startMs
      + (x - LABEL_W) / (this.width - LABEL_W - RIGHT_PAD) * span;
  }

  private clampMs(t: number): number {
    return Math.max(this.fullRange.startMs,
      Math.min(this.fullRange.endMs, Math.round(t)));
  }

  // ------------------------------------------------------------- draw ------
  private draw() {
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, this.width, this.totalHeight);
    if (!this.blocks.length) return;

    this.drawTimeAxis(ctx);
    for (const b of this.blocks) {
      this.drawBlock(ctx, b);
    }
    this.drawCursor(ctx);
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.fillStyle = "#8a98a9";
    ctx.font = "11px monospace";
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(220,228,238,0.55)";
    const plotW = this.width - LABEL_W - RIGHT_PAD;
    const target = 90;
    const span = this.view.endMs - this.view.startMs;
    const step = niceStep(span / (plotW / target));
    const first = Math.ceil(this.view.startMs / step) * step;

    ctx.textAlign = "center";
    for (let t = first; t <= this.view.endMs; t += step) {
      const x = this.xFor(t);
      if (x < LABEL_W) continue;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, this.totalHeight - 4);
      ctx.stroke();
      const rel = ((t - this.fullRange.startMs) / 1000).toFixed(
        step >= 1000 ? 1 : 3);
      ctx.fillText(`${rel}s`, x, 14);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(138,152,169,0.8)";
    ctx.fillText(`0 = ${msToIso(this.fullRange.startMs)} UTC`, LABEL_W, this.totalHeight - 6);
    ctx.restore();
  }

  private drawBlock(ctx: CanvasRenderingContext2D, b: Block) {
    // station label / header
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, b.y, this.width, BLOCK_HEADER_H);
    ctx.fillStyle = "#dce4ee";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${b.network ? b.network + "." : ""}${b.station}`, 10,
      b.y + BLOCK_HEADER_H / 2);

    for (let i = 0; i < b.rows.length; i++) {
      this.drawRow(ctx, b.rows[i], i, CHANNEL_COLORS[i % CHANNEL_COLORS.length]);
    }
    this.drawPicks(ctx, b);
  }

  private drawRow(ctx: CanvasRenderingContext2D, row: Row, idx: number, color: string) {
    const y0 = row.rowY;
    // background
    ctx.fillStyle = idx % 2 === 0 ? "rgba(255,255,255,0.012)" : "transparent";
    ctx.fillRect(LABEL_W, y0, this.width - LABEL_W - RIGHT_PAD, ROW_H);

    // channel label
    ctx.fillStyle = "#8a98a9";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(row.channel, 10, y0 + ROW_H / 2);

    // zero line
    const mid = y0 + ROW_H / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    ctx.moveTo(LABEL_W, mid);
    ctx.lineTo(this.width - RIGHT_PAD, mid);
    ctx.stroke();

    // waveform: min/max decimation per pixel bucket
    const plotW = this.width - LABEL_W - RIGHT_PAD;
    const { trace, maxAbs } = row;
    const ampScale = (ROW_H / 2 - 6) / maxAbs;
    const msPerSample = 1000 / trace.sample_rate;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let px = 0; px <= plotW; px++) {
      const t0 = this.msAt(LABEL_W + px);
      const t1 = this.msAt(LABEL_W + px + 1);
      const i0 = Math.max(0, Math.floor((t0 - trace.start_time) / msPerSample));
      const i1 = Math.min(trace.n_samples - 1,
        Math.ceil((t1 - trace.start_time) / msPerSample));
      if (i1 < i0) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const v = trace.samples[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo)) continue;
      const x = LABEL_W + px;
      const yHi = mid - hi * ampScale;
      const yLo = mid - lo * ampScale;
      if (!started) { ctx.moveTo(x, yHi); started = true; }
      ctx.lineTo(x, yHi);
      ctx.lineTo(x, yLo);
    }
    ctx.stroke();
  }

  private allPicksFlat(): (AugmentedPick | Pick)[] {
    if (!this.analysis) return [];
    const out: (AugmentedPick | Pick)[] = [];
    for (const g of this.analysis.groups) out.push(...g.picks);
    out.push(...this.analysis.rejected);
    return out;
  }

  private drawPicks(ctx: CanvasRenderingContext2D, b: Block) {
    if (!this.analysis) return;
    const picks = this.allPicksFlat().filter(p => p.station === b.station);
    const reviews = this.analysis.reviews.filter(r => r.station === b.station);
    const groups = this.analysis.groups.filter(g => g.station === b.station);

    // accepted review lines (full block height, behind chips)
    for (const r of reviews) {
      const x = this.xFor(r.time);
      if (x < LABEL_W || x > this.width - RIGHT_PAD) continue;
      this.drawReviewLine(ctx, b, r, x);
    }

    // assign non-overlapping chip lanes per phase
    for (const phase of ["P", "S"] as Phase[]) {
      const phasePicks = picks
        .filter(p => p.phase === phase)
        .sort((a, c) => a.time - c.time);
      const laneEnds = new Array(MAX_PICK_LANES).fill(-Infinity);
      for (const p of phasePicks) {
        const x = this.xFor(p.time);
        const halfW = 26;
        let lane = laneEnds.findIndex(end => x - halfW > end);
        if (lane < 0) lane = MAX_PICK_LANES - 1;
        laneEnds[lane] = x + halfW;
        this.drawPickChip(ctx, b, p, x, lane, groups, reviews);
      }
    }
  }

  private chipY(b: Block, lane: number): number {
    return b.y + BLOCK_HEADER_H + lane * PICK_LANE_H + 2;
  }

  private drawPickChip(
    ctx: CanvasRenderingContext2D, b: Block, p: AugmentedPick | Pick,
    x: number, lane: number, groups: Analysis["groups"], _reviews: Review[],
  ) {
    const rejected = p.status === "rejected";
    const color = rejected ? "#6b7686" : PHASE_COLOR[p.phase];
    const top = b.y + BLOCK_HEADER_H;
    const bottom = b.y + b.height - BLOCK_GAP;
    const chipY = this.chipY(b, lane);

    // uncertainty window shade
    if (!rejected) {
      const x1 = this.xFor(p.time - p.uncertainty);
      const x2 = this.xFor(p.time + p.uncertainty);
      ctx.fillStyle = this.hexA(color, 0.10);
      ctx.fillRect(x1, top, Math.max(1, x2 - x1), bottom - top);
    }

    // vertical line through all rows
    ctx.strokeStyle = this.hexA(color, rejected ? 0.35 : 0.75);
    ctx.setLineDash(rejected ? [4, 4] : []);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // chip
    const group = groups.find(g => g.phase === p.phase);
    const conflicting = group?.conflict
      && (p as AugmentedPick).is_outlier === true;
    const selected = p.id === this.selectedPickId;
    const w = 52;
    const h = 15;
    ctx.fillStyle = rejected ? "#2c333d" : this.hexA(color, 0.22);
    this.roundRect(ctx, x - w / 2, chipY, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = selected ? "#ffffff" : conflicting ? "#ffd166" : color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = rejected ? "#8a98a9" : "#eef3f9";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const rel = ((p.time - this.fullRange.startMs) / 1000).toFixed(2);
    ctx.fillText(`${p.phase} ${rel}`, x, chipY + h / 2 + 0.5);
  }

  private drawReviewLine(ctx: CanvasRenderingContext2D, b: Block, r: Review, x: number) {
    const color = PHASE_COLOR[r.phase];
    ctx.strokeStyle = this.hexA(color, 0.9);
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 3]);
    ctx.beginPath();
    ctx.moveTo(x, b.y + BLOCK_HEADER_H);
    ctx.lineTo(x, b.y + b.height - BLOCK_GAP);
    ctx.stroke();
    ctx.setLineDash([]);
    const x1 = this.xFor(Math.max(this.view.startMs, r.time - r.uncertainty));
    const x2 = this.xFor(Math.min(this.view.endMs, r.time + r.uncertainty));
    ctx.fillStyle = this.hexA(color, 0.18);
    const wy = b.y + b.height - 7;
    ctx.fillRect(x1, wy, Math.max(1, x2 - x1), 4);
  }

  private drawCursor(ctx: CanvasRenderingContext2D) {
    if (this.mouseX == null || this.mouseY == null) return;
    if (this.mouseX < LABEL_W) return;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(this.mouseX, 0);
    ctx.lineTo(this.mouseX, this.totalHeight);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---------------------------------------------------------- hit tests ----
  private blockAt(y: number): Block | null {
    return this.blocks.find(b => y >= b.y && y <= b.y + b.height) ?? null;
  }

  private pickAt(x: number, y: number): AugmentedPick | Pick | null {
    const b = this.blockAt(y);
    if (!b || !this.analysis) return null;
    const picks = this.allPicksFlat().filter(p => p.station === b.station);
    let best: { p: AugmentedPick | Pick; d: number; lane: number } | null = null;
    for (const phase of ["P", "S"] as Phase[]) {
      const phasePicks = picks.filter(p => p.phase === phase)
        .sort((a, c) => a.time - c.time);
      const laneEnds = new Array(MAX_PICK_LANES).fill(-Infinity);
      for (const p of phasePicks) {
        const px = this.xFor(p.time);
        let lane = laneEnds.findIndex(end => px - 26 > end);
        if (lane < 0) lane = MAX_PICK_LANES - 1;
        laneEnds[lane] = px + 26;
        const cy = this.chipY(b, lane) + 7;
        if (Math.abs(y - cy) < 12 && Math.abs(x - px) < 28) {
          const d = Math.abs(x - px);
          if (!best || d < best.d) best = { p, d, lane };
        }
      }
    }
    return best?.p ?? null;
  }

  // ---------------------------------------------------------- events -------
  private bindEvents() {
    const el = this.canvas;
    el.addEventListener("contextmenu", e => e.preventDefault());

    el.addEventListener("pointerdown", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      el.setPointerCapture(e.pointerId);

      const picked = this.pickAt(x, y);
      if (picked && e.button === 0 && !e.shiftKey) {
        this.drag = { kind: "pick", pick: picked, started: true, moved: false };
        this.cb.onSelect(picked.id);
        return;
      }
      if (e.button === 2 || e.shiftKey || e.button === 1) {
        this.drag = {
          kind: "pan", startX: x, startY: y,
          startView: { ...this.view },
        };
        el.style.cursor = "grabbing";
        return;
      }
      // left click on empty waveform area -> add pick
      if (e.button === 0 && x > LABEL_W) {
        const b = this.blockAt(y);
        if (b) {
          this.drag = {
            kind: "pan", startX: x, startY: y,
            startView: { ...this.view },
          };
          // treat tiny movement as click-add in pointerup
        }
      }
    });

    el.addEventListener("pointermove", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.mouseX = x;
      this.mouseY = y;
      if (x > LABEL_W) this.cb.onCursor(this.msAt(x));

      if (this.drag?.kind === "pick") {
        const t = this.clampMs(this.msAt(x));
        this.drag.moved = true;
        this.cb.onPickDrag(this.drag.pick, t);
      } else if (this.drag?.kind === "pan") {
        const span = this.drag.startView.endMs - this.drag.startView.startMs;
        const plotW = this.width - LABEL_W - RIGHT_PAD;
        const dt = (this.drag.startX - x) / plotW * span;
        let s = this.drag.startView.startMs + dt;
        let en = this.drag.startView.endMs + dt;
        s = Math.max(this.fullRange.startMs,
          Math.min(this.fullRange.endMs - span, s));
        en = s + span;
        this.view = { startMs: s, endMs: en };
      }
      this.draw();
    });

    el.addEventListener("pointerup", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (this.drag?.kind === "pick" && !this.drag.moved) {
        // simple click, nothing else
      } else if (this.drag?.kind === "pick") {
        this.cb.onPickDragEnd(this.drag.pick,
          this.clampMs(this.msAt(x)));
      } else if (this.drag?.kind === "pan") {
        const movedPx = Math.abs(x - this.drag.startX)
          + Math.abs(y - this.drag.startY);
        if (movedPx < 4 && e.button === 0) {
          const b = this.blockAt(y);
          if (b && x > LABEL_W) {
            this.cb.onPickAt(b.station, this.newPhase,
              this.clampMs(this.msAt(x)));
          }
        }
      }
      this.drag = null;
      el.style.cursor = "crosshair";
    });

    el.addEventListener("pointerleave", () => {
      this.mouseX = null;
      this.mouseY = null;
      this.cb.onCursor(null);
      this.draw();
    });

    el.addEventListener("dblclick", (e) => {
      const rect = el.getBoundingClientRect();
      const p = this.pickAt(e.clientX - rect.left, e.clientY - rect.top);
      if (p) this.cb.onPickDblClick(p);
    });

    el.addEventListener("wheel", (e) => {
      if (e.clientX < LABEL_W) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const anchor = this.msAt(x);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const span = this.view.endMs - this.view.startMs;
      const newSpan = Math.min(
        this.fullRange.endMs - this.fullRange.startMs,
        Math.max(20, span * factor),
      );
      const ratioL = (anchor - this.view.startMs) / span;
      let s = anchor - ratioL * newSpan;
      s = Math.max(this.fullRange.startMs,
        Math.min(this.fullRange.endMs - newSpan, s));
      s = Math.round(s);
      this.view = {
        startMs: s,
        endMs: Math.min(this.fullRange.endMs, Math.round(s + newSpan)),
      };
      this.draw();
    }, { passive: false });
  }

  // ------------------------------------------------------------- utils ------
  private roundRect(
    ctx: CanvasRenderingContext2D, x: number, y: number,
    w: number, h: number, r: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private hexA(hex: string, alpha: number): string {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
