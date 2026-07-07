# SQL Queries Reference

This document contains all PostgreSQL queries used by the odoo api for get end points.
Each query is documented with its purpose, parameters, and the tables it touches.

<!-- Database: ecommers
Host: localhost:2415
User: odoo -->

---

## Authentication

Every endpoint validates the X-API-Key header before executing any business logic.
The key is looked up in the threeclick_api table. If not found or expired, the request is rejected.

Tables: threeclick_api

```sql
SELECT api_key_expiration
FROM threeclick_api
WHERE api_key = $1
LIMIT 1;
```

Parameters:
  $1 — value of the X-API-Key request header

Logic:
  - No row found         → 403 Invalid API Key
  - api_key_expiration is set and is in the past → 403 API Key has expired
  - Otherwise            → proceed to handler

---

## Endpoint 1 — GET /api/v1/wishlist/{user_id}

Returns a paginated list of wishlist items for a user, including product details,
average rating, discount pricing, and loyalty program information.

Query parameters: page, per_page, min_price, max_price, order, high_to_low

---

### 1.1 Resolve user to internal partner ID

Tables: res_partner

```sql
SELECT id
FROM res_partner
WHERE app_user_id = $1
LIMIT 1;
```

Parameters:
  $1 — user_id from URL path

Returns: internal integer ID of the res.partner record.
Error: 404 if no row found.

---

### 1.2 Total count for pagination

Tables: wishlist

```sql
SELECT COUNT(*)
FROM wishlist wl
WHERE wl.user_id = $1
  AND wl.is_active = TRUE
  AND wl.ecommerce_float_price >= $2
  AND wl.ecommerce_float_price <= $3;
```

Parameters:
  $1 — partner ID from query 1.1
  $2 — min_price (default 0)
  $3 — max_price (default 10000000)

---

### 1.3 Main wishlist items query

Tables: wishlist, product_template, res_company, product_review,
        product_product, product_discount, loyalty_program, loyalty_reward

```sql
SELECT
    wl.id,
    pt.id                                                          AS product_id,

    -- product name extracted from JSONB (Odoo stores multilang names as JSON)
    COALESCE(pt.name->>'en_US', pt.name::text)                    AS name,

    -- average rating computed from all reviews for this product template
    (
        SELECT AVG(rating::numeric)
        FROM product_review pr
        WHERE pr.product_template = pt.id
    )                                                              AS avg_rating,

    -- count of all reviews for this product template
    (
        SELECT COUNT(*)
        FROM product_review pr
        WHERE pr.product_template = pt.id
    )                                                              AS total_review,

    -- count of active product variants
    (
        SELECT COUNT(*)
        FROM product_product pp
        WHERE pp.product_tmpl_id = pt.id AND pp.active = TRUE
    )                                                              AS total_variants,

    wl.ecommerce_float_price                                       AS price,

    -- merchant slug used to build the product image URL
    COALESCE(rc.merchant, '')                                      AS merchant,

    -- discounted price: product-level discounts take priority over loyalty programs.
    -- returns the post-discount price, null if no active discount exists.
    COALESCE(
        (
            SELECT SUM(
                CASE WHEN d.discount_type = 'percentage'
                    THEN ROUND((wl.ecommerce_float_price - wl.ecommerce_float_price * d.discount_value / 100)::numeric, 2)
                    ELSE ROUND((wl.ecommerce_float_price - d.discount_value)::numeric, 2)
                END
            )
            FROM product_discount d
            WHERE d.product_tmpl_id = pt.id
              AND d.is_active = TRUE
              AND d.company_id IS NOT NULL
              AND d.x_superapp_approval_status = 'approved'
              AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
              AND (d.end_date   IS NULL OR d.end_date   >= CURRENT_DATE)
        ),
        (
            SELECT ROUND((
                CASE WHEN lr.discount_mode = 'percent'
                    THEN wl.ecommerce_float_price - wl.ecommerce_float_price * lr.discount / 100
                    ELSE wl.ecommerce_float_price - lr.discount
                END
            )::numeric, 2)
            FROM loyalty_program lp
            JOIN loyalty_reward lr ON lr.program_id = lp.id
            WHERE lp.company_id = pt.company_id
              AND lp.is_ecommerce = TRUE
              AND lp.x_superapp_approval_status = 'approved'
              AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
              AND (lp.date_to   IS NULL OR lp.date_to   >= CURRENT_DATE)
            LIMIT 1
        )
    )                                                              AS discounts,

    -- loyalty_programs JSON array: product discounts returned first,
    -- falls back to loyalty program rewards if no product discount exists.
    COALESCE(
        (
            SELECT json_agg(json_build_object(
                'name',           d.name,
                'discount_type',  INITCAP(d.discount_type),
                'discount_value', d.discount_value::text,
                'start_date',     TO_CHAR(d.start_date, 'DD/MM/YY'),
                'end_date',       TO_CHAR(d.end_date, 'DD/MM/YY')
            ))
            FROM product_discount d
            WHERE d.product_tmpl_id = pt.id
              AND d.is_active = TRUE
              AND d.company_id IS NOT NULL
              AND d.x_superapp_approval_status = 'approved'
              AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
              AND (d.end_date   IS NULL OR d.end_date   >= CURRENT_DATE)
        ),
        (
            SELECT json_agg(json_build_object(
                'name',           lp.name->>'en_US',
                'discount_type',  CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
                'discount_value', lr.discount::text,
                'start_date',     TO_CHAR(lp.date_from, 'DD/MM/YY'),
                'end_date',       TO_CHAR(lp.date_to, 'DD/MM/YY')
            ))
            FROM loyalty_program lp
            JOIN loyalty_reward lr ON lr.program_id = lp.id
            WHERE lp.company_id = pt.company_id
              AND lp.is_ecommerce = TRUE
              AND lp.x_superapp_approval_status = 'approved'
              AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
              AND (lp.date_to   IS NULL OR lp.date_to   >= CURRENT_DATE)
            LIMIT 1
        )
    )                                                              AS loyalty_programs

FROM wishlist wl
JOIN product_template pt ON pt.id = wl.product_id
LEFT JOIN res_company rc  ON rc.id = pt.company_id
WHERE wl.user_id = $1
  AND wl.is_active = TRUE
  AND wl.ecommerce_float_price >= $2
  AND wl.ecommerce_float_price <= $3
ORDER BY wl.id DESC                  -- default sort
                                     -- use wl.ecommerce_float_price DESC/ASC when price sort requested
LIMIT $4 OFFSET $5;
```

Parameters:
  $1 — partner ID
  $2 — min_price
  $3 — max_price
  $4 — per_page (page size)
  $5 — (page - 1) * per_page

Notes:
  - product_template.name is a JSONB column in Odoo 18. The ->>'en_US' operator
    extracts the English string value.
  - loyalty_program.name is also JSONB, extracted the same way.
  - uom_uom.name is JSONB in Odoo 18 (use ->>'en_US').
  - The product image URL is constructed in Go as:
    {BASE_URL}/api/v1/{merchant}/image/product.template/{product_id}

---

## Endpoint 2 — GET /api/v1/orders

Returns a paginated list of sale orders for a user. Supports filtering by merchant
and order history status (active / inactive / all).

Query parameters: app_user_id (required), page, per_page, merchant, history

---

### 2.1 Resolve user to internal partner ID

Tables: res_partner

```sql
SELECT id
FROM res_partner
WHERE app_user_id = $1
  AND active = TRUE
LIMIT 1;
```

Parameters:
  $1 — app_user_id query parameter

Error: 404 if no row found.

---

### 2.2 Resolve optional merchant to company ID

Tables: res_company

Only executed when the merchant query parameter is provided.

```sql
SELECT id
FROM res_company
WHERE merchant = $1
  AND is_delivery = FALSE
  AND merchant IS NOT NULL
LIMIT 1;
```

Parameters:
  $1 — merchant slug

Error: 404 if no row found.

---

### 2.3 Total count

Tables: sale_order

The WHERE clause is built dynamically based on the provided filters.

```sql
SELECT COUNT(*)
FROM sale_order so
WHERE so.partner_id = $1
  AND so.is_superapp_order = TRUE

  -- added when merchant filter is provided:
  -- AND so.company_id = $2

  -- added when history=active:
  -- AND so.superapp_order_status NOT IN ('cancelled', 'delivered')

  -- added when history=inactive:
  -- AND so.superapp_order_status IN ('delivered', 'cancelled')
;
```

---

### 2.4 Main orders query

Tables: sale_order, res_company, res_partner, res_country_state, res_country

```sql
SELECT
    so.id,
    so.name,
    so.state,
    so.superapp_order_status,
    so.date_order,
    ROUND(so.amount_total::numeric, 2)             AS total_price,
    so."deliveryType",
    so.driver_name,
    so.driver_mobile,
    so.driver_delivery_medium,

    rc.id                                          AS company_id,
    rc.merchant,
    rc.name                                        AS company_name,
    rc.logo_web IS NOT NULL                        AS has_logo,
    rc.lat_location,
    rc.lng_location,
    rc.phone                                       AS company_phone,

    -- address fields come from res_partner linked to the company
    rp.street,
    rp.city,
    rs.name                                        AS state_name,
    rco.name->>'en_US'                             AS country_name,

    -- parent company name (used to determine merchant vs branch display)
    rcp.name                                       AS parent_name

FROM sale_order so
LEFT JOIN res_company       rc  ON rc.id   = so.company_id
LEFT JOIN res_partner       rp  ON rp.id   = rc.partner_id
LEFT JOIN res_country_state rs  ON rs.id   = rp.state_id
LEFT JOIN res_country       rco ON rco.id  = rp.country_id
LEFT JOIN res_company       rcp ON rcp.id  = rc.parent_id
WHERE so.partner_id = $1
  AND so.is_superapp_order = TRUE
ORDER BY so.id DESC
LIMIT $2 OFFSET $3;
```

Parameters:
  $1 — partner ID
  $2 — per_page
  $3 — offset

Notes:
  - res_country.name is JSONB in Odoo 18, extracted with ->>'en_US'.
  - res_country_state.name is a plain varchar.
  - location is assembled in Go as: street, city, state (or "False" if null), country.
  - phone is formatted in Go: "+251" replaced with "0", spaces removed.
  - driver_info is only populated in the response when deliveryType = 'delivery'.
  - date_order is formatted in Go as "2006-01-02 15:04:05" UTC.

---

### 2.5 Order lines (batched for all orders in one query)

Tables: sale_order_line, product_product, product_template, uom_uom,
        sale_order, res_company, product_variant_combination,
        product_template_attribute_value, product_attribute_value, product_attribute

Fetches lines for multiple orders in a single round-trip to avoid N+1 queries.

```sql
SELECT
    sol.id,
    sol.order_id,
    sol.product_id,

    -- build display name: template name + variant attributes in parentheses
    -- e.g. "Loreal Elvive Break-Proof Conditioner 400ml (Red, Large)"
    CASE
        WHEN attrs.attributes IS NOT NULL
            THEN CONCAT(pt.name->>'en_US', ' (', attrs.attributes, ')')
        ELSE pt.name->>'en_US'
    END                                            AS product_name,

    sol.product_uom_qty,
    u.name->>'en_US'                               AS uom_name,
    ROUND(sol.price_unit::numeric, 2),
    ROUND(sol.price_total::numeric, 2),
    rc.merchant                                    AS company_merchant

FROM sale_order_line sol
LEFT JOIN product_product pp  ON pp.id  = sol.product_id
LEFT JOIN product_template pt ON pt.id  = pp.product_tmpl_id
LEFT JOIN uom_uom u           ON u.id   = sol.product_uom
LEFT JOIN sale_order so       ON so.id  = sol.order_id
LEFT JOIN res_company rc      ON rc.id  = so.company_id

-- pre-aggregate variant attribute labels for all relevant products
LEFT JOIN (
    SELECT
        pvc.product_product_id,
        string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
    FROM product_variant_combination pvc
    JOIN product_template_attribute_value ptav
        ON ptav.id = pvc.product_template_attribute_value_id
    JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
    JOIN product_attribute pa        ON pa.id  = pav.attribute_id
    WHERE pvc.product_product_id IN (
        SELECT DISTINCT product_id
        FROM sale_order_line
        WHERE order_id IN ($1, $2, ...)   -- one placeholder per order ID
    )
    GROUP BY pvc.product_product_id
) attrs ON attrs.product_product_id = pp.id

WHERE sol.order_id IN ($1, $2, ...);      -- same placeholders repeated
```

Notes:
  - The IN placeholders are generated dynamically in Go for the set of fetched order IDs.
  - The product image URL is built in Go as:
    {BASE_URL}/api/v1/{merchant}/image/product.product/{product_id}

---

## Endpoint 3 — GET /api/v1/{merchant}/orders/{order_id}/status

Returns full status detail for a single sale order belonging to the given merchant.

---

### 3.1 Resolve merchant company and address

Tables: res_company, res_partner, res_country_state, res_country

Two sequential queries: first fetch company info, then fetch the address
via the company's linked res_partner record.

```sql
-- Step 1: company info
SELECT
    rc.id,
    rc.name,
    rc.merchant,
    rc.logo_web IS NOT NULL    AS has_logo,
    rc.lat_location,
    rc.lng_location,
    rc.phone,
    rc.partner_id
FROM res_company rc
WHERE rc.merchant = $1
  AND rc.is_delivery = FALSE
  AND rc.merchant IS NOT NULL
LIMIT 1;
```

Parameters:
  $1 — merchant slug from URL path

Error: 404 if no row found.

```sql
-- Step 2: address via partner (only runs when partner_id is set)
SELECT
    rp.street,
    rp.city,
    rs.name                    AS state_name,
    rco.name->>'en_US'         AS country_name
FROM res_partner rp
LEFT JOIN res_country_state rs ON rs.id  = rp.state_id
LEFT JOIN res_country rco      ON rco.id = rp.country_id
WHERE rp.id = $1;
```

Parameters:
  $1 — partner_id from step 1

---

### 3.2 Fetch order with delivery price

Tables: sale_order, product_product, product_template, res_company

The delivery_price field is not stored on sale_order. It is a computed field in Odoo
derived from sale_order.delivery_product_id → product_product.ecommerce_float_price
where the product belongs to a company with is_delivery = TRUE.

amount_total in the response = sale_order.amount_total + delivery_price,
matching Odoo's total_with_delivery_price logic.

```sql
SELECT
    so.id,
    so.name,
    so.state,
    so.superapp_order_status,

    -- total including delivery charge (mirrors Odoo's total_with_delivery_price)
    ROUND((so.amount_total + COALESCE(dp.ecommerce_float_price, 0))::numeric, 2) AS amount_total,

    so.invoice_status,
    so.lock_id,
    so.ft_reference,
    so.delivery_lat,
    so.delivery_long,
    so.customer_pickup_code,
    so.driver_name,
    so.driver_mobile,
    so.driver_delivery_medium,
    so."deliveryType",
    so.date_order,

    -- delivery price resolved from the delivery product on the delivery company
    dp.ecommerce_float_price   AS delivery_price

FROM sale_order so

-- join delivery product: delivery_product_id is stored as varchar in DB
LEFT JOIN product_product dp
       ON dp.id = so.delivery_product_id::integer
      AND so.delivery_product_id IS NOT NULL
      AND so.delivery_product_id != '0'
LEFT JOIN product_template dpt ON dpt.id = dp.product_tmpl_id
LEFT JOIN res_company drc      ON drc.id = dpt.company_id AND drc.is_delivery = TRUE

WHERE so.id = $1
  AND so.company_id = $2
  AND so.is_superapp_order = TRUE
LIMIT 1;
```

Parameters:
  $1 — order_id from URL path
  $2 — company ID from query 3.1

Notes:
  - ft_reference is serialized as JSON false (boolean) when empty, not null.
    This matches the Odoo Python response behavior.
  - delivery_product_id is a varchar column storing an integer string.
    Cast to integer is required for the join.

---

### 3.3 Delivery count

Tables: stock_picking

```sql
SELECT COUNT(*)
FROM stock_picking
WHERE sale_id = $1;
```

Parameters:
  $1 — internal order ID from query 3.2

---

### 3.4 Order lines

Tables: sale_order_line, product_product, product_template, uom_uom,
        product_variant_combination, product_template_attribute_value,
        product_attribute_value, product_attribute

Uses sol.name (the stored line description) as primary product name since Odoo
writes the variant display name into that field at order confirmation time.
Falls back to computing the name from product_template + attributes if sol.name is null.

```sql
SELECT
    sol.id,
    sol.product_id,

    -- prefer the stored line description (set by Odoo at order time),
    -- fall back to computing from template name + variant attributes
    COALESCE(sol.name,
        CASE
            WHEN attrs.attributes IS NOT NULL
                THEN CONCAT(pt.name->>'en_US', ' (', attrs.attributes, ')')
            ELSE pt.name->>'en_US'
        END
    )                                              AS product_name,

    sol.product_uom_qty,
    u.name->>'en_US'                               AS uom_name,

    -- price_unit intentionally not rounded: Odoo returns the raw float
    -- (e.g. 225.00000000000003) and clients may depend on this value
    sol.price_unit,
    ROUND(sol.price_total::numeric, 2)

FROM sale_order_line sol
LEFT JOIN product_product pp  ON pp.id  = sol.product_id
LEFT JOIN product_template pt ON pt.id  = pp.product_tmpl_id
LEFT JOIN uom_uom u           ON u.id   = sol.product_uom
LEFT JOIN (
    SELECT
        pvc.product_product_id,
        string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
    FROM product_variant_combination pvc
    JOIN product_template_attribute_value ptav
        ON ptav.id = pvc.product_template_attribute_value_id
    JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
    JOIN product_attribute pa        ON pa.id  = pav.attribute_id
    WHERE pvc.product_product_id IN (
        SELECT DISTINCT product_id FROM sale_order_line WHERE order_id = $1
    )
    GROUP BY pvc.product_product_id
) attrs ON attrs.product_product_id = pp.id
WHERE sol.order_id = $1;
```

Parameters:
  $1 — internal order ID

---

## Endpoint 4 — GET /api/v1/product/{product_id}/reviews

Returns paginated reviews for a product template, including all replies per review.

Query parameters: page, per_page (set per_page=0 to return all reviews)

---

### 4.1 Check product exists

Tables: product_template

```sql
SELECT EXISTS(
    SELECT 1 FROM product_template WHERE id = $1
);
```

Parameters:
  $1 — product_id from URL path

Error: 404 if false.

---

### 4.2 Total review count

Tables: product_review

```sql
SELECT COUNT(*)
FROM product_review
WHERE product_template = $1;
```

Parameters:
  $1 — product_id

Note: product_review.product_template stores the product_template ID.
Reviews are linked at the template level, not the variant level.

---

### 4.3 Fetch reviews

Tables: product_review, res_partner

```sql
SELECT
    pr.id,
    COALESCE(rp.name, 'Anonymous')             AS user_name,
    rp.app_user_id,
    pr.rating,
    COALESCE(pr.review, '')                    AS review,

    -- TMMonth suppresses PostgreSQL padding (avoids "09 June      2026")
    TO_CHAR(pr.create_date, 'DD TMMonth YYYY') AS create_date

FROM product_review pr
LEFT JOIN res_partner rp ON rp.id = pr.user_id
WHERE pr.product_template = $1
ORDER BY pr.id DESC
LIMIT $2 OFFSET $3;
-- LIMIT and OFFSET are omitted when per_page=0 (return all reviews)
```

Parameters:
  $1 — product_id
  $2 — per_page
  $3 — (page - 1) * per_page

Notes:
  - rating is stored as varchar in product_review. Parsed to int in Go.
  - user_id in the response is the app_user_id string if set, or JSON false if null/empty.
  - TMMonth is the PostgreSQL translation-mode month format that produces
    unpadded month names ("June" not "June     ").

---

### 4.4 Fetch replies (batched for all reviews)

Tables: review_reply, res_partner

All replies for the current page of reviews are fetched in a single query
to avoid N+1 database calls.

```sql
SELECT
    rr.review_id,
    COALESCE(rp.name, 'Dev Team')                  AS reply_from,
    COALESCE(rr.reply, '')                         AS reply,
    TO_CHAR(rr.create_date, 'DD TMMonth YYYY')     AS reply_date

FROM review_reply rr
LEFT JOIN res_partner rp ON rp.id = rr.user_id
WHERE rr.review_id IN ($1, $2, ...)
ORDER BY rr.id ASC;
```

Parameters:
  $1, $2, ... — IDs of the reviews returned in query 4.3
                (one placeholder per review ID, generated dynamically)

---

## Table Reference

| Table                             | Description                                      |
|-----------------------------------|--------------------------------------------------|
| res_partner                       | Customers and contacts. app_user_id links to app |
| res_company                       | Merchant companies. merchant = slug, is_delivery = delivery company flag |
| wishlist                          | User wishlist items                              |
| product_template                  | Product definitions. name is JSONB               |
| product_product                   | Product variants                                 |
| product_review                    | Customer reviews linked to product_template      |
| review_reply                      | Replies to reviews                               |
| product_discount                  | Product-level discounts                          |
| loyalty_program                   | Loyalty / promo programs. name is JSONB          |
| loyalty_reward                    | Rewards belonging to a loyalty_program           |
| sale_order                        | Sale orders. deliveryType is quoted (mixed case) |
| sale_order_line                   | Order line items                                 |
| stock_picking                     | Delivery pickings linked to sale orders          |
| uom_uom                           | Units of measure. name is JSONB                  |
| product_variant_combination       | Maps variants to their attribute values          |
| product_template_attribute_value  | Attribute value assignments on templates         |
| product_attribute_value           | Attribute values. name is JSONB                  |
| product_attribute                 | Attributes (Color, Size, etc.)                   |
| threeclick_api                    | API keys for authentication                      |

---

## JSONB Name Columns

Several Odoo 18 tables store translatable string fields as JSONB rather than varchar.
Always use `->>'en_US'` to extract the English string value. Tables affected:

- `product_template.name`
- `loyalty_program.name`
- `uom_uom.name`
- `product_attribute_value.name`
- `product_attribute.name`
- `res_country.name`

---

## Endpoint 5 — GET /api/v1/driver

Returns real-time driver and delivery tracking information for a specific sale order.
Used by the mobile app to display driver location, contact details, and pickup code
during active deliveries.

Query parameters: order_id (required), merchant (required)

---

### 5.1 Resolve merchant company

Tables: res_company

```sql
SELECT id, name, merchant
FROM res_company
WHERE merchant = $1
  AND is_delivery = FALSE
  AND merchant IS NOT NULL
LIMIT 1;
```

Parameters:
  $1 — merchant slug from query parameter

Error: 404 if no row found.

---

### 5.2 Fetch driver and delivery details

Tables: sale_order

```sql
SELECT
    so.id,
    so.name                                            AS order_ref,
    so.superapp_order_status                           AS status,
    so.driver_name,
    so.driver_mobile,
    so.driver_delivery_medium,
    so.delivery_lat,
    so.delivery_long,
    so.customer_pickup_code,
    so."deliveryType",
    so.date_order
FROM sale_order so
WHERE so.id = $1
  AND so.company_id = $2
  AND so.is_superapp_order = TRUE
LIMIT 1;
```

Parameters:
  $1 — order_id from query parameter
  $2 — company ID from query 5.1

Logic:
  - 404 if no row found
  - driver_name / driver_mobile / driver_delivery_medium may be NULL when no driver assigned yet
  - delivery_lat / delivery_long are varchar columns storing float strings
  - customer_pickup_code is the code shown to the customer for pickup orders
  - deliveryType is a quoted mixed-case column ('delivery' or 'pickup')

---

### 5.3 Response structure

```sql
-- The Go handler assembles the following JSON response:
-- {
--   "status": 200,
--   "message": "Driver info retrieved successfully",
--   "data": {
--     "order_id":              "S00123",
--     "order_status":          "out_for_delivery",
--     "driver_name":           "Abebe Kebede",
--     "driver_mobile":         "0911234567",
--     "driver_delivery_medium":"motorcycle",
--     "delivery_lat":          "9.0192",
--     "delivery_long":         "38.7525",
--     "customer_pickup_code":  "4821",
--     "delivery_type":         "delivery"
--   }
-- }
--
-- driver_mobile is formatted: +251 prefix → 0, spaces removed
-- driver_name / driver_mobile are null when no driver is assigned
-- delivery_lat / delivery_long are null for pickup orders
-- customer_pickup_code is null for delivery orders
```

Notes:
  - This endpoint is unauthenticated from the driver app perspective but
    still requires the X-API-Key header like all other endpoints.
  - deliveryType = 'pickup' → customer_pickup_code is populated, lat/long are null.
  - deliveryType = 'delivery' → delivery_lat/long are populated, pickup_code is null.

---

## Driver Authentication (Endpoints 5, 6, 7)

Driver endpoints use a different auth mechanism than the API key routes.
The x-token header is validated against res_users.token with expiry check.
This mirrors Odoo's @driver_auth_key decorator.

Tables: res_users

```sql
SELECT ru.id, ru.partner_id, ru.token_expiration_time
FROM res_users ru
WHERE ru.token = $1
  AND ru.active = TRUE
LIMIT 1;
```

Parameters:
  $1 — value of the x-token request header

Logic:
  - No row found                                 → 401 Invalid token
  - token_expiration_time is set and in the past → 401 Token expired
  - Otherwise                                    → proceed, use partner_id for domain filters

Note: driver endpoints use x-token (lowercase), not X-API-Key.
Both headers coexist in the same service on different route groups.

---

## Endpoint 5 — GET /api/v1/driver/history

Returns all delivered orders assigned to the authenticated driver.
No pagination — returns the full history list.

Auth: x-token (driver token)

---

### 5.1 Token validation

See Driver Authentication section above.

---

### 5.2 Fetch delivered orders

Tables: delivery_order, res_partner, sale_order

```sql
SELECT
    dord.id,
    dord.name                                        AS order_name,

    -- customer name maps to pickup_from.name in the response
    COALESCE(cust.name, '')                          AS customer_name,

    -- customer street maps to pickup_from.branch, defaults to 'Welo Sefer' when empty
    COALESCE(NULLIF(cust.street, ''), 'Welo Sefer') AS customer_street,

    dord.delivery_date,

    -- status from the linked sale order via so_id
    so.superapp_order_status

FROM delivery_order dord
LEFT JOIN res_partner cust ON cust.id = dord.customer_id
LEFT JOIN sale_order so    ON so.id   = dord.so_id
WHERE dord.driver_assigned = $1
  AND dord.state = 'delivered'
ORDER BY dord.id DESC;
```

Parameters:
  $1 — partner_id from token validation

Notes:
  - delivery_order.driver_assigned stores the res_partner.id of the driver.
  - pickup_from.branch defaults to 'Welo Sefer' when customer has no street address.
  - date formatted as MM/DD/YYYY ("01/02/2006" Go format).
  - status is null when no matching sale_order found (so_id join fails).

---

## Endpoint 6 — GET /api/v1/driver/orders

Returns active delivery orders assigned to the driver (state = driver or picked).
Includes merchant info, pickup location, and product image URLs per order.

Auth: x-token (driver token)

---

### 6.1 Token validation

See Driver Authentication section above (partner_id only, no userID needed).

---

### 6.2 Fetch active orders with merchant info

Tables: delivery_order, sale_order, res_company, res_partner, res_country_state

```sql
SELECT
    dord.id,
    dord.name                                        AS order_name,
    dord.delivery_date,

    -- merchant company resolved by joining sale_order on delivery_order.name
    -- delivery_order.name matches sale_order.name (the SO reference e.g. SOKI4000004)
    sc.id                                            AS seller_company_id,
    sc.name                                          AS seller_company_name,
    sc.merchant                                      AS seller_merchant,

    -- pickup location from the merchant's res_partner address
    COALESCE(mp.street, '')                          AS merchant_street,
    COALESCE(mp.city, '')                            AS merchant_city,
    rs.name                                          AS merchant_state,

    -- order status from linked sale order
    so.superapp_order_status

FROM delivery_order dord
LEFT JOIN sale_order        so  ON so.name  = dord.name
LEFT JOIN res_company       sc  ON sc.id    = so.company_id
LEFT JOIN res_partner       mp  ON mp.id    = sc.partner_id
LEFT JOIN res_country_state rs  ON rs.id    = mp.state_id
WHERE dord.driver_assigned = $1
  AND dord.state IN ('driver', 'picked')
ORDER BY dord.id DESC;
```

Parameters:
  $1 — partner_id from token validation

Notes:
  - The merchant is resolved by matching delivery_order.name to sale_order.name,
    then following sale_order.company_id. This mirrors Odoo's logic exactly.
  - Logo URL built in Go: {BASE_URL}/api/v1/image/res.company/{id}/logo
  - res_country_state.name is varchar (not JSONB).

---

### 6.3 Batch fetch product images per order

Tables: delivery_order_line

Fetched in one query for all orders to avoid N+1.

```sql
SELECT dol.delivery_order_id, dol.product_id
FROM delivery_order_line dol
WHERE dol.delivery_order_id IN ($1, $2, ...)
ORDER BY dol.id ASC;
```

Parameters:
  $1, $2, ... — delivery_order IDs from query 6.2

Notes:
  - Product image URL built in Go: {BASE_URL}/api/v1/image/product.product/{id}/image_1920
  - items.number = count of lines, items.images = array of image URLs.

---

## Endpoint 7 — GET /api/v1/driver/order/{order_id}

Returns full detail for a single delivery order including merchant info,
customer info, and all line items. Only accessible to the assigned driver.

Auth: x-token (driver token)

---

### 7.1 Token validation

See Driver Authentication section above.

---

### 7.2 Fetch order with merchant and customer info

Tables: delivery_order, sale_order, res_company, res_partner, res_country_state

Single query joining all required data. The WHERE clause enforces that the order
belongs to the authenticated driver (prevents cross-driver access).

```sql
SELECT
    dord.id,
    dord.name                                        AS ref_no,
    dord.delivery_date,
    dord.delivery_pickup_code,
    dord.delivery_notes,

    -- merchant: resolved via sale_order.company_id (same logic as endpoint 6)
    sc.id                                            AS company_id,
    sc.name                                          AS company_name,
    sc.phone                                         AS company_phone,
    mp.street                                        AS merchant_street,
    mp.city                                          AS merchant_city,

    -- customer info from the customer partner
    cust.name                                        AS customer_name,
    cust.phone                                       AS customer_phone,
    cust.mobile                                      AS customer_mobile,
    cust.street                                      AS customer_street,
    cust.city                                        AS customer_city,
    rs.name                                          AS customer_state,

    -- order status from sale order
    so.superapp_order_status

FROM delivery_order dord
LEFT JOIN sale_order        so   ON so.name  = dord.name
LEFT JOIN res_company       sc   ON sc.id    = so.company_id
LEFT JOIN res_partner       mp   ON mp.id    = sc.partner_id
LEFT JOIN res_partner       cust ON cust.id  = dord.customer_id
LEFT JOIN res_country_state rs   ON rs.id    = cust.state_id
WHERE dord.id = $1
  AND dord.driver_assigned = $2
LIMIT 1;
```

Parameters:
  $1 — order_id from URL path
  $2 — partner_id from token validation (enforces ownership)

Notes:
  - phone falls back to mobile when phone is empty.
  - company phone formatted in Go: "+251" replaced with "0", spaces removed.
  - pickup_location = merchant street + city joined.
  - customer.location = customer street + city + state joined.
  - Logo URL: {BASE_URL}/api/v1/image/res.company/{id}/logo

---

### 7.3 Fetch line items

Tables: delivery_order_line, product_product, product_template, uom_uom

```sql
SELECT
    dol.id,

    -- item name: prefers stored description (set at order time),
    -- falls back to product template name from JSONB
    COALESCE(dol.description, pt.name->>'en_US', '') AS item_name,

    dol.product_id,
    dol.quantity,
    COALESCE(u.name->>'en_US', '')                   AS uom_name,
    COALESCE(dol.description, '')                    AS description

FROM delivery_order_line dol
LEFT JOIN product_product pp  ON pp.id  = dol.product_id
LEFT JOIN product_template pt ON pt.id  = pp.product_tmpl_id
LEFT JOIN uom_uom u           ON u.id   = dol.uom
WHERE dol.delivery_order_id = $1
ORDER BY dol.id ASC;
```

Parameters:
  $1 — delivery_order internal ID from query 7.2

Notes:
  - Image URL: {BASE_URL}/api/v1/image/product.product/{id}/image_1920
  - uom_uom.name is JSONB (->>'en_US' required).
  - pt.name is JSONB (->>'en_US' required).

---

## Endpoint 8 — GET /api/v1/delivery_products
## Endpoint 8b — GET /api/v1/delivery_products/{prod_id}

Returns delivery service products from the delivery company.
Supports filtering by route attributes (src_location, dest_location, medium).

Auth: X-API-Key (threeclick_api table)

---

### 8.1 Resolve delivery company

Tables: res_company

```sql
SELECT id FROM res_company
WHERE is_delivery = TRUE
LIMIT 1;
```

Notes:
  - There is exactly one delivery company in the system (is_delivery = TRUE).
  - Error 404 if none configured.

---

### 8.2 List delivery products (with optional attribute filters)

Tables: product_product, product_template, product_variant_combination,
        product_template_attribute_value, product_attribute_value, product_attribute

Base conditions always applied:
  - pt.company_id = delivery company ID
  - pt.x_superapp_approval_status = 'approved'
  - pt.is_for_ecommerce = TRUE

Additional IN subquery added per filter (dest_location, src_location, medium):

```sql
SELECT
    pp.id,

    -- base product name (JSONB)
    pt.name->>'en_US'                                AS base_name,

    -- comma-separated variant attribute values for name suffix
    -- mirrors Odoo: f"{name}- {[p.name for p in variant_value_ids]}"
    COALESCE(
        (
            SELECT string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence)
            FROM product_variant_combination pvc
            JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
            JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
            JOIN product_attribute pa        ON pa.id  = pav.attribute_id
            WHERE pvc.product_product_id = pp.id
        ), ''
    )                                                AS variant_attrs,

    ROUND(pp.ecommerce_float_price::numeric, 2)      AS price

FROM product_product pp
JOIN product_template pt ON pt.id = pp.product_tmpl_id
WHERE pt.company_id = $1
  AND pt.x_superapp_approval_status = 'approved'
  AND pt.is_for_ecommerce = TRUE

  -- added dynamically per filter (example for dest_location):
  -- AND pp.id IN (
  --     SELECT pvc.product_product_id
  --     FROM product_variant_combination pvc
  --     JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
  --     JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
  --     JOIN product_attribute pa ON pa.id = pav.attribute_id
  --     WHERE LOWER(pa.name->>'en_US') = LOWER($2)   -- attribute name, e.g. 'dest_location'
  --       AND LOWER(pav.name->>'en_US') ILIKE LOWER($3)  -- value, e.g. '%Addis Abeba%'
  -- )

ORDER BY pp.id ASC;
```

Parameters:
  $1 — delivery company ID from query 8.1
  $2, $3 — attribute name and value per filter (pairs, added dynamically)

Notes:
  - Filter parameters: dest_location, src_location, medium (all optional).
  - Attribute names (pa.name) match exactly: "dest_location", "src_location", "medium".
  - Name assembled in Go as: "{base_name}- [{attr1}, {attr2}]" when attrs exist.
  - Current DB data has x_superapp_approval_status = 'pending' so results are empty
    until products are approved in the admin panel.

---

### 8.3 Single product lookup (prod_id provided)

Same base query as 8.2 with an additional `pp.id = $N` condition.
Returns shape: {product_id, name, price} instead of array.

```sql
SELECT pp.id, pt.name->>'en_US', pp.ecommerce_float_price
FROM product_product pp
JOIN product_template pt ON pt.id = pp.product_tmpl_id
WHERE pt.company_id = $1
  AND pt.x_superapp_approval_status = 'approved'
  AND pt.is_for_ecommerce = TRUE
  AND pp.id = $2
LIMIT 1;
```

Parameters:
  $1 — delivery company ID
  $2 — prod_id from URL path

---

## Updated Table Reference

| Table               | Description                                                   |
|---------------------|---------------------------------------------------------------|
| delivery_order      | Delivery assignments. driver_assigned = res_partner.id        |
| delivery_order_line | Items within a delivery order                                 |
| res_users           | Driver users. token + token_expiration_time for x-token auth  |
