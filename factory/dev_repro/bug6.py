from concurrent.futures import ThreadPoolExecutor

from tests.conftest import make_invoice


def test_parallel_invoice_creation_never_fails(client, customer):
    with ThreadPoolExecutor(max_workers=16) as pool:
        codes = list(pool.map(lambda _: make_invoice(client, customer["id"]).status_code, range(200)))
    assert set(codes) == {201}
