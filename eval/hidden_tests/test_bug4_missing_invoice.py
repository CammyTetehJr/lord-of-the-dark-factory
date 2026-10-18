def test_unknown_invoice_returns_404(client):
    r = client.get("/invoices/9999")
    assert r.status_code == 404
