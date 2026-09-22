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
  onResolveConflicts: (groups: { station: string; phase: Group["phase"] }[]) => void;
  onUndoResolution: (resolutionId: number) => void;
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
  private checkedGroups = new Set<string>();

  constructor(root: HTMLElement, summary: HTMLElement, cb: PanelCallbacks) {
    this.root = root;
    this.summary = summary;
    this.cb = cb;
  }

  static groupKey(station: string, phase: string): string {
    return `${station}|${phase}`;
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
    this.renderResolutionDock(analysis);
    this.renderUndoBar(analysis);

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
    const conflictGroups = a.groups.filter(g => g.conflict);
    const pendingPicks = conflictGroups.reduce(
      (n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
    const reviewed = a.reviews.length;
    const candidates = a.groups.reduce((n, g) => n + g.picks.length, 0);
    const items = [
      `<span class="badge">候选 <b>${candidates}</b></span>`,
      `<span class="badge">已接受 <b>${reviewed}</b></span>`,
      `<span class="badge ${conflictGroups.length ? "bad" : "ok"}">`
      + `待处置 <b>${conflictGroups.length}</b> 组 / `
      + `<b>${pendingPicks}</b> 条离群</span>`,
      `<span class="badge">已拒绝 <b>${a.rejected.length}</b></span>`,
    ];
    this.summary.innerHTML = items.join("");
  }

  // ------------------------------------------------- conflict resolution ---
  private renderResolutionDock(a: Analysis) {
    const conflictGroups = a.groups.filter(g => g.conflict);
    if (!conflictGroups.length) return;

    // Newly appearing groups default to checked; disappear on their own.
    const current = new Set(
      conflictGroups.map(g => ReviewPanel.groupKey(g.station, g.phase)));
    for (const key of current) {
      if (!this.checkedGroups.has(key)) this.checkedGroups.add(key);
    }
    for (const key of [...this.checkedGroups]) {
      if (!current.has(key)) this.checkedGroups.delete(key);
    }

    const dock = h("div", "resolution-dock");
    const head = h("div", "resolution-head");
    const title = h("span", "resolution-title");
    title.textContent = "⚡ 冲突处置";
    head.appendChild(title);
    const selectAll = h("button", "mini link");
    selectAll.textContent = "全选";
    selectAll.addEventListener("click", () => {
      this.checkedGroups = new Set(current);
      this.render(a);
    });
    head.appendChild(selectAll);
    const selectNone = h("button", "mini link");
    selectNone.textContent = "清空";
    selectNone.addEventListener("click", () => {
      this.checkedGroups = new Set();
      this.render(a);
    });
    head.appendChild(selectNone);
    dock.appendChild(head);

    for (const g of conflictGroups) {
      dock.appendChild(this.renderConflictPreview(a, g));
    }

    const footer = h("div", "resolution-footer");
    const info = h("span", "resolution-info");
    const apply = h("button", "btn btn-small btn-reject-outliers") as HTMLButtonElement;
    apply.textContent = "拒绝所选离群簇";
    const refreshApply = () => {
      const chosen = conflictGroups.filter(g =>
        this.checkedGroups.has(ReviewPanel.groupKey(g.station, g.phase)));
      const pickN = chosen.reduce(
        (n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
      info.textContent = chosen.length
        ? `已选 ${chosen.length} 组 · 将拒绝 ${pickN} 条离群拾取`
        : "未选择分组";
      apply.disabled = !chosen.length;
    };
    apply.addEventListener("click", () => {
      const chosen = conflictGroups
        .filter(g => this.checkedGroups.has(
          ReviewPanel.groupKey(g.station, g.phase)))
        .map(g => ({ station: g.station, phase: g.phase }));
      if (!chosen.length) return;
      const pickN = conflictGroups
        .filter(g => this.checkedGroups.has(
          ReviewPanel.groupKey(g.station, g.phase)))
        .reduce((n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
      if (!confirm(`确认拒绝所选 ${chosen.length} 个组中的 ${pickN} 条离群簇拾取？\n`
        + "（可在处置后一次性撤销恢复）")) return;
      this.cb.onResolveConflicts(chosen);
    });
    footer.appendChild(info);
    footer.appendChild(apply);
    dock.appendChild(footer);
    this.root.appendChild(dock);
    refreshApply();
  }

  private renderConflictPreview(a: Analysis, g: Group): HTMLElement {
    const key = ReviewPanel.groupKey(g.station, g.phase);
    const row = h("div", "conflict-preview");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "conflict-check";
    cb.checked = this.checkedGroups.has(key);
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) this.checkedGroups.add(key);
      else this.checkedGroups.delete(key);
      const footer = this.root.querySelector(".resolution-footer");
      if (footer) {
        const groups = a.groups.filter(x => x.conflict);
        const chosen = groups.filter(x => this.checkedGroups.has(
          ReviewPanel.groupKey(x.station, x.phase)));
        const pickN = chosen.reduce(
          (n, x) => n + x.picks.filter(p => p.is_outlier).length, 0);
        const info = footer.querySelector<HTMLElement>(".resolution-info");
        const btn = footer.querySelector<HTMLButtonElement>(".btn-reject-outliers");
        if (info) {
          info.textContent = chosen.length
            ? `已选 ${chosen.length} 组 · 将拒绝 ${pickN} 条离群拾取`
            : "未选择分组";
        }
        if (btn) btn.disabled = !chosen.length;
      }
    });
    row.appendChild(cb);

    const body = h("div", "conflict-body");
    const label = h("div", "conflict-label");
    const tag = h("span", `tag ${g.phase}`);
    tag.textContent = g.phase;
    label.appendChild(tag);
    const name = h("span", "conflict-station");
    name.textContent = g.station;
    name.title = "在波形中定位主簇";
    name.addEventListener("click", () => {
      const c = g.clusters.find(c => c.primary) ?? g.clusters[0];
      this.cb.onFocusTime(c.consensus_time);
    });
    label.appendChild(name);
    const nClusters = h("span", "conflict-n");
    nClusters.textContent = `${g.clusters.length} 簇`;
    label.appendChild(nClusters);
    body.appendChild(label);

    const detail = h("div", "conflict-cluster-summary");
    const primary = g.clusters.find(c => c.primary)!;
    const outlierClusters = g.clusters.filter(c => !c.primary);
    const primaryEl = h("span", "cluster-sum primary");
    primaryEl.textContent = `主簇 ${primary.size} 条`
      + ` @ ${msToIso(primary.consensus_time).slice(11, 23)}`
      + ` ±${primary.consensus_uncertainty}ms`;
    detail.appendChild(primaryEl);
    const outN = outlierClusters.reduce((n, c) => n + c.size, 0);
    const outEl = h("span", "cluster-sum outlier");
    outEl.textContent = `离群 ${outlierClusters.length} 簇 / ${outN} 条`;
    for (const c of outlierClusters) {
      const chip = h("span", "outlier-chip");
      chip.textContent = `${c.size}×${msToIso(c.consensus_time).slice(11, 23)}`;
      chip.title = `加权共识 ${msToIso(c.consensus_time)} `
        + `±${c.consensus_uncertainty}ms，将拒绝 ${c.size} 条`;
      outEl.appendChild(chip);
    }
    detail.appendChild(outEl);
    body.appendChild(detail);
    row.appendChild(body);
    return row;
  }

  private renderUndoBar(a: Analysis) {
    const last = a.last_resolution;
    if (!last || last.undone_at) return;
    const bar = h("div", "undo-resolution-bar");
    const info = h("span");
    const groupNames = last.groups
      .map(g => `${g.station}/${g.phase}`).join("、");
    info.textContent = `已批量拒绝 ${last.rejected_count} 条离群拾取`
      + `（${groupNames}），可一次性撤销`;
    bar.appendChild(info);
    const undo = h("button", "mini undo");
    undo.textContent = "↩ 撤销处置";
    undo.addEventListener("click", () =>
      this.cb.onUndoResolution(last.id));
    bar.appendChild(undo);
    this.root.appendChild(bar);
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
