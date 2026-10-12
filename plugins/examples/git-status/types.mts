export type GitGroup = "conflicts" | "staged" | "unstaged" | "untracked";
export type GitCounts = Record<GitGroup, number>;
export type GitFile = {
  status: string;
  path: string;
  originalPath?: string;
  groups: GitGroup[];
};
export type GitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
  upstreamGone: boolean;
  counts: GitCounts;
  files: GitFile[];
  total: number;
};
export type GitData = GitStatus & { root: string; error?: string };
