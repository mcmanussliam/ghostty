export type GitFile = { status: string; path: string };
export type GitStatus = { branch: string; files: GitFile[]; total: number };
export type GitData = GitStatus & { root: string };
