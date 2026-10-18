# Some invoice creations fail randomly during busy periods

During month-end batch runs, a few `POST /invoices` calls fail with a 500 error. Retrying the same request usually works. We can't reproduce it reliably on a single request.
