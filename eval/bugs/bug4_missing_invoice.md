# Server error when opening an invoice that doesn't exist

`GET /invoices/9999` returns a 500 Internal Server Error. It should say the invoice was not found.
