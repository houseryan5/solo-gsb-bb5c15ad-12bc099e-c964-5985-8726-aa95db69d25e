"""Epoch-millisecond time helpers."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

ISO_RE = re.compile(
    r"^(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})[T ](?P<H>\d{2}):(?P<M>\d{2}):"
    r"(?P<S>\d{2})(?P<frac>\.\d+)?(?P<tz>Z|[+-]\d{2}:?\d{2})?$"
)


def now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def ms_to_iso(ms: int | float) -> str:
    """Epoch ms -> ISO-8601 UTC string with millisecond precision."""
    dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


def parse_time(value: object) -> int:
    """Parse epoch ms (int/float) or ISO-8601 string to epoch milliseconds."""
    if isinstance(value, bool):
        raise ValueError(f"unsupported time value: {value!r}")
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        raise ValueError(f"unsupported time value: {value!r}")

    s = value.strip()
    if s.isdigit() or (s.startswith("-") and s[1:].isdigit()):
        return int(s)

    m = ISO_RE.match(s)
    if not m:
        raise ValueError(f"unparseable ISO time: {value!r}")

    tz = m.group("tz")
    if tz in (None, "Z"):
        tzinfo = timezone.utc
    else:
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        offset_min = int(digits[:2]) * 60 + int(digits[2:4])
        tzinfo = timezone(timedelta(minutes=sign * offset_min))

    frac = m.group("frac") or ""
    microsecond = int((frac + "000000")[1:7]) if frac else 0
    dt = datetime(
        int(m.group("y")), int(m.group("m")), int(m.group("d")),
        int(m.group("H")), int(m.group("M")), int(m.group("S")),
        microsecond=microsecond, tzinfo=tzinfo,
    )
    return int(dt.timestamp() * 1000)
