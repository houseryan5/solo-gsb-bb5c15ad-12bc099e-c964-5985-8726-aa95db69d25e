import { api } from "./api.js";
import type {
  Analysis, AugmentedPick, Group, Phase, Pick,
} from "./types.js";
import { WaveformView } from "./waveform.js";
import { ReviewPanel } from "./panel.js";
import {
  fmtRelative, localInputToMs, msToIso, msToLocalInput,
} from "./time.js";

const $ = <T extends HTMLElement = HTMLButtonElement>(sel: string) =>
  document.querySelector<T>(sel)!;

class App {
  private dsId: number | null = null;
  private analysis: Analysis | null = null;
  private fullStart = 0;
  private selectedPickId: number | null = null;
  private dragTimer: number | null = null;

  private wave: WaveformView;
  private panel: ReviewPanel;

  constructor() {
    this.wave = new WaveformView(
      $("#wave-canvas"), $("#wave-scroll"), {
        onPickAt: (s, ph, t) => this.addPick(s, ph, t),
        onPickDrag: (p, t) => this.dragPick(p, t),
        onPickDragEnd: (p, t) => this.dragPickEnd(p, t),
        onPickDblClick: (p) => this.deletePick(p),
        onSelect: (id) => this.selectPick(id),
        onCursor: (t) => {
          $("#cursor-time").textContent = t == null
            ? ""
            : `${msToIso(t)} UTC · ${fmtRelative(t, this.fullStart)}`;
        },
      });

    this.panel = new ReviewPanel($("#review-list"), $("#summary"), {
      onSelectPick: (id) => this.selectPick(id),
      onAcceptPick: (p) => this.acceptPick(p),
      onAcceptConsensus: (g, cid) => this.acceptConsensus(g, cid),
      onReject: (id) => this.rejectPick(id),
      onRestore: (id) => this.restorePick(id),
      onUndoReview: (id) => this.undoReview(id),
      onFocusTime: (t) => this.wave.focusTime(t),
    });

    this.bindChrome();
    void this.bootstrap();
  }

  // ------------------------------------------------------------ chrome -----
  private bindChrome() {
    $("#dataset-select").addEventListener("change", (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (id) void this.openDataset(id);
    });
    $("#btn-demo").addEventListener("click", () => {
      this.run(async () => {
        const d = await api.createDemo();
        await this.refreshDatasetList(d.id);
        this.toast(`已创建演示数据集 #${d.id}`);
      }, "创建演示数据失败");
    });
    $("#file-import").addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => this.run(async () => {
        const d = await api.importDataset(reader.result as string);
        await this.refreshDatasetList(d.id);
        this.toast(`已导入「${d.name}」`);
      }, "导入失败");
      reader.readAsText(file);
      input.value = "";
    });
    $("#btn-export").addEventListener("click", () => {
      if (this.dsId != null) window.open(api.exportUrl(this.dsId), "_blank");
    });
    $("#btn-delete").addEventListener("click", () => {
      if (this.dsId == null) return;
      if (!confirm("确定删除当前数据集及其全部拾取？此操作不可撤销。")) return;
      this.run(async () => {
        await api.deleteDataset(this.dsId!);
        this.dsId = null;
        this.analysis = null;
        this.selectPick(null);
        this.wave.clear();
        this.panel.render({
          groups: [], conflicts: [], rejected: [], reviews: [],
        });
        $("#empty-state").style.display = "";
        $("#btn-export").disabled = true;
        $("#btn-delete").disabled = true;
        await this.refreshDatasetList(null);
      }, "删除失败");
    });
    $("#btn-reset-view").addEventListener("click", () =>
      this.wave.resetView());

    document.querySelectorAll<HTMLInputElement>("input[name='new-phase']")
      .forEach(r => r.addEventListener("change", () => {
        if (r.checked) this.wave.setNewPhase(r.value as Phase);
      }));

    $("#pe-time").addEventListener("change", () => {
      const p = this.selectedPick();
      if (!p) return;
      const t = localInputToMs(($("#pe-time") as HTMLInputElement).value);
      if (!Number.isNaN(t)) void this.patchAndReload(p, { time: t });
    });
    $("#pe-unc").addEventListener("change", () => {
      const p = this.selectedPick();
      if (!p) return;
      const u = Math.max(0, Number(($("#pe-unc") as HTMLInputElement).value));
      void this.patchAndReload(p, { uncertainty: u });
    });
    $("#pe-weight").addEventListener("change", () => {
      const p = this.selectedPick();
      if (!p) return;
      const w = Number(($("#pe-weight") as HTMLInputElement).value);
      if (w > 0) void this.patchAndReload(p, { weight: w });
    });
    $("#pe-reject").addEventListener("click", () => {
      if (this.selectedPickId != null) void this.rejectPick(this.selectedPickId);
    });
    $("#pe-accept").addEventListener("click", () => {
      const p = this.selectedPick();
      if (p) void this.acceptPick(p);
    });
    $("#pe-delete").addEventListener("click", () => {
      const p = this.selectedPick();
      if (p) this.deletePick(p);
    });
  }

  private async bootstrap() {
    const list = await api.listDatasets();
    this.fillDatasetSelect(list, null);
    if (list.length) await this.openDataset(list[0].id);
  }

  private async refreshDatasetList(selectId: number | null) {
    const list = await api.listDatasets();
    this.fillDatasetSelect(list, selectId);
    if (selectId != null) await this.openDataset(selectId);
  }

  private fillDatasetSelect(list: { id: number; name: string }[],
                            selected: number | null) {
    const sel = $("#dataset-select") as HTMLSelectElement;
    sel.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "— 选择数据集 —";
    sel.appendChild(empty);
    for (const d of list) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = `#${d.id} ${d.name}`;
      o.selected = d.id === selected;
      sel.appendChild(o);
    }
  }

  // ------------------------------------------------------------ data -------
  private async openDataset(id: number) {
    this.dsId = id;
    this.selectPick(null);
    const detail = await api.getDetail(id);
    this.fullStart = detail.dataset.start_time;
    const analysis = await api.getAnalysis(id);
    this.analysis = analysis;
    this.wave.setData(detail.traces, analysis);
    this.panel.render(analysis);
    $("#empty-state").style.display = "none";
    $("#btn-export").disabled = false;
    $("#btn-delete").disabled = false;
  }

  private async reloadAnalysis() {
    if (this.dsId == null) return;
    this.analysis = await api.getAnalysis(this.dsId);
    this.wave.setAnalysis(this.analysis);
    this.panel.render(this.analysis);
    this.panel.setSelected(this.selectedPickId);
    this.wave.setSelected(this.selectedPickId);
    this.refreshEditor();
  }

  // ----------------------------------------------------------- picks -------
  private selectedPick(): AugmentedPick | Pick | null {
    if (this.selectedPickId == null || !this.analysis) return null;
    for (const g of this.analysis.groups) {
      const f = g.picks.find(p => p.id === this.selectedPickId);
      if (f) return f;
    }
    return this.analysis.rejected.find(p => p.id === this.selectedPickId) ?? null;
  }

  private selectPick(id: number | null) {
    this.selectedPickId = id;
    this.wave.setSelected(id);
    this.panel.setSelected(id);
    this.refreshEditor();
  }

  private refreshEditor() {
    const p = this.selectedPick();
    const bar = $("#pick-editor");
    if (!p || p.status === "rejected") {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const color = p.phase === "P" ? "var(--p-color)" : "var(--s-color)";
    const label = $("#pe-label");
    label.innerHTML =
      `<span style="color:${color}">● ${p.phase}</span> ${p.station}`
      + ` <span style="color:var(--text-dim);font-weight:400">${p.source}</span>`;
    ($("#pe-time") as HTMLInputElement).value = msToLocalInput(p.time);
    ($("#pe-unc") as HTMLInputElement).value = String(p.uncertainty);
    ($("#pe-weight") as HTMLInputElement).value = String(p.weight);
  }

  private addPick(station: string, phase: Phase, time: number) {
    if (this.dsId == null) return;
    const uncertainty = Math.max(0,
      Number(($("#new-uncertainty") as HTMLInputElement).value) || 0);
    this.run(async () => {
      await api.createPick(this.dsId!, { station, phase, time, uncertainty });
      await this.reloadAnalysis();
    }, "添加拾取失败");
  }

  private dragPick(p: AugmentedPick | Pick, time: number) {
    p.time = time;
    this.wave.setAnalysis(this.analysis!);
    if (this.dsId == null) return;
    if (this.dragTimer != null) window.clearTimeout(this.dragTimer);
    this.dragTimer = window.setTimeout(() => {
      api.patchPick(this.dsId!, p.id, { time }).catch(() =>
        this.toast("拖动结果保存失败", true));
    }, 250);
  }

  private async dragPickEnd(p: AugmentedPick | Pick, time: number) {
    p.time = time;
    if (this.dsId != null) {
      if (this.dragTimer != null) window.clearTimeout(this.dragTimer);
      try {
        await api.patchPick(this.dsId, p.id, { time });
      } catch (err) {
        this.toast(`拖动保存失败：${(err as Error).message}`, true);
      }
    }
    await this.reloadAnalysis();
  }

  private deletePick(p: AugmentedPick | Pick) {
    if (this.dsId == null) return;
    if (!confirm(`删除 ${p.station} 的 ${p.phase} 相拾取？`)) return;
    this.run(async () => {
      await api.deletePick(this.dsId!, p.id);
      if (this.selectedPickId === p.id) this.selectPick(null);
      await this.reloadAnalysis();
    }, "删除拾取失败");
  }

  private async patchAndReload(p: AugmentedPick | Pick,
                               patch: Parameters<typeof api.patchPick>[2]) {
    await api.patchPick(this.dsId!, p.id, patch);
    await this.reloadAnalysis();
  }

  private rejectPick(id: number) {
    this.run(async () => {
      await api.rejectPick(this.dsId!, id);
      if (this.selectedPickId === id) this.selectPick(null);
      await this.reloadAnalysis();
    }, "拒绝失败");
  }

  private restorePick(id: number) {
    this.run(async () => {
      await api.restorePick(this.dsId!, id);
      await this.reloadAnalysis();
    }, "恢复失败");
  }

  private acceptPick(p: AugmentedPick | Pick) {
    this.run(async () => {
      await api.createReview(this.dsId!, {
        station: p.station, phase: p.phase, time: p.time,
        uncertainty: p.uncertainty, method: "manual",
        pick_id: p.id,
      });
      await this.reloadAnalysis();
      this.toast(`已接受 ${p.station} ${p.phase} = ${msToIso(p.time)}`);
    }, "接受失败");
  }

  private acceptConsensus(g: Group, clusterId: number) {
    const c = g.clusters.find(x => x.cluster_id === clusterId);
    if (!c) return;
    this.run(async () => {
      await api.createReview(this.dsId!, {
        station: g.station, phase: g.phase,
        time: c.consensus_time,
        uncertainty: c.consensus_uncertainty,
        method: "consensus",
        cluster_id: c.cluster_id,
        note: `${c.size} picks, composite-weight mean`,
      });
      await this.reloadAnalysis();
      this.toast(`已接受 ${g.station} ${g.phase} 加权共识到时`);
    }, "接受共识失败");
  }

  private undoReview(id: number) {
    this.run(async () => {
      await api.undoReview(this.dsId!, id);
      await this.reloadAnalysis();
    }, "撤销失败");
  }

  // ------------------------------------------------------------- utils -----
  private async run(fn: () => Promise<void>, errorMsg: string) {
    try {
      await fn();
    } catch (err) {
      this.toast(`${errorMsg}：${(err as Error).message}`, true);
    }
  }

  private toastTimer: number | null = null;
  private toast(msg: string, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.hidden = false;
    if (this.toastTimer != null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { el.hidden = true; }, 3200);
  }
}

new App();
