from tests.conftest import make_invoice


def test_ten_percent_discount_on_100_eur(client, customer):
    body = make_invoice(client, customer["id"], discount_pct=10, tax_rate=0).json()
    assert body["discounted_cents"] == 9000
