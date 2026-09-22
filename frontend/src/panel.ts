import type {
  Analysis, AugmentedPick, Group, Review,
} from "./types.js";
import { msToIso } from "./time.js";

export interface PanelCallbacks {
  onSelectPick: (id: number | null) => void;
  onAcceptPick: (p: AugmentedPick) => void;
  onAcceptConsensus: (g: Group, clusterId: number) => void;
  onReject: (id: number) => void;
  onRestore: (id: number) => void;
  onUndoReview: (id: number) => void;
  onFocusTime: (timeMs: number) => void;
  onRejectOutliers: (groups: { station: string; phase: Group["phase"] }[]) => void;
  onUndoConflicts: () => void;
}

const PHASE_COLOR: Record<string, string> = { P: "#ff7a59", S: "#46d39a" };

function h<T extends HTMLElement = HTMLElement>(tag: string, cls = ""): T {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el as T;
}

const groupKey = (station: string, phase: string) => `${station}|${phase}`;

export class ReviewPanel {
  private root: HTMLElement;
  private summary: HTMLElement;
  private cb: PanelCallbacks;
  private selectedPickId: number | null = null;

  // Conflict-disposition workflow state
  private conflictKeys = new Set<string>();
  private selectedKeys = new Set<string>();
  private busy = false;

  constructor(root: HTMLElement, summary: HTMLElement, cb: PanelCallbacks) {
    this.root = root;
    this.summary = summary;
    this.cb = cb;
  }

  setBusy(busy: boolean) {
    this.busy = busy;
    const card = this.root.querySelector<HTMLElement>(".conflict-card");
    if (!card) return;
    card.querySelectorAll<HTMLInputElement>("input.cf-action")
      .forEach(el => { el.disabled = busy; });
    const undoBtn = card.querySelector<HTMLButtonElement>(".cf-undo");
    if (undoBtn) {
      const undoable = undoBtn.dataset.undoable === "1";
      undoBtn.disabled = busy || !undoable;
    }
    this.syncSelectionState();
  }

  setSelected(id: number | null) {
    this.selectedPickId = id;
    this.root.querySelectorAll<HTMLElement>(".pick-row").forEach(row => {
      row.classList.toggle("selected",
        Number(row.dataset.pickId) === id);
    });
  }

  /** Reset the conflict-disposition checkboxes (after a batch / undo). */
  clearConflictSelection() {
    this.selectedKeys.clear();
  }

  render(analysis: Analysis) {
    this.root.innerHTML = "";
    this.renderSummary(analysis);

    const conflictGroups = analysis.groups
      .filter(g => g.conflict)
      .sort((a, b) =>
        a.station.localeCompare(b.station)
        || (a.phase === "P" ? -1 : 1));
    this.conflictKeys = new Set(
      conflictGroups.map(g => groupKey(g.station, g.phase)));
    // Drop selections for groups that are no longer in conflict.
    this.selectedKeys = new Set(
      [...this.selectedKeys].filter(k => this.conflictKeys.has(k)));

    const hasUndoable = analysis.conflict_action?.status === "active";
    if (conflictGroups.length || hasUndoable) {
      this.root.appendChild(
        this.renderConflictCard(conflictGroups, analysis, hasUndoable));
      this.syncSelectionState();
    }

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

  // --------------------------------------------- conflict disposition ----
  private renderConflictCard(
    conflictGroups: Group[], analysis: Analysis, hasUndoable: boolean,
  ): HTMLElement {
    const card = h("section", "conflict-card");

    const head = h("div", "conflict-head");
    const title = h("span", "conflict-title");
    title.textContent = "冲突处置";
    head.appendChild(title);
    const count = h("span", "conflict-count");
    const outlierN = conflictGroups.reduce(
      (n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
    count.textContent = conflictGroups.length
      ? `待处置 ${conflictGroups.length} 组 · 离群拾取 ${outlierN} 条`
      : "待处置 0 组 · 可撤销上次处置";
    head.appendChild(count);
    card.appendChild(head);

    for (const g of conflictGroups) {
      card.appendChild(this.renderConflictRow(g));
    }

    const foot = h("div", "conflict-foot");
    if (conflictGroups.length) {
      const all = h("label", "cf-all");
      const allCb = document.createElement("input");
      allCb.type = "checkbox";
      allCb.className = "cf-action";
      allCb.checked = this.selectedKeys.size === conflictGroups.length;
      allCb.indeterminate = this.selectedKeys.size > 0
        && this.selectedKeys.size < conflictGroups.length;
      allCb.disabled = this.busy;
      allCb.addEventListener("click", () => {
        if (allCb.checked) {
          this.selectedKeys = new Set(conflictGroups.map(
            g => groupKey(g.station, g.phase)));
        } else {
          this.selectedKeys.clear();
        }
        this.syncSelectionState(conflictGroups);
      });
      all.appendChild(allCb);
      const allTxt = h("span");
      allTxt.textContent = "全选";
      all.appendChild(allTxt);
      foot.appendChild(all);
    }

    const rejectBtn = h<HTMLButtonElement>("button",
      "btn btn-small btn-danger cf-action cf-reject");
    rejectBtn.textContent = "拒绝所选离群簇";
    rejectBtn.disabled = this.busy || this.selectedKeys.size === 0;
    rejectBtn.title = "在一次事务中拒绝所选组的全部离群簇拾取";
    rejectBtn.addEventListener("click", () => {
      const groups = conflictGroups
        .filter(g => this.selectedKeys.has(groupKey(g.station, g.phase)))
        .map(g => ({ station: g.station, phase: g.phase }));
      if (!groups.length) return;
      this.cb.onRejectOutliers(groups);
    });
    foot.appendChild(rejectBtn);

    const undoBtn = h<HTMLButtonElement>(
      "button", "btn btn-small cf-action cf-undo");
    undoBtn.dataset.undoable = hasUndoable ? "1" : "0";
    const action = analysis.conflict_action;
    undoBtn.textContent = action
      ? `撤销上次批量处置（${action.change_count} 条）`
      : "撤销上次批量处置";
    undoBtn.disabled = this.busy || !hasUndoable;
    undoBtn.title = action
      ? `恢复批次 #${action.id}（${action.created_at}）中拒绝的全部拾取`
      : "暂无可撤销的批量处置";
    undoBtn.addEventListener("click", () => this.cb.onUndoConflicts());
    foot.appendChild(undoBtn);
    card.appendChild(foot);

    return card;
  }

  private renderConflictRow(g: Group): HTMLElement {
    const key = groupKey(g.station, g.phase);
    const primary = g.clusters.find(c => c.primary) ?? g.clusters[0];
    const outliers = g.clusters.filter(c => !c.primary);
    const outlierPicks = g.picks.filter(p => p.is_outlier);

    const row = h("label", "cf-row"
      + (this.selectedKeys.has(key) ? " selected" : ""));
    row.dataset.key = key;
    row.dataset.outlierCount = String(outlierPicks.length);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "cf-cb cf-action";
    cb.checked = this.selectedKeys.has(key);
    cb.disabled = this.busy;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) this.selectedKeys.add(key);
      else this.selectedKeys.delete(key);
      row.classList.toggle("selected", cb.checked);
      this.syncSelectionState();
    });
    row.appendChild(cb);

    const tag = h("span", `tag ${g.phase}`);
    tag.textContent = g.phase;
    row.appendChild(tag);

    const body = h("span", "cf-body");
    const line1 = h("span", "cf-line");
    const name = h("span", "cf-name");
    name.textContent = g.station;
    name.title = "在波形中定位主簇";
    name.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onFocusTime(primary.consensus_time);
    });
    line1.appendChild(name);
    const summary = h("span", "cf-stat");
    summary.textContent =
      `主簇 ${primary.size} 条 · 共识 ${msToIso(primary.consensus_time).slice(11, 23)}`
      + ` ±${primary.consensus_uncertainty}ms`;
    line1.appendChild(summary);
    body.appendChild(line1);

    for (const c of outliers) {
      const line = h("span", "cf-line outlier");
      line.textContent =
        `离群簇 ${c.size} 条 · 共识 ${msToIso(c.consensus_time).slice(11, 23)}`
        + ` ±${c.consensus_uncertainty}ms · 将拒绝 ${c.pick_ids.length} 条`;
      body.appendChild(line);
    }
    const sources = [...new Set(outlierPicks.map(p => p.source))].join(", ");
    if (sources) {
      const srcLine = h("span", "cf-line cf-src");
      srcLine.textContent = `来源：${sources}`;
      body.appendChild(srcLine);
    }
    row.appendChild(body);
    return row;
  }

  /** Update checkbox / button visuals to match ``selectedKeys``. */
  private syncSelectionState(conflictGroups?: Group[]) {
    const card = this.root.querySelector<HTMLElement>(".conflict-card");
    if (!card) return;
    const rows = [...card.querySelectorAll<HTMLElement>(".cf-row")];
    rows.forEach(row => {
      const checked = this.selectedKeys.has(row.dataset.key!);
      row.classList.toggle("selected", checked);
      row.querySelector<HTMLInputElement>(".cf-cb")!.checked = checked;
    });

    const total = rows.length;
    const allCb = card.querySelector<HTMLInputElement>(".cf-all input");
    if (allCb) {
      allCb.checked = total > 0 && this.selectedKeys.size === total;
      allCb.indeterminate = this.selectedKeys.size > 0
        && this.selectedKeys.size < total;
    }

    let n = 0;
    rows.forEach(row => {
      if (this.selectedKeys.has(row.dataset.key!)) {
        n += Number(row.dataset.outlierCount ?? 0);
      }
    });
    if (conflictGroups) n = this.selectedOutlierCount(conflictGroups);

    const rejectBtn = card.querySelector<HTMLButtonElement>(".cf-reject");
    if (rejectBtn) {
      rejectBtn.disabled = this.busy || this.selectedKeys.size === 0;
      rejectBtn.textContent = this.selectedKeys.size
        ? `拒绝所选离群簇（${n} 条拾取）`
        : "拒绝所选离群簇";
    }
  }

  private selectedOutlierCount(conflictGroups: Group[]): number {
    return conflictGroups
      .filter(g => this.selectedKeys.has(groupKey(g.station, g.phase)))
      .reduce((n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
  }

  private renderSummary(a: Analysis) {
    const conflictGroups = a.groups.filter(g => g.conflict).length;
    const reviewed = a.reviews.length;
    const candidates = a.groups.reduce((n, g) => n + g.picks.length, 0);
    const pendingOutliers = a.groups.reduce(
      (n, g) => n + g.picks.filter(p => p.is_outlier).length, 0);
    const items = [
      `<span class="badge">候选 <b>${candidates}</b></span>`,
      `<span class="badge">已接受 <b>${reviewed}</b></span>`,
      `<span class="badge ${conflictGroups ? "bad" : "ok"}">`
      + `冲突组 <b>${conflictGroups}</b></span>`,
      `<span class="badge ${pendingOutliers ? "bad" : ""}">`
      + `待处置离群 <b>${pendingOutliers}</b></span>`,
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
