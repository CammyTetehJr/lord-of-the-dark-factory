"""Public-mode protections: access code and run limits."""
import pytest
from fastapi.testclient import TestClient

import factory.server as server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "ACCESS_CODE", "s3cret")
    return TestClient(server.app, follow_redirects=False)


def test_api_refused_without_code(client):
    assert client.get("/api/line").status_code == 401
    assert client.get("/api/line?code=wrong").status_code == 401
    assert client.get("/").status_code == 401


def test_code_link_sets_cookie_and_unlocks(client):
    r = client.get("/?code=s3cret")
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert "df_access=s3cret" in r.headers["set-cookie"]
    assert client.get("/api/line").status_code == 200  # cookie now carried by the client


def test_open_when_no_code_configured(monkeypatch):
    monkeypatch.setattr(server, "ACCESS_CODE", "")
    assert TestClient(server.app).get("/api/line").status_code == 200


def test_hourly_cap_and_busy_line_return_429(monkeypatch):
    monkeypatch.setattr(server, "ACCESS_CODE", "")
    c = TestClient(server.app)
    monkeypatch.setattr(server, "_in_flight", server.MAX_ACTIVE + server.MAX_QUEUED)
    r = c.post("/api/runs", json={"bug_id": "bug1"})
    assert r.status_code == 429 and "busy" in r.json()["detail"]
    monkeypatch.setattr(server, "_in_flight", 0)
    monkeypatch.setattr(server, "MAX_PER_HOUR", 0)
    r = c.post("/api/runs", json={"bug_id": "bug1"})
    assert r.status_code == 429 and "Hourly limit" in r.json()["detail"]


def test_unknown_fixer_rejected(monkeypatch):
    monkeypatch.setattr(server, "ACCESS_CODE", "")
    r = TestClient(server.app).post("/api/runs", json={"bug_id": "bug1", "fixer": "rm -rf /"})
    assert r.status_code == 400
