content_to_append = """

## Endpoint 23 — GET /api/v1/wishlist/{user_id}

Returns a paginated list of wishlist items for a specific user, including product details, reviews, and active discounts (either direct product discounts or loyalty programs).

Tables: res_partner, wishlist, product_template, res_company, product_product, product_review, product_discount, loyalty_program, loyalty_reward

```sql
-- 1. Partner Resolution
SELECT id FROM res_partner WHERE app_user_id = $1 LIMIT 1;

-- 2. Total Count
SELECT COUNT(*) 
FROM wishlist wl
JOIN product_template pt ON pt.id = wl.product_id
LEFT JOIN res_company rc  ON rc.id = pt.company_id
WHERE wl.user_id = $1
  AND wl.is_active = TRUE
  AND rc.cps_enabled = TRUE
  AND wl.ecommerce_float_price >= $2
  AND wl.ecommerce_float_price <= $3
  -- AND pt.ecomerce_category_id = $4 (if category_id provided)
;

-- 3. Main Query
WITH base AS (
    SELECT
        wl.id,
        pt.id                                                         AS product_id,
        COALESCE(pt.name->>'en_US', pt.name::text)                    AS name,
        wl.ecommerce_float_price                                      AS price,
        COALESCE(rc.merchant, '')                                     AS merchant,
        pt.company_id
    FROM wishlist wl
    JOIN product_template pt ON pt.id = wl.product_id
    LEFT JOIN res_company rc  ON rc.id = pt.company_id
    WHERE wl.user_id = $1
      AND wl.is_active = TRUE
      AND rc.cps_enabled = TRUE
      AND wl.ecommerce_float_price >= $2
      AND wl.ecommerce_float_price <= $3
      -- AND pt.ecomerce_category_id = $4
    ORDER BY wl.id DESC -- or wl.ecommerce_float_price ASC/DESC
    LIMIT $4 OFFSET $5
)
SELECT
    b.id,
    b.product_id,
    b.name,
    rev.avg_rating,
    rev.total_review,
    
    (
        SELECT COUNT(*) FROM product_product pp
        WHERE pp.product_tmpl_id = b.product_id AND pp.active = TRUE
    ) AS total_variants,
    
    b.price,
    b.merchant,
    COALESCE(disc.discount_sum, loy.discount_sum)     AS discounts,
    COALESCE(disc.discount_json, loy.discount_json)   AS loyalty_programs
    
FROM base b

LEFT JOIN LATERAL (
    SELECT 
        AVG(pr.rating::numeric) AS avg_rating, 
        COUNT(pr.id)            AS total_review
    FROM product_review pr 
    WHERE pr.product_template = b.product_id
) rev ON true

LEFT JOIN LATERAL (
    SELECT 
        SUM(
            CASE WHEN d.discount_type = 'percentage'
                THEN ROUND((b.price - (b.price * d.discount_value / 100))::numeric, 2)
                ELSE ROUND((b.price - d.discount_value)::numeric, 2)
            END
        ) AS discount_sum,
        json_agg(json_build_object(
            'name',           d.name,
            'discount_type',  INITCAP(d.discount_type),
            'discount_value', CASE WHEN d.discount_value = FLOOR(d.discount_value) THEN d.discount_value::text || '.0' ELSE d.discount_value::text END,
            'start_date',     TO_CHAR(d.start_date, 'DD/MM/YY'),
            'end_date',       TO_CHAR(d.end_date, 'DD/MM/YY')
        )) AS discount_json
    FROM product_discount d
    WHERE d.product_tmpl_id = b.product_id
      AND d.is_active = TRUE
      AND d.company_id IS NOT NULL
      AND d.x_superapp_approval_status = 'approved'
      AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
      AND (d.end_date   IS NULL OR d.end_date   >= CURRENT_DATE)
) disc ON true

LEFT JOIN LATERAL (
    SELECT 
        SUM(
            ROUND((
                CASE WHEN lr.discount_mode = 'percent'
                    THEN b.price - (b.price * lr.discount / 100)
                    ELSE b.price - lr.discount
                END
            )::numeric, 2)
        ) AS discount_sum,
        json_agg(json_build_object(
            'name',           lp.name->>'en_US',
            'discount_type',  CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
            'discount_value', CASE WHEN lr.discount = FLOOR(lr.discount) THEN lr.discount::text || '.0' ELSE lr.discount::text END,
            'start_date',     TO_CHAR(lp.date_from, 'DD/MM/YY'),
            'end_date',       TO_CHAR(lp.date_to, 'DD/MM/YY')
        )) AS discount_json
    FROM loyalty_program lp
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    WHERE lp.company_id = b.company_id
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to   IS NULL OR lp.date_to   >= CURRENT_DATE)
      AND disc.discount_sum IS NULL
) loy ON true

ORDER BY b.id DESC -- or b.price ASC/DESC
;
```
"""

with open("QUERIES.md", "a") as f:
    f.write(content_to_append)
