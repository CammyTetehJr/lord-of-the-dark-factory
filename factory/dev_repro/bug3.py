def test_lookup_with_capitalised_email(client, customer):
    r = client.get("/customers/lookup", params={"email": "Ada@Example.com"})
    assert r.status_code == 200
