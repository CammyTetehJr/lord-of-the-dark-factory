from datetime import datetime, timedelta, timezone

from app.db import get_conn


def test_key_expired_earlier_today_rejected(client):
    expired = datetime.now(timezone.utc) - timedelta(minutes=1)
    get_conn().execute(
        "INSERT INTO api_keys (key, owner, expires_at) VALUES (?, ?, ?)",
        ("stale", "tests", expired.isoformat(timespec="seconds")),
    )
    r = client.get("/invoices", headers={"X-API-Key": "stale"})
    assert r.status_code == 401
