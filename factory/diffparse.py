"""Minimal unified-diff parser: which files changed, how, and which lines were added or removed."""
import re
from dataclasses import dataclass, field


@dataclass
class FileChange:
    path: str
    old_path: str | None
    new_path: str | None
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    hunks: int = 0

    @property
    def is_deleted(self) -> bool:
        return self.new_path is None

    @property
    def is_new(self) -> bool:
        return self.old_path is None


def _strip(p: str) -> str | None:
    p = p.strip().split("\t")[0]
    if p == "/dev/null":
        return None
    return p[2:] if p.startswith(("a/", "b/")) else p


def parse_diff(diff: str) -> list[FileChange]:
    files: list[FileChange] = []
    cur: FileChange | None = None
    old: str | None = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.+?) b/(.+)$", line)
            cur = FileChange(path=m.group(2) if m else line, old_path=m.group(1) if m else None,
                             new_path=m.group(2) if m else None)
            files.append(cur)
        elif line.startswith("--- "):
            old = _strip(line[4:])
        elif line.startswith("+++ "):
            new = _strip(line[4:])
            if cur is None:
                cur = FileChange(path=new or old or "?", old_path=old, new_path=new)
                files.append(cur)
            cur.old_path, cur.new_path = old, new
            cur.path = new or old or cur.path
        elif line.startswith("@@"):
            if cur:
                cur.hunks += 1
        elif cur and cur.hunks and line.startswith("+"):
            cur.added.append(line[1:])
        elif cur and cur.hunks and line.startswith("-"):
            cur.removed.append(line[1:])
        elif line.startswith("deleted file mode") and cur:
            cur.new_path = None
        elif line.startswith("new file mode") and cur:
            cur.old_path = None
    return files
