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
}

export interface DatasetDetail {
  dataset: DatasetMeta;
  traces: Trace[];
  picks: Pick[];
  reviews: Review[];
}
