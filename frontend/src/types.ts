export interface DatasetMeta {
  id: number;
  name: string;
  created_at: string;
  start_time: number;
  end_time: number;
  trace_count: number;
  pick_count: number;
}

export interface Trace {
  id: number;
  station: string;
  network: string;
  channel: string;
  start_time: number;
  end_time: number;
  sample_rate: number;
  n_samples: number;
  samples: number[];
}

export type Phase = "P" | "S";

export interface Pick {
  id: number;
  station: string;
  phase: Phase;
  time: number;
  uncertainty: number;
  weight: number;
  source: string;
  status: "candidate" | "rejected";
  created_at: string;
}

export interface AugmentedPick extends Pick {
  cluster_id: number;
  is_outlier: boolean;
}

export interface Cluster {
  cluster_id: number;
  pick_ids: number[];
  size: number;
  sum_weight: number;
  consensus_time: number;
  consensus_uncertainty: number;
  primary: boolean;
}

export interface Group {
  station: string;
  phase: Phase;
  conflict: boolean;
  primary_cluster_id: number;
  clusters: Cluster[];
  picks: AugmentedPick[];
}

export interface ConflictPair {
  station: string;
  phase: Phase;
  pick_a_id: number;
  pick_b_id: number;
}

export interface Review {
  id: number;
  station: string;
  phase: Phase;
  time: number;
  uncertainty: number;
  method: "manual" | "consensus";
  pick_id: number | null;
  cluster_id: number | null;
  note: string;
  created_at: string;
}

export interface Analysis {
  groups: Group[];
  conflicts: ConflictPair[];
  rejected: Pick[];
  reviews: Review[];
  conflict_action: ConflictAction | null;
}

export interface ConflictActionGroup {
  station: string;
  phase: Phase;
  rejected_pick_ids: number[];
}

export interface ConflictAction {
  id: number;
  status: "active" | "undone" | "superseded";
  group_count: number;
  change_count: number;
  created_at: string;
  groups?: ConflictActionGroup[];
}

export interface ConflictChange {
  pick_id: number;
  station: string;
  phase: Phase;
  time: number;
  time_iso: string;
  uncertainty: number;
  weight: number;
  source: string;
  previous_status: "candidate" | "rejected";
  status: "candidate" | "rejected";
}

export interface ConflictRejectGroup {
  station: string;
  phase: Phase;
  primary_cluster: {
    cluster_id: number;
    size: number;
    consensus_time: number;
    consensus_time_iso: string;
    consensus_uncertainty: number;
    pick_ids: number[];
  };
  outlier_clusters: {
    cluster_id: number;
    size: number;
    consensus_time: number;
    consensus_time_iso: string;
    consensus_uncertainty: number;
    pick_ids: number[];
  }[];
  rejected_pick_ids: number[];
}

export interface ConflictRejectResult {
  action: {
    id: number;
    group_count: number;
    change_count: number;
    created_at: string;
    status: string;
  };
  groups: ConflictRejectGroup[];
  changes: ConflictChange[];
  skipped: { station: string; phase: Phase; reason: string }[];
}

export interface ConflictUndoResult {
  action: {
    id: number;
    group_count: number;
    change_count: number;
    created_at: string;
    undone_at: string;
    status: "undone";
  };
  changes: ConflictChange[];
  missing_pick_ids: number[];
}

export interface DatasetDetail {
  dataset: DatasetMeta;
  traces: Trace[];
  picks: Pick[];
  reviews: Review[];
}
