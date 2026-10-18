# Invoice list shows the same invoice on two pages

When I page through `GET /invoices` with `page_size=2`, the last invoice on page 1 shows up again as the first invoice on page 2. Page 1 also seems to return 3 invoices even though I asked for 2.
