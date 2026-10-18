from datetime import datetime, timedelta, timezone

from app.db import get_conn


def test_key_expired_a_minute_ago_is_rejected(client):
    expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds")
    get_conn().execute("INSERT INTO api_keys (key, owner, expires_at) VALUES ('k', 'x', ?)", (expired,))
    assert client.get("/invoices", headers={"X-API-Key": "k"}).status_code == 401
