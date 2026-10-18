from tests.conftest import make_invoice


def test_percentage_discount_applied(client, customer):
    body = make_invoice(client, customer["id"], discount_pct=10, tax_rate=0.19).json()
    assert body["discounted_cents"] == 9000
    assert body["total_cents"] == 10710


def test_discount_survives_reload(client, customer):
    created = make_invoice(client, customer["id"], discount_pct=25, tax_rate=0).json()
    body = client.get(f"/invoices/{created['id']}").json()
    assert body["total_cents"] == 7500
