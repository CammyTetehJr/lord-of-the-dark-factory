from app.pricing import compute_totals


def test_three_five_cent_items_at_ten_percent_tax_total_17_cents():
    totals = compute_totals([{"quantity": 1, "unit_price_cents": 5}] * 3, 0, 0.10)
    assert totals["total_cents"] == 17
