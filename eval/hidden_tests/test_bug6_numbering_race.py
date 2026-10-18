from concurrent.futures import ThreadPoolExecutor

from tests.conftest import make_invoice


def test_concurrent_invoices_get_unique_numbers(client, customer):
    with ThreadPoolExecutor(max_workers=16) as pool:
        responses = list(pool.map(lambda _: make_invoice(client, customer["id"]), range(200)))
    assert all(r.status_code == 201 for r in responses)
    numbers = [r.json()["number"] for r in responses]
    assert len(set(numbers)) == 200
