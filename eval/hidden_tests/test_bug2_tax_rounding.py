from app.pricing import compute_totals
from tests.conftest import make_invoice


def test_tax_rounded_on_subtotal_not_per_line():
    lines = [{"quantity": 1, "unit_price_cents": 5}] * 3
    totals = compute_totals(lines, 0, 0.10)
    assert totals["tax_cents"] == 2
    assert totals["total_cents"] == 17


def test_invoice_total_via_api(client, customer):
    lines = [{"description": f"item {i}", "quantity": 1, "unit_price_cents": 5} for i in range(3)]
    body = make_invoice(client, customer["id"], lines=lines, tax_rate=0.10).json()
    assert body["total_cents"] == 17
