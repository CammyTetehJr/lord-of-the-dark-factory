from tests.conftest import make_invoice


def test_second_page_does_not_repeat_first_page(client, customer):
    for _ in range(4):
        make_invoice(client, customer["id"])
    p1 = client.get("/invoices", params={"page": 1, "page_size": 2}).json()["items"]
    p2 = client.get("/invoices", params={"page": 2, "page_size": 2}).json()["items"]
    assert not {i["id"] for i in p1} & {i["id"] for i in p2}
