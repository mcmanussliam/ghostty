function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Git view element: ${id}`);
  return node;
}

const repository = element("repository");
const files = element("files");
const refreshElement = element("refresh");
const empty = element("empty");
const count = element("count");
const summary = element("summary");
const branch = element("branch");
const root = element("root");
if (!(refreshElement instanceof HTMLButtonElement))
  throw new Error("Refresh must be a button");
const refresh = refreshElement;

function isFile(value: unknown): value is GitPaneFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function isGitPaneData(value: GitPaneState): value is GitPaneData {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.root === "string" &&
    typeof value.branch === "string" &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total >= 0 &&
    Array.isArray(value.files) &&
    value.files.every(isFile)
  );
}

function statusKind(status: string): string {
  if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(status)) return "conflict";
  if (status.includes("D")) return "deleted";
  if (/[A?]/.test(status)) return "added";
  return "modified";
}

const statusNames: Readonly<Record<string, string>> = {
  M: "modified",
  T: "type changed",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
};

function statusDescription(status: string): string {
  if (status === "??") return "Untracked";
  if (statusKind(status) === "conflict") return "Merge conflict";
  const parts: string[] = [];
  const staged = statusNames[status[0] ?? ""];
  const unstaged = statusNames[status[1] ?? ""];
  if (staged) parts.push(`Staged: ${staged}`);
  if (unstaged) parts.push(`Working tree: ${unstaged}`);
  return parts.join("; ") || status;
}

function fileRow(file: GitPaneFile): HTMLLIElement {
  const row = document.createElement("li");
  const status = document.createElement("span");
  const path = document.createElement("span");
  const name = document.createElement("span");
  status.className = "status";
  status.textContent = file.status;
  status.title = statusDescription(file.status);
  status.dataset.kind = statusKind(file.status);
  path.className = "path";
  path.title = file.path;
  name.className = "name";
  const separator = file.path.lastIndexOf("/");
  name.textContent = file.path.slice(separator + 1);
  path.append(name);
  if (separator >= 0) {
    const directory = document.createElement("span");
    directory.className = "directory";
    directory.textContent = file.path.slice(0, separator);
    path.append(directory);
  }
  row.append(status, path);
  return row;
}

let previousFiles: string | undefined;
function render(data: GitPaneState): void {
  const ready = isGitPaneData(data);
  repository.hidden = !ready;
  files.hidden = !ready;
  refresh.disabled = !ready;
  empty.hidden = !ready || data.total !== 0;
  count.textContent = ready ? String(data.total) : "";
  summary.textContent =
    ready && data.total > data.files.length
      ? `Showing ${data.files.length} of ${data.total} files`
      : "";
  if (!ready) return;
  branch.textContent = data.branch;
  branch.title = data.branch;
  root.textContent = data.root;
  root.title = data.root;
  const serialized = JSON.stringify(data.files);
  if (serialized === previousFiles) return;
  previousFiles = serialized;
  const rows = document.createDocumentFragment();
  for (const file of data.files) rows.append(fileRow(file));
  files.replaceChildren(rows);
}

refresh.addEventListener("click", () =>
  window.ghostty.send({ action: "refresh" }),
);
window.ghostty.onState(({ data }) => render(data));
