"""Nemotron on Nebius Token Factory (OpenAI-compatible). Every call returns enough metadata
to put in the audit trail: model, prompt hash, token usage, latency."""
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI

from factory.config import ROOT

BASE_URL = os.environ.get("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1")

MODELS = {
    "fast": os.environ.get("FACTORY_MODEL_FAST", "nvidia/Nemotron-3_5-Lightning"),
    "main": os.environ.get("FACTORY_MODEL_MAIN", "nvidia/nemotron-3-super-120b-a12b"),
    "review": os.environ.get("FACTORY_MODEL_REVIEW", "nvidia/Nemotron-3-Ultra-550b-a55b"),
}


def _load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass
class LLMResult:
    content: str
    model: str
    prompt_sha256: str
    prompt_tokens: int | None
    completion_tokens: int | None
    seconds: float

    def meta(self) -> dict:
        return {"model": self.model, "prompt_sha256": self.prompt_sha256, "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens, "seconds": self.seconds}


_client: OpenAI | None = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _load_env()
        key = os.environ.get("NEBIUS_API_KEY")
        if not key or key == "paste-your-key-here":
            raise RuntimeError("NEBIUS_API_KEY is not set (put it in .env)")
        _client = OpenAI(base_url=BASE_URL, api_key=key, max_retries=3, timeout=300)
    return _client


def chat(role: str, messages: list[dict], max_tokens: int = 8000, temperature: float = 0.6) -> LLMResult:
    model = MODELS[role]
    prompt_sha = hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()
    started = time.monotonic()
    resp = client().chat.completions.create(model=model, messages=messages, max_tokens=max_tokens,
                                            temperature=temperature)
    usage = resp.usage
    return LLMResult(
        content=resp.choices[0].message.content or "",
        model=model,
        prompt_sha256=prompt_sha,
        prompt_tokens=usage.prompt_tokens if usage else None,
        completion_tokens=usage.completion_tokens if usage else None,
        seconds=round(time.monotonic() - started, 2),
    )


def extract_code(text: str, lang: str = "python") -> str | None:
    """Longest fenced code block of the given language (or unlabeled)."""
    blocks = re.findall(rf"```(?:{lang})?[ \t]*\n(.*?)```", text, re.S)
    if blocks:
        return max(blocks, key=len).strip() + "\n"
    # some replies skip the fence; accept them if they plainly start as a Python file
    stripped = text.strip()
    if lang == "python" and re.match(r"(from |import |def |\"\"\"|#)", stripped):
        return stripped + "\n"
    return None


def repo_context(repo: Path, include: list[str], max_chars: int = 60000) -> str:
    """File tree plus the contents of the files matching `include` globs."""
    files = sorted(p for p in repo.rglob("*") if p.is_file() and not any(
        part.startswith(".") or part in ("__pycache__",) for part in p.relative_to(repo).parts))
    tree = "\n".join(str(p.relative_to(repo)) for p in files)
    chunks, total = [], 0
    for pattern in include:
        for p in sorted(repo.glob(pattern)):
            if not p.is_file():
                continue
            body = f"### {p.relative_to(repo)}\n```\n{p.read_text()}\n```\n"
            if total + len(body) > max_chars:
                break
            chunks.append(body)
            total += len(body)
    return f"## Repository files\n{tree}\n\n## Source\n" + "".join(dict.fromkeys(chunks))
