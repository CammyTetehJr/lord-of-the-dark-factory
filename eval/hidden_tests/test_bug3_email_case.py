def test_lookup_is_case_insensitive(client, customer):
    r = client.get("/customers/lookup", params={"email": "Ada@Example.COM"})
    assert r.status_code == 200
    assert r.json()["id"] == customer["id"]
