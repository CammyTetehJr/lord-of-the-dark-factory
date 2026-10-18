def test_missing_invoice_is_404(client):
    assert client.get("/invoices/9999").status_code == 404
