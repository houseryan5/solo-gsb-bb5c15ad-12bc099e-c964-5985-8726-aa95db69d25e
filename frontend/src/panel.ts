import type { Analysis, AugmentedPick, Group, Review } from "./types.js";
import { msToIso } from "./time.js";

export interface PanelCallbacks {
  onSelectPick: (id: number | null) => void;
  onAcceptPick: (p: AugmentedPick) => void;
  onAcceptConsensus: (g: Group, clusterId: number) => void;
  onReject: (id: number) => void;
  onRestore: (id: number) => void;
  onUndoReview: (id: number) => void;
  onFocusTime: (timeMs: number) => void;
}

const PHASE_COLOR: Record<string, string> = { P: "#ff7a59", S: "#46d39a" };

function h(tag: string, cls = ""): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

export class ReviewPanel {
  private root: HTMLElement;
  private summary: HTMLElement;
  private cb: PanelCallbacks;
  private selectedPickId: number | null = null;

  constructor(root: HTMLElement, summary: HTMLElement, cb: PanelCallbacks) {
    this.root = root;
    this.summary = summary;
    this.cb = cb;
  }

  setSelected(id: number | null) {
    this.selectedPickId = id;
    this.root.querySelectorAll<HTMLElement>(".pick-row").forEach(row => {
      row.classList.toggle("selected",
        Number(row.dataset.pickId) === id);
    });
  }

  render(analysis: Analysis) {
    this.root.innerHTML = "";
    this.renderSummary(analysis);

    const reviewedKeys = new Set(
      analysis.reviews.map(r => `${r.station}|${r.phase}`));
    const groups = [...analysis.groups].sort((a, b) =>
      a.station.localeCompare(b.station)
      || (a.phase === "P" ? -1 : 1));

    for (const g of groups) {
      this.root.appendChild(this.renderGroup(g, analysis.reviews,
        reviewedKeys.has(`${g.station}|${g.phase}`)));
    }

    if (analysis.rejected.length) {
      const head = h("div", "rejected-head");
      head.textContent = "—— 已拒绝的拾取 ——";
      this.root.appendChild(head);
      const card = h("div", "group-card");
      for (const p of analysis.rejected) {
        card.appendChild(this.renderRejectedRow(p));
      }
      this.root.appendChild(card);
    }

    if (!groups.length && !analysis.rejected.length) {
      const ph = h("p", "placeholder");
      ph.textContent = "暂无候选拾取：在波形上点击即可添加 P / S 到时";
      this.root.appendChild(ph);
    }
  }

  private renderSummary(a: Analysis) {
    const conflictGroups = a.groups.filter(g => g.conflict).length;
    const reviewed = a.reviews.length;
    const candidates = a.groups.reduce((n, g) => n + g.picks.length, 0);
    const items = [
      `<span class="badge">候选 <b>${candidates}</b></span>`,
      `<span class="badge">已接受 <b>${reviewed}</b></span>`,
      `<span class="badge ${conflictGroups ? "bad" : "ok"}">`
      + `冲突组 <b>${conflictGroups}</b></span>`,
      `<span class="badge">已拒绝 <b>${a.rejected.length}</b></span>`,
    ];
    this.summary.innerHTML = items.join("");
  }

  private renderGroup(g: Group, reviews: Review[], reviewed: boolean): HTMLElement {
    const card = h("div", "group-card"
      + (g.conflict ? " conflict" : "")
      + (reviewed ? " reviewed" : ""));

    const title = h("div", "group-title");
    const tag = h("span", `tag ${g.phase}`);
    tag.textContent = g.phase;
    title.appendChild(tag);
    const name = h("span");
    name.textContent = g.station;
    name.style.cursor = "pointer";
    name.title = "在波形中定位";
    name.addEventListener("click", () => {
      const c = g.clusters.find(c => c.primary) ?? g.clusters[0];
      this.cb.onFocusTime(c.consensus_time);
    });
    title.appendChild(name);
    const state = h("span", "state "
      + (reviewed ? "reviewed" : g.conflict ? "conflict" : "ok"));
    state.textContent = reviewed
      ? "✓ 已审阅"
      : g.conflict ? `⚠ ${g.clusters.length} 个不重叠簇` : "✓ 窗口一致";
    title.appendChild(state);
    card.appendChild(title);

    // mini window bars inside the primary cluster for quick visual compare
    const all = g.picks;
    const minT = Math.min(...all.map(p => p.time - p.uncertainty));
    const maxT = Math.max(...all.map(p => p.time + p.uncertainty));
    const span = Math.max(1, maxT - minT);

    for (const c of g.clusters) {
      const clusterEl = h("div", "cluster" + (c.primary ? "" : " outlier"));
      const ch = h("div", "cluster-head");
      const label = h("span");
      label.textContent = c.primary
        ? `主簇 · ${c.size} 条`
        : `离群簇 · ${c.size} 条`;
      ch.appendChild(label);
      const cons = h("span", "consensus");
      cons.textContent = `加权共识 ${msToIso(c.consensus_time)}`
        + ` ±${c.consensus_uncertainty}ms`;
      ch.appendChild(cons);
      if (!reviewed) {
        const btn = h("button", "mini accept btn-consensus");
        btn.textContent = "接受共识";
        btn.addEventListener("click", () =>
          this.cb.onAcceptConsensus(g, c.cluster_id));
        ch.appendChild(btn);
      }
      clusterEl.appendChild(ch);

      for (const p of c.pick_ids
        .map(id => all.find(x => x.id === id)!)
        .sort((a, b) => a.time - b.time)) {
        clusterEl.appendChild(this.renderPickRow(p, minT, span, reviewed));
      }
      card.appendChild(clusterEl);
    }

    for (const r of reviews.filter(r =>
      r.station === g.station && r.phase === g.phase)) {
      card.appendChild(this.renderReviewRow(r));
    }
    return card;
  }

  private renderPickRow(
    p: AugmentedPick, minT: number, span: number, reviewed: boolean,
  ): HTMLElement {
    const row = h("div", "pick-row"
      + (p.id === this.selectedPickId ? " selected" : ""));
    row.dataset.pickId = String(p.id);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      this.cb.onSelectPick(p.id);
    });

    const time = h("span", "time");
    time.textContent = msToIso(p.time).slice(11, 23);
    time.title = msToIso(p.time) + " UTC";
    row.appendChild(time);

    const bar = h("div", "window-bar");
    bar.style.flex = "1";
    const fill = h("div", `window-fill ${p.phase}`);
    const left = ((p.time - p.uncertainty - minT) / span) * 100;
    const width = (2 * p.uncertainty / span) * 100;
    fill.style.left = `${left}%`;
    fill.style.width = `${Math.max(1.5, width)}%`;
    fill.title = `±${p.uncertainty} ms · 权重 ${p.weight} · ${p.source}`;
    bar.appendChild(fill);
    row.appendChild(bar);

    const src = h("span", "src");
    src.textContent = p.source;
    src.style.maxWidth = "74px";
    row.appendChild(src);

    const ops = h("span", "ops");
    if (!reviewed) {
      const accept = h("button", "mini accept");
      accept.textContent = "接受";
      accept.title = "接受此条到时";
      accept.addEventListener("click", () => this.cb.onAcceptPick(p));
      ops.appendChild(accept);
      const rej = h("button", "mini reject");
      rej.textContent = "拒绝";
      rej.addEventListener("click", () => this.cb.onReject(p.id));
      ops.appendChild(rej);
    }
    row.appendChild(ops);
    return row;
  }

  private renderRejectedRow(p: AugmentedPick | Analysis["rejected"][number]): HTMLElement {
    const row = h("div", "pick-row rejected");
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      this.cb.onSelectPick(p.id);
    });
    const tag = h("span", `tag ${p.phase}`);
    tag.textContent = p.phase;
    tag.style.marginRight = "6px";
    row.appendChild(tag);
    const time = h("span", "time");
    time.textContent = msToIso(p.time).slice(11, 23);
    row.appendChild(time);
    const src = h("span", "src");
    src.textContent = p.source;
    src.style.flex = "1";
    row.appendChild(src);
    const restore = h("button", "mini restore");
    restore.textContent = "恢复";
    restore.addEventListener("click", () => this.cb.onRestore(p.id));
    row.appendChild(restore);
    return row;
  }

  private renderReviewRow(r: Review): HTMLElement {
    const row = h("div", "accepted-row");
    const dot = h("span");
    dot.innerHTML = "●";
    dot.style.color = PHASE_COLOR[r.phase];
    row.appendChild(dot);
    const time = h("span", "time");
    time.textContent = msToIso(r.time).slice(11, 23)
      + ` ±${r.uncertainty}ms`;
    row.appendChild(time);
    const method = h("span", "method");
    method.textContent = r.method === "consensus" ? "加权共识" : "手动";
    row.appendChild(method);
    const undo = h("button", "mini undo undo-review");
    undo.textContent = "撤销";
    undo.addEventListener("click", () => this.cb.onUndoReview(r.id));
    row.appendChild(undo);
    return row;
  }
}
