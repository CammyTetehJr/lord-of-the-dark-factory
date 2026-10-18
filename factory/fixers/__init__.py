from factory.fixers.base import Fixer
from factory.fixers.reference import ReferenceFixer
from factory.fixers.rogue import ROGUE_MODES, RogueFixer


def get_fixer(spec: str) -> Fixer:
    """'reference' or 'rogue:<mode>'."""
    if spec == "reference":
        return ReferenceFixer()
    if spec.startswith("rogue:"):
        return RogueFixer(spec.split(":", 1)[1])
    raise ValueError(f"unknown fixer {spec!r}; use 'reference' or 'rogue:<{'|'.join(ROGUE_MODES)}>'")


__all__ = ["Fixer", "get_fixer"]
