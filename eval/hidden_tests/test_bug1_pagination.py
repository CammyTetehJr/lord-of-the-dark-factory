from tests.conftest import make_invoice


def test_pages_do_not_overlap(client, customer):
    for _ in range(5):
        make_invoice(client, customer["id"])
    p1 = client.get("/invoices", params={"page": 1, "page_size": 2}).json()
    p2 = client.get("/invoices", params={"page": 2, "page_size": 2}).json()
    p3 = client.get("/invoices", params={"page": 3, "page_size": 2}).json()
    assert len(p1["items"]) == 2
    assert len(p2["items"]) == 2
    ids = [i["id"] for p in (p1, p2, p3) for i in p["items"]]
    assert len(ids) == len(set(ids)) == 5
    assert p3["has_more"] is False
