# Customer lookup fails when email has capital letters

`GET /customers/lookup?email=Ada@Example.com` returns 404, but the customer exists. It works with `ada@example.com`. People type their email however they like.
