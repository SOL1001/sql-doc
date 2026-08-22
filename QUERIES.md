# SQL Queries Reference



## Endpoint 1 — GET /api/v1/orders



Query: app_user_id, page, per_page, merchant, history
$1=app_user_id $2=merchant $3=history $4=per_page $5=offset


```sql
WITH input AS (
    SELECT $1::text AS app_user_id, $2::text AS merchant_filter, $3::text AS history, $4::int AS lim, $5::int AS off
),
partner AS (
    SELECT p.id FROM res_partner p JOIN input i ON TRUE
    WHERE p.app_user_id = i.app_user_id AND p.active = TRUE LIMIT 1
),
merchant_company AS (
    SELECT c.id FROM res_company c JOIN input i ON TRUE
    WHERE i.merchant_filter <> '' AND c.merchant = i.merchant_filter
      AND c.is_delivery = FALSE AND c.merchant IS NOT NULL LIMIT 1
),
filtered AS (
    SELECT so.id, so.name, so.state, so.superapp_order_status, so.date_order,
           ROUND(so.amount_total::numeric, 2) AS total_price, so."deliveryType",
           so.driver_name, so.driver_mobile, so.driver_email, so.driver_delivery_medium,
           rc.id AS company_id, rc.merchant, rc.name AS company_name,
           NULLIF(TRIM(COALESCE(rc.logo_web, rp.image_1920_url, '')), '') AS logo_url,
           rc.lat_location, rc.lng_location, rc.phone AS company_phone,
           rp.street, rp.city, rcs.name AS state_name, rco.name->>'en_US' AS country_name, rcp.name AS parent_name
    FROM input i
    JOIN partner p ON TRUE
    JOIN sale_order so ON so.partner_id = p.id AND so.is_superapp_order = TRUE
    LEFT JOIN res_company rc ON rc.id = so.company_id
    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
    LEFT JOIN res_country_state rcs ON rcs.id = rp.state_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    LEFT JOIN res_company rcp ON rcp.id = rc.parent_id
    WHERE (i.merchant_filter = '' OR so.company_id = (SELECT id FROM merchant_company))
      AND (i.history = '' OR i.history = 'all'
           OR (i.history = 'active' AND so.superapp_order_status NOT IN ('cancelled','delivered'))
           OR (i.history = 'inactive' AND so.superapp_order_status IN ('delivered','cancelled')))
),
guard AS (
    SELECT EXISTS(SELECT 1 FROM partner) AS partner_exists,
           CASE WHEN (SELECT merchant_filter FROM input) = '' THEN TRUE
                ELSE EXISTS(SELECT 1 FROM merchant_company) END AS merchant_ok,
           COALESCE((SELECT COUNT(*)::int FROM filtered), 0) AS total_count
),
paged AS (
    SELECT f.* FROM filtered f
    JOIN guard g ON g.partner_exists AND g.merchant_ok
    ORDER BY f.id DESC
    LIMIT (SELECT lim FROM input) OFFSET (SELECT off FROM input)
),
orders_data AS (
    SELECT COALESCE(json_agg(order_obj ORDER BY order_id DESC), '[]'::json) AS orders_json
    FROM (
        SELECT b.id AS order_id,
               json_build_object(
                   'id', b.id, 'order_ref', b.name, 'state', b.state,
                   'delivery_status', NULLIF(b.superapp_order_status, ''),
                   'date_order', CASE WHEN b.date_order IS NULL THEN NULL
                       ELSE TO_CHAR(b.date_order, 'YYYY-MM-DD HH24:MI:SS') END,
                   'total_price', b.total_price, 'delivery_type', b."deliveryType",
                   'merchant', json_build_object(
                       'merchant', b.merchant, 'name', b.company_name, 'logo', b.logo_url,
                       'lat', b.lat_location, 'lng', b.lng_location,
                       'parent', CASE WHEN b.parent_name IS NOT NULL AND b.parent_name <> '' THEN b.parent_name ELSE b.company_name END,
                       'branch', b.company_name,
                       'phone', CASE WHEN b.company_phone IS NULL OR b.company_phone = '' THEN NULL
                           ELSE REPLACE(REPLACE(b.company_phone, '+251', '0'), ' ', '') END,
                       'location', CASE WHEN b.company_id IS NULL THEN NULL
                           ELSE CONCAT_WS(', ', NULLIF(b.street,''), NULLIF(b.city,''),
                               COALESCE(NULLIF(b.state_name,''), 'False'), NULLIF(b.country_name,'')) END
                   ),
                   'driver_info', CASE WHEN b."deliveryType" = 'delivery' THEN json_build_object(
                       'driver_name', b.driver_name, 'driver_mobile', b.driver_mobile,
                       'driver_email', b.driver_email, 'delivery_medium', b.driver_delivery_medium)
                       ELSE '{}'::json END,
                   'sale_order_lines', COALESCE(lines.lines_json, '[]'::json)
               ) AS order_obj
        FROM paged b
        LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
                'id', sol.id, 'product_id', sol.product_id,
                'product_name', CASE WHEN sol.product_id IS NOT NULL THEN
                    CASE WHEN attrs.attributes IS NOT NULL AND attrs.attributes <> ''
                        THEN CONCAT(COALESCE(pt.name->>'en_US', pt.name::text), ' (', attrs.attributes, ')')
                        ELSE COALESCE(pt.name->>'en_US', pt.name::text, '') END
                    ELSE COALESCE(NULLIF(sol.name, ''), '') END,
                'qty', sol.product_uom_qty, 'uom', u.name->>'en_US',
                'price_unit', ROUND(sol.price_unit::numeric, 2),
                'line_amount', ROUND(sol.price_total::numeric, 2),
                'product_image', NULLIF(TRIM(COALESCE(pp.image_1920_url, pt.image_1920_url, '')), '')
            )) AS lines_json
            FROM sale_order_line sol
            LEFT JOIN product_product pp ON pp.id = sol.product_id
            LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
            LEFT JOIN uom_uom u ON u.id = sol.product_uom
            LEFT JOIN (
                SELECT pvc.product_product_id,
                       string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
                FROM product_variant_combination pvc
                JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
                JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
                JOIN product_attribute pa ON pa.id = pav.attribute_id
                WHERE pvc.product_product_id IN (SELECT DISTINCT product_id FROM sale_order_line WHERE order_id = b.id)
                GROUP BY pvc.product_product_id
            ) attrs ON attrs.product_product_id = pp.id
            WHERE sol.order_id = b.id
        ) lines ON true
    ) orders
)
SELECT g.partner_exists, g.merchant_ok, g.total_count, od.orders_json
FROM guard g CROSS JOIN orders_data od;
```





## Endpoint 2 — GET /api/v1/{merchant}/orders/{order_id}/status



Path: merchant, order_id
$1=order_id $2=merchant


```sql
WITH base AS (
    SELECT
        so.id AS order_id, so.name AS order_name, so.state,
        so.superapp_order_status AS order_status,
        ROUND((so.amount_total + COALESCE(dp.ecommerce_float_price, 0))::numeric, 2) AS amount_total,
        so.invoice_status, so.lock_id, so.ft_reference,
        so.delivery_lat, so.delivery_long, so.customer_pickup_code,
        so.driver_name, so.driver_mobile, so.driver_delivery_medium,
        so."deliveryType" AS delivery_type, so.date_order,
        dp.ecommerce_float_price AS delivery_price,
        rc.id AS company_id, rc.name AS company_name, rc.merchant AS company_merchant,
        NULLIF(TRIM(COALESCE(rc.logo_web, rp.image_1920_url, '')), '') AS logo_url,
        rc.lat_location AS lat, rc.lng_location AS lng, rc.phone AS company_phone,
        rp.street, rp.city, rs.name AS state_name, rco.name->>'en_US' AS country_name
    FROM sale_order so
    INNER JOIN res_company rc ON rc.id = so.company_id AND rc.merchant = $2
        AND rc.is_delivery = FALSE AND rc.merchant IS NOT NULL
    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
    LEFT JOIN res_country_state rs ON rs.id = rp.state_id
    LEFT JOIN res_country rco ON rco.id = rp.country_id
    LEFT JOIN product_product dp ON dp.id = so.delivery_product_id::integer
        AND so.delivery_product_id IS NOT NULL AND so.delivery_product_id != '0'
    WHERE so.id = $1 AND so.is_superapp_order = TRUE
    LIMIT 1
)
SELECT b.*, COALESCE(pickings.delivery_count, 0) AS delivery_count,
       COALESCE(lines.lines_json, '[]'::json) AS lines_json
FROM base b
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS delivery_count FROM stock_picking sp WHERE sp.sale_id = b.order_id
) pickings ON true
LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
        'id', sol.id, 'product_id', sol.product_id,
        'name', COALESCE(sol.name, CASE WHEN attrs.attributes IS NOT NULL
            THEN CONCAT(pt.name->>'en_US', ' (', attrs.attributes, ')') ELSE pt.name->>'en_US' END),
        'qty', sol.product_uom_qty, 'uom', u.name->>'en_US',
        'price_unit', ROUND(sol.price_unit::numeric, 2),
        'line_amount', ROUND(sol.price_total::numeric, 2),
        'product_image', NULLIF(TRIM(COALESCE(pp.image_1920_url, pt.image_1920_url, '')), '')
    )) AS lines_json
    FROM sale_order_line sol
    LEFT JOIN product_product pp ON pp.id = sol.product_id
    LEFT JOIN product_template pt ON pt.id = pp.product_tmpl_id
    LEFT JOIN uom_uom u ON u.id = sol.product_uom
    LEFT JOIN (
        SELECT pvc.product_product_id, string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
        FROM product_variant_combination pvc
        JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
        JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
        JOIN product_attribute pa ON pa.id = pav.attribute_id
        WHERE pvc.product_product_id IN (SELECT DISTINCT product_id FROM sale_order_line WHERE order_id = b.order_id)
        GROUP BY pvc.product_product_id
    ) attrs ON attrs.product_product_id = pp.id
    WHERE sol.order_id = b.order_id
) lines ON true;
```




## Endpoint 3 — GET /api/v1/product/{product_id}/reviews



Path: product_id
Query: page, per_page
$1=product_id $2=per_page $3=offset


```sql
WITH product_check AS (
    SELECT EXISTS(SELECT 1 FROM product_template WHERE id = $1) AS exists
),
base AS (
    SELECT pr.id, COALESCE(rp.name, 'Anonymous') AS user_name, rp.app_user_id,
           pr.rating, COALESCE(pr.review, '') AS review,
           TO_CHAR(pr.create_date, 'DD TMMonth YYYY') AS create_date
    FROM product_review pr
    LEFT JOIN res_partner rp ON rp.id = pr.user_id
    WHERE pr.product_template = $1
    ORDER BY pr.id DESC
    LIMIT $2 OFFSET $3
),
total_reviews AS (
    SELECT COUNT(*) AS c FROM product_review WHERE product_template = $1
),
aggregated_reviews AS (
    SELECT json_agg(json_build_object(
        'id', b.id, 'user_name', b.user_name,
        'user_id', CASE WHEN b.app_user_id IS NOT NULL AND b.app_user_id != ''
            THEN to_jsonb(b.app_user_id) ELSE to_jsonb(false) END,
        'rating', COALESCE(NULLIF(b.rating, ''), '0')::int,
        'review', b.review, 'create_date', b.create_date,
        'replys', COALESCE(replies.replies_json, '[]'::json)
    ) ORDER BY b.id DESC) AS reviews_json
    FROM base b
    LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
            'reply_from', COALESCE(rp2.name, 'Dev Team'),
            'reply', COALESCE(rr.reply, ''),
            'reply_date', TO_CHAR(rr.create_date, 'DD TMMonth YYYY')
        ) ORDER BY rr.id ASC) AS replies_json
        FROM review_reply rr
        LEFT JOIN res_partner rp2 ON rp2.id = rr.user_id
        WHERE rr.review_id = b.id
    ) replies ON true
)
SELECT (SELECT exists FROM product_check), (SELECT c FROM total_reviews),
       COALESCE((SELECT reviews_json FROM aggregated_reviews), '[]'::json);
```




## Endpoint 4 — GET /api/v1/product/purchase_status


Query: app_user_id, product_id
$1=app_user_id $2=product_id


```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 LIMIT 1
)
SELECT EXISTS(SELECT 1 FROM partner) AS partner_exists,
       EXISTS(
           SELECT 1 FROM sale_order_line sol
           JOIN sale_order so ON so.id = sol.order_id
           WHERE so.partner_id = (SELECT id FROM partner)
             AND so.is_superapp_order = TRUE
             AND so.state IN ('sale', 'done')
             AND sol.product_id = $2
       ) AS is_bought;
```



## Endpoint 5 — GET /api/v1/orders/list



Query: app_user_id, page, per_page
$1=app_user_id $2=per_page $3=offset


```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 AND active = TRUE LIMIT 1
),
base_companies AS (
    SELECT rc.id AS company_id, rc.name AS company_name, rc.merchant AS merchant,
           NULLIF(TRIM(COALESCE(rc.logo_web, rp.image_1920_url, '')), '') AS logo_url,
           COUNT(so.id) AS order_count
    FROM sale_order so
    JOIN res_company rc ON rc.id = so.company_id
    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
    WHERE so.partner_id = (SELECT id FROM partner) AND so.is_superapp_order = TRUE
    GROUP BY rc.id, rc.name, rc.merchant, rc.logo_web, rp.image_1920_url
),
total_count AS (SELECT COUNT(*) AS c FROM base_companies),
paginated_companies AS (
    SELECT * FROM base_companies ORDER BY order_count DESC, company_name ASC
    LIMIT $2 OFFSET $3
),
aggregated_results AS (
    SELECT json_agg(json_build_object(
        'company_id', pc.company_id, 'company_name', pc.company_name,
        'merchant', pc.merchant, 'logo_url', pc.logo_url,
        'order_count', pc.order_count, 'item_count', COALESCE(items.item_count, 0)
    ) ORDER BY pc.order_count DESC, pc.company_name ASC) AS results_json
    FROM paginated_companies pc
    LEFT JOIN LATERAL (
        SELECT COUNT(sol.id)::int AS item_count
        FROM sale_order_line sol
        JOIN sale_order so2 ON so2.id = sol.order_id
        WHERE so2.partner_id = (SELECT id FROM partner)
          AND so2.is_superapp_order = TRUE
          AND so2.superapp_order_status != 'cancelled'
          AND so2.company_id = pc.company_id
    ) items ON true
)
SELECT EXISTS(SELECT 1 FROM partner) AS partner_exists,
       COALESCE((SELECT c FROM total_count), 0) AS total,
       COALESCE((SELECT results_json FROM aggregated_results), '[]'::json);
```




## Endpoint 6 — GET /api/v1/categoryads

```sql
SELECT 
bt.id,bt.name,bt.description,bt.image_url,bt.is_active,
json_build_object(
	'id', cat.id,
	'name', cat.name
) AS category
FROM admin_form bt Left JOIN  product_ecomerce_categories cat ON cat.id = bt.category_id
WHERE bt.is_active = true
OFFSET %s
LIMIT %s;
```


## Endpoint 7 — GET /api/v1/populars

```sql
SELECT

    c.name AS name,
    c.logo_url,
    c.merchant
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.cps_enabled = true
  AND c.is_delivery = false
  AND c.active = true
  AND c.merchant IS NOT NULL
  AND c.superapp_orders > 0 ORDER BY c.superapp_orders DESC 
  OFFSET %s --0
  LIMIT  %s --10;
```


## Endpoint 8 — GET /api/v1/popular_categories

```sql
SELECT
    c.id AS category_id,
    c.name AS category_name,
    c.superapp_sale_count AS total_sold_qty,
    c.image_1_url AS image,
    COUNT(pt.id) AS product_count
FROM product_ecomerce_categories c
LEFT JOIN product_template pt
    ON pt.ecomerce_category_id = c.id
WHERE c.superapp_sale_count > 0
GROUP BY
    c.id,
    c.name,
    c.superapp_sale_count,
    c.image_1_url
ORDER BY c.superapp_sale_count DESC
OFFSET %s -- 0
LIMIT %s; --10; 
```

## Endpoint 9 — GET /api/v1/popular_categories/{merchant_id:string}

```sql
WITH merchant_company AS (
    SELECT id
    FROM res_company
    WHERE merchant = 'MRT000001SPR'
    LIMIT 1
),
category_sales AS (
    SELECT
        sol.category_id,
        COUNT(sol.id) AS total_sold_qty
    FROM sale_order_line sol
    JOIN sale_order so
        ON so.id = sol.order_id
    JOIN res_company rc
        ON rc.id = so.company_id
    WHERE rc.merchant = 'MRT000001SPR'
      AND so.is_superapp_order = TRUE
      AND so.superapp_order_status = 'delivered'
      AND sol.category_id IS NOT NULL
    GROUP BY sol.category_id
)
SELECT
    c.id AS category_id,
    c.name AS category_name,
    COUNT(pt.id) AS product_count,
    cs.total_sold_qty,
    c.image_url AS image
FROM category_sales cs
JOIN product_ecomerce_categories c
    ON c.id = cs.category_id
CROSS JOIN merchant_company mc
LEFT JOIN product_template pt
    ON pt.ecomerce_category_id = c.id
    AND (
        pt.company_id = mc.id
        OR pt.company_id IN (
            SELECT id
            FROM res_company
            WHERE parent_id = mc.id
        )
    )
GROUP BY
    c.id,
    c.name,
    c.image_url,
    cs.total_sold_qty
ORDER BY
    cs.total_sold_qty DESC;
```


## Endpoint 10 — GET /api/v1/popular_products

```sql
WITH params AS (
    SELECT
        NULL::text AS merchant,
        NULL::int AS category_id,
        NULL::numeric AS min_price,
        NULL::numeric AS max_price,
        NULL::boolean AS is_halal,
        NULL::text AS app_user_id,
        NULL::text AS sort_order,
        1::int AS page,
        10::int AS per_page,
        50::int AS max_limit
),
p AS (
    SELECT
        merchant,
        category_id,
        min_price,
        max_price,
        is_halal,
        NULLIF(TRIM(app_user_id), '') AS app_user_id,
        sort_order,
        LEAST(GREATEST(per_page, 1), max_limit) AS limit_value,
        GREATEST(page - 1, 0) *
        LEAST(GREATEST(per_page, 1), max_limit) AS offset_value
    FROM params
),
paged_products AS (
    SELECT
        pt.id AS product_id,
        pt.name AS product_name_raw,
        pt.description_sale AS description_raw,
        pt.company_id,
        pt.sold_count,
        pt.ecommerce_float_price,
        pt.image_1920_url,
        pt.t_is_featured,
        pt.is_halal,
        pt.is_arrival,
        pt.total_reviews,
        pt.average_rating,
        COALESCE(pt.product_variant_count, 0) AS total_variants,
        c.merchant,
        c.name AS merchant_name,
		COUNT(*) OVER() AS total
    FROM product_template pt
    JOIN res_company c
        ON c.id = pt.company_id
    CROSS JOIN p
    WHERE pt.active IS TRUE
      AND pt.is_for_ecommerce IS TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.sold_count > 0
      AND pt.is_in_stock IS TRUE
      AND c.cps_enabled IS TRUE
      AND COALESCE(c.is_delivery, FALSE) IS FALSE
      AND c.active IS TRUE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
      AND (
          c.parent_id IS NULL
          OR EXISTS (
              SELECT 1
              FROM res_company parent
              WHERE parent.id = c.parent_id
                AND parent.parent_id IS NULL
                AND parent.cps_enabled IS TRUE
                AND COALESCE(parent.is_delivery, FALSE) IS FALSE
                AND parent.active IS TRUE
                AND NULLIF(TRIM(parent.merchant), '') IS NOT NULL
          )
      )
      AND (
          p.merchant IS NULL
          OR c.merchant = p.merchant
      )
      AND (
          p.category_id IS NULL
          OR p.category_id = 0
          OR pt.ecomerce_category_id = p.category_id
      )
      AND (
          p.min_price IS NULL
          OR pt.ecommerce_float_price >= p.min_price
      )
      AND (
          p.max_price IS NULL
          OR pt.ecommerce_float_price <= p.max_price
      )
      AND (
          p.is_halal IS NULL
          OR COALESCE(pt.is_halal, FALSE) = p.is_halal
      )
    ORDER BY
        CASE
            WHEN p.sort_order = 'asc' THEN pt.sold_count
        END ASC,
        CASE
            WHEN p.sort_order IS NULL
              OR p.sort_order = 'desc'
            THEN pt.sold_count
        END DESC,
        pt.id DESC
    LIMIT (
        SELECT limit_value
        FROM p
    )
    OFFSET (
        SELECT offset_value
        FROM p
    )
),
discount_data AS (
    SELECT
        pp.product_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', NULLIF(TRIM(pd.name), ''),
                'discount_type',
                    CASE
                        WHEN pd.discount_type IS NULL THEN NULL
                        WHEN pd.discount_type = 'percentage' THEN 'Percentage'
                        ELSE INITCAP(pd.discount_type)
                    END,
                'discount_value', pd.discount_value::text,
                'start_date',
                    CASE
                        WHEN pd.start_date IS NULL THEN NULL
                        ELSE TO_CHAR(pd.start_date, 'DD/MM/YY')
                    END,
                'end_date',
                    CASE
                        WHEN pd.end_date IS NULL THEN NULL
                        ELSE TO_CHAR(pd.end_date, 'DD/MM/YY')
                    END
            )
            ORDER BY pd.id
        ) AS discount,
        MIN(
            CASE
                WHEN pd.discount_type = 'percentage'
                THEN TRUNC(
                    GREATEST(
                        pp.ecommerce_float_price -
                        (
                            pp.ecommerce_float_price *
                            pd.discount_value / 100
                        ),
                        0
                    )::numeric,
                    2
                )
                ELSE TRUNC(
                    GREATEST(
                        pp.ecommerce_float_price - pd.discount_value,
                        0
                    )::numeric,
                    2
                )
            END
        ) AS product_discounts
    FROM paged_products pp
    JOIN product_discount pd
        ON pd.product_tmpl_id = pp.product_id
    WHERE pd.is_active IS TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (
          pd.start_date IS NULL
          OR pd.start_date <= CURRENT_DATE
      )
      AND (
          pd.end_date IS NULL
          OR pd.end_date >= CURRENT_DATE
      )
    GROUP BY pp.product_id
),
loyalty_programs AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.company_id,
        lp.name,
        lp.date_from,
        lp.date_to
    FROM loyalty_program lp
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce IS TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND lp.company_id IS NOT NULL
      AND (
          lp.date_from IS NULL
          OR lp.date_from <= CURRENT_DATE
      )
      AND (
          lp.date_to IS NULL
          OR lp.date_to >= CURRENT_DATE
      )
      AND EXISTS (
          SELECT 1
          FROM paged_products pp
          WHERE pp.company_id = lp.company_id
      )
    ORDER BY
        lp.company_id,
        lp.id
),
loyalty_discount_data AS (
    SELECT
        pp.product_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name',
                    NULLIF(
                        CASE
                            WHEN jsonb_typeof(lp.name::jsonb) = 'object'
                            THEN lp.name::jsonb ->> 'en_US'
                            ELSE lp.name::text
                        END,
                        ''
                    ),
                'discount_type',
                    CASE
                        WHEN lr.discount_mode = 'percent' THEN 'Percentage'
                        ELSE INITCAP(lr.discount_mode)
                    END,
                'discount_value',
                    CASE
                        WHEN lr.discount IS NULL THEN NULL
                        ELSE lr.discount::text
                    END,
                'start_date',
                    CASE
                        WHEN lp.date_from IS NULL THEN NULL
                        ELSE TO_CHAR(lp.date_from, 'DD/MM/YY')
                    END,
                'end_date',
                    CASE
                        WHEN lp.date_to IS NULL THEN NULL
                        ELSE TO_CHAR(lp.date_to, 'DD/MM/YY')
                    END
            )
            ORDER BY lr.id
        ) AS discount,
        MIN(
            CASE
                WHEN lr.discount_mode = 'percent'
                THEN TRUNC(
                    GREATEST(
                        pp.ecommerce_float_price -
                        (
                            pp.ecommerce_float_price *
                            lr.discount / 100
                        ),
                        0
                    )::numeric,
                    2
                )
                ELSE TRUNC(
                    GREATEST(
                        pp.ecommerce_float_price - lr.discount,
                        0
                    )::numeric,
                    2
                )
            END
        ) AS product_discounts
    FROM paged_products pp
    JOIN loyalty_programs lp
        ON lp.company_id = pp.company_id
    JOIN loyalty_reward lr
        ON lr.program_id = lp.id
    GROUP BY pp.product_id
),
wishlist_products AS (
    SELECT DISTINCT
        pp.product_tmpl_id
    FROM wishlist wl
    JOIN res_partner rp
        ON rp.id = wl.user_id
    JOIN product_product pp
        ON pp.id = wl.product_id
    CROSS JOIN p
    WHERE wl.is_active IS TRUE
      AND p.app_user_id IS NOT NULL
      AND rp.app_user_id = p.app_user_id
),
final_products AS (
    SELECT
        pp.*,
        CASE
            WHEN dd.discount IS NOT NULL THEN dd.discount
            WHEN ld.discount IS NOT NULL THEN ld.discount
            ELSE '[]'::jsonb
        END AS discount,
        CASE
            WHEN dd.discount IS NOT NULL
                THEN COALESCE(dd.product_discounts, 0)
            WHEN ld.discount IS NOT NULL
                THEN COALESCE(ld.product_discounts, 0)
            ELSE 0
        END AS product_discounts,
        EXISTS (
            SELECT 1
            FROM wishlist_products wp
            WHERE wp.product_tmpl_id = pp.product_id
        ) AS is_wishlisted
    FROM paged_products pp
    LEFT JOIN discount_data dd
        ON dd.product_id = pp.product_id
    LEFT JOIN loyalty_discount_data ld
        ON ld.product_id = pp.product_id
)
SELECT
    fp.product_id,
    CASE
        WHEN fp.product_name_raw IS NULL THEN NULL
        WHEN jsonb_typeof(fp.product_name_raw::jsonb) = 'object'
        THEN COALESCE(
            fp.product_name_raw::jsonb ->> 'en_US',
            fp.product_name_raw::text
        )
        ELSE fp.product_name_raw::text
    END AS product_name,
    CASE
        WHEN fp.description_raw IS NULL THEN NULL
        WHEN jsonb_typeof(fp.description_raw::jsonb) = 'object'
        THEN fp.description_raw::jsonb ->> 'en_US'
        ELSE fp.description_raw::text
    END AS description,
    CONCAT(COALESCE(fp.sold_count, 0), ' Units') AS total_sold_qty,
    fp.ecommerce_float_price AS list_price,
    'ETB' AS currency,
    COALESCE(fp.product_discounts, 0) AS product_discounts,
    COALESCE(fp.discount, '[]'::jsonb) AS discount,
    NULLIF(fp.image_1920_url, '') AS image,
    COALESCE(fp.total_reviews, 0) AS total_review,
    COALESCE(fp.average_rating, 0.0) AS average_rating,
    COALESCE(fp.total_variants, 0) AS tototal_variants,
    COALESCE(fp.t_is_featured, FALSE) AS is_featured,
    COALESCE(fp.is_halal, FALSE) AS is_halal,
    COALESCE(fp.is_arrival, FALSE) AS is_arrival,
    fp.is_wishlisted,
	fp.total
FROM final_products fp
ORDER BY
    fp.sold_count DESC,
    fp.product_id DESC;

```

## Endpoint 11 — GET /api/v1/{merchant:string}/popular_merchant_products

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale->>'en_US' AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    pt.image_1920_url AS image,
    pt.average_rating,
    
    COALESCE(pp_count.total_variants, 0) AS tototal_variants,

    pt.t_is_featured AS is_featured,
    pt.is_halal,
    pt.is_arrival,

    EXISTS (
        SELECT 1
        FROM product_template_res_partner_rel ptr
        WHERE ptr.product_template_id = pt.id
        AND ptr.res_partner_id = rp.id
    ) AS is_wishlisted,

    COALESCE(discount_data.discounts, '[]'::json) AS discount,
    COALESCE(discount_data.product_discounts, 0) AS product_discounts

FROM product_template pt

LEFT JOIN res_company rc  
    ON rc.id = pt.company_id

LEFT JOIN res_partner rp
    ON rp.app_user_id = %s --'51a0769721cb5557e0630b6f030a1579'

LEFT JOIN uom_uom uom
    ON uom.id = pt.uom_id

LEFT JOIN res_currency rcur 
    ON rcur.id = rc.currency_id

LEFT JOIN (
    SELECT 
        product_tmpl_id,
        COUNT(id) AS total_variants
    FROM product_product
    WHERE active = true 
    GROUP BY product_tmpl_id
) pp_count
    ON pp_count.product_tmpl_id = pt.id

LEFT JOIN LATERAL (
    SELECT
        json_agg(
            json_build_object(
                'name', d.name,
                'discount_type', d.discount_type,
                'discount_value', d.discount_value,
                'start_date', d.start_date,
                'end_date', d.end_date
            )
        ) FILTER (WHERE d.id IS NOT NULL AND d.is_active = true) AS discounts,

        COALESCE(
            SUM(
                CASE
                    WHEN d.discount_type IN ('percentage', 'percent')
                        THEN ROUND(
                            (
                                pt.ecommerce_float_price::numeric *
                                (d.discount_value::numeric / 100)
                            ),
                            2
                        )
                    ELSE
                        ROUND(
                            d.discount_value::numeric,
                            2
                        )
                END
            ) FILTER (
                WHERE d.id IS NOT NULL
                AND d.is_active = true
                -- The python code also checks start_date and end_date against TODAY
                AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
                AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)
            ),
            0
        ) AS product_discounts

    FROM product_discount d
    WHERE d.product_tmpl_id = pt.id

) discount_data ON TRUE

WHERE 
    rc.cps_enabled = true
    AND rc.is_delivery = false
    AND rc.active = true
	AND rc.merchant =  %s --'MRT000001SPR'
    AND pt.x_superapp_approval_status = 'approved'
    AND pt.sold_count > 0
    AND pt.ecommerce_float_price >= %s -- 0 default 
    AND pt.ecommerce_float_price <= %s -- 10000000 default
    AND pt.is_in_stock = true
    AND pt.active = true 
ORDER BY pt.sold_count DESC 
OFFSET %s --0
LIMIT %s; --10;


```


## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}

```sql
SELECT 
    pt.id AS product_id,
    pt.name->>'en_US' AS product_name,
    pt.description_sale AS description,
    pt.sold_count || ' ' || (uom.name->>'en_US') AS total_sold_qty,
    pt.ecommerce_float_price AS list_price,
    rcur.name AS currency,
    pt.image_1920_url AS image,
    pt.average_rating,
    
    COALESCE(pp_count.total_variants, 0) AS total_variants,
    COALESCE(review_count.total_reviews, 0) AS total_review, 

    pt.t_is_featured AS is_featured,
    pt.is_halal,
    pt.is_arrival,

    EXISTS (
        SELECT 1
        FROM product_template_res_partner_rel ptr
        WHERE ptr.product_template_id = pt.id
        AND ptr.res_partner_id = rp.id
    ) AS is_wishlisted,

    COALESCE(discount_data.discounts, '[]'::json) AS discount,
    COALESCE(discount_data.product_discounts, 0) AS product_discounts

FROM product_ecomerce_categories pec
LEFT JOIN product_template pt 
    ON pt.ecomerce_category_id = pec.id

LEFT JOIN res_company rc  
    ON rc.id = pt.company_id

LEFT JOIN res_partner rp
    ON rp.app_user_id = %s -- '51a0769721cb5557e0630b6f030a1579'

LEFT JOIN uom_uom uom
    ON uom.id = pt.uom_id

LEFT JOIN res_currency rcur 
    ON rcur.id = rc.currency_id

LEFT JOIN (
    SELECT 
        product_tmpl_id,
        COUNT(id) AS total_variants
    FROM product_product
    WHERE active = true 
    GROUP BY product_tmpl_id
) pp_count
    ON pp_count.product_tmpl_id = pt.id

LEFT JOIN (
    SELECT 
        product_template, 
        COUNT(id) AS total_reviews
    FROM product_review 
    GROUP BY product_template
) review_count
    ON review_count.product_template = pt.id

LEFT JOIN LATERAL (
    SELECT
        json_agg(
            json_build_object(
                'name', d.name,
                'discount_type', d.discount_type,
                'discount_value', d.discount_value,
                'start_date', d.start_date,
                'end_date', d.end_date
            )
        ) FILTER (WHERE d.id IS NOT NULL AND d.is_active = true) AS discounts,

        COALESCE(
            SUM(
                CASE
                    WHEN d.discount_type IN ('percentage', 'percent')
                        THEN ROUND(
                            (
                                pt.ecommerce_float_price::numeric *
                                (d.discount_value::numeric / 100)
                            ),
                            2
                        )
                    ELSE
                        ROUND(
                            d.discount_value::numeric,
                            2
                        )
                END
            ) FILTER (
                WHERE d.id IS NOT NULL
                AND d.is_active = true
                AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE) 
                AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)     
            ),
            0
        ) AS product_discounts

    FROM product_discount d
    WHERE d.product_tmpl_id = pt.id

) discount_data ON TRUE

WHERE 
    pec.id = %s --1
    AND rc.cps_enabled = true
    AND rc.is_delivery = false
    AND rc.active = true
    AND rc.merchant = %s -- 'MRT000001SPR'
    AND pt.x_superapp_approval_status = 'approved'
    AND pt.sold_count > 0
    AND pt.ecommerce_float_price >= %s --0 
    AND pt.ecommerce_float_price <= %s -- 10000000 
    AND pt.is_in_stock = true
    AND pt.active = true
ORDER BY pt.sold_count DESC 
OFFSET %s --0 
LIMIT %s; -- 10;

```

## Endpoint 13 — GET /api/v1/popular_categories

```sql
SELECT 
pec.id AS category_id,
pec.name AS category_name,
pec.superapp_sale_count AS total_sold_qty,
COUNT(pt.id) AS product_count,
pec.image_1_url
FROM product_ecomerce_categories pec LEFT JOIN product_template pt ON pt.ecomerce_category_id = pec.id
GROUP BY pec.id,pec.name,pec.superapp_sale_count
OFFSET %s --0
LIMIT %s -- 10 ;
```


## Endpoint 14 — GET /api/v1/popular_categories/{merchant_id:string}

```sql
SELECT
    pec.id AS category_id,
    pec.name AS category_name,
    (
        SELECT COUNT(*)
        FROM product_template pt
        WHERE pt.ecomerce_category_id = pec.id
        AND (
            pt.company_id = rc.id
            OR pt.company_id IN (
                SELECT id FROM res_company WHERE parent_id = rc.id
            )
        )
    ) AS product_count,
    COUNT(sol.id) AS total_sold_qty,
    pec.image_1_url AS image
FROM sale_order_line sol
LEFT JOIN product_ecomerce_categories pec
    ON sol.category_id = pec.id
LEFT JOIN sale_order so
    ON sol.order_id = so.id
LEFT JOIN res_company rc
    ON so.company_id = rc.id
WHERE
    rc.merchant = %s --'MRT000001SPR'
    AND rc.cps_enabled = true
    AND so.superapp_order_status = 'delivered'
    AND so.is_superapp_order = true
    AND sol.category_id IS NOT NULL
GROUP BY
    pec.id,
    pec.name,
    pec.image_1_url,
    rc.id
ORDER BY
    COUNT(sol.id) DESC
LIMIT %s --10
OFFSET %s --0;
```


## Endpoint 15 — GET /api/v1/search/{query:string}

```sql
WITH merchant_stats AS (
    SELECT 
        rc.id,
        rc.name,
        rc.merchant,
        cbt.code AS business_type,
        rc.logo_url AS logo,
        rc.banner_url AS banner,
        rc.is_featured,
        rc.email,
        rc.phone,
        rc.parent_id,
        prc.merchant AS parent_merchant,
        
        (
            SELECT COUNT(*) 
            FROM product_template pt 
            WHERE pt.company_id = rc.id 
              AND pt.active = true 
              AND pt.sale_ok = true          
              AND pt.x_superapp_approval_status = 'approved'     
        ) AS product_template_count,
        
        (
            SELECT COUNT(*) 
            FROM product_product pp 
            INNER JOIN product_template pt ON pp.product_tmpl_id = pt.id 
            WHERE pt.company_id = rc.id 
              AND pp.active = true 
              AND pt.active = true
              AND pt.sale_ok = true 
              AND  pt.x_superapp_approval_status = 'approved'  
        ) AS product_variant_count

    FROM res_company rc 
    LEFT JOIN res_company prc ON rc.parent_id = prc.id
    LEFT JOIN company_business_type cbt ON cbt.id = rc.business_type_id
    WHERE 
        (rc.name ILIKE %s --'%afri%' 
		OR rc.merchant ILIKE %s --'%afri%'
		)
        AND rc.cps_enabled = true
)
SELECT 
    json_build_object(
        'count', (SELECT COUNT(*) FROM merchant_stats),
        'status', 'success',
        'merchants', COALESCE(
            json_agg(
                json_build_object(
                    'id', ms.id,
                    'name', ms.name,
                    'merchant', ms.merchant,
                    'business_type', ms.business_type,
                    'logo', ms.logo,
                    'banner', ms.banner,
                    'is_featured', ms.is_featured,
                    'email', ms.email,
                    'phone', ms.phone,
                    'parent_id', ms.parent_id,
                    'parent_merchant', ms.parent_merchant,
                    'product_template_count', ms.product_template_count,
                    'product_variant_count', ms.product_variant_count
                )
            ), 
            '[]'::json 
        )
    ) AS response
FROM merchant_stats ms;
```

## Endpoint 16 — GET /api/v1/search/all/<query:string>

```sql
SELECT json_build_object(
'query','co',

    'merchants_count',
    (
        SELECT COUNT(DISTINCT rc.id)
        FROM res_company rc

        LEFT JOIN product_template pt
            ON pt.company_id = rc.id

        WHERE
            (
                rc.name ILIKE %s -- '%co%'
                OR rc.merchant ILIKE  %s --'%co%'
            )
            AND rc.cps_enabled = TRUE
            AND rc.is_delivery = FALSE
            AND pt.x_superapp_approval_status = 'approved'
    ),

    'merchants',
    COALESCE(
        (
            SELECT json_agg(company)
            FROM (
                SELECT
                    rc.id,
                    rc.name,
                    rc.merchant,
                    cbt.code AS business_type,
                    rc.logo_web AS logo,
                    rc.banner_url AS banner,
                    rc.is_featured,
                    rc.email,
                    rc.phone,
                    rc.parent_id,
                    prc.merchant AS parent_merchant,
                    COUNT(DISTINCT pt.id) AS product_template_count,
                    COUNT(DISTINCT pp.id) AS product_variant_count

                FROM res_company rc

                LEFT JOIN product_template pt
                    ON pt.company_id = rc.id

                LEFT JOIN product_product pp
                    ON pp.product_tmpl_id = pt.id

                LEFT JOIN res_company prc
                    ON rc.parent_id = prc.id

                LEFT JOIN company_business_type cbt
                    ON cbt.id = rc.business_type_id

                WHERE
                    (
                        rc.name ILIKE  %s --'%co%'
                        OR rc.merchant ILIKE  %s --'%co%'
                    )
                    AND rc.cps_enabled = TRUE
                    AND rc.is_delivery = FALSE
                    AND pt.x_superapp_approval_status = 'approved'

                GROUP BY
                    rc.id,
                    rc.name,
                    rc.merchant,
                    cbt.code,
                    rc.logo_web,
                    rc.banner_url,
                    rc.is_featured,
                    rc.email,
                    rc.phone,
                    rc.parent_id,
                    prc.merchant

            ) company
        ),
        '[]'::json
    ),
    'products_total',
    (
        SELECT COUNT(DISTINCT pt.id)
        FROM res_company rc

        LEFT JOIN product_template pt
            ON pt.company_id = rc.id

        WHERE
              COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) ILIKE  %s --'%co%'
            
            AND rc.cps_enabled = TRUE
            AND rc.is_delivery = FALSE
            AND pt.x_superapp_approval_status = 'approved'
    ),
    'products',
    COALESCE(
        (
            SELECT json_agg(product)
            FROM (
                SELECT
                    pt.id,

                    COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) AS name,

                    pt.image_1920_url AS image_url,
                    pt.ecommerce_float_price AS list_price,

                    json_build_object(
                        'id', rc.id,
                        'name', rc.name,
                        'merchant', rc.merchant,
                        'logo', rc.logo_url
                    ) AS company,

                    pt.average_rating,

                    COUNT(pr.id) AS total_reviews

                FROM product_template pt

                JOIN res_company rc
                    ON rc.id = pt.company_id

                LEFT JOIN product_review pr
                    ON pr.product_template = pt.id

                WHERE
                    COALESCE(
                        pt.name->>'en_US',
                        pt.name->>'en',
                        ''
                    ) ILIKE %s --'%co%'

                    AND rc.cps_enabled = TRUE
                    AND rc.is_delivery = FALSE
                    AND pt.x_superapp_approval_status = 'approved'

                GROUP BY
                    pt.id,
                    rc.id

            ) product
        ),
        '[]'::json
    ),
'categories_count',
    (
        SELECT COUNT(DISTINCT pec.id)
        FROM product_ecomerce_categories pec 
		WHERE pec.name ILIKE %s --'%co%'
    ),
    'categories',
    COALESCE(
        (
            SELECT json_agg(category)
            FROM (
                SELECT
                    pec.id,
                    pec.name,
                    pec.complete_name,
                    pec.image_1_url

                FROM product_ecomerce_categories pec

                WHERE
                    pec.name ILIKE %s --'%co%'

            ) category
        ),
        '[]'::json
    )

) AS result;
```

## Endpoint 17 — GET /api/v1/products/search/{query:string}

```sql
SELECT 
pt.id,pt.name->>'en_US' AS name,
pt.ecommerce_float_price AS list_price,
pt.image_1920_url AS image_url,
pt.average_rating,
COUNT(pr.id) AS total_reviews,
json_build_object (
'id',rc.id,'name',rc.name,'merchant',rc.merchant,'logo',rc.logo_url
) AS company

FROM product_template pt 
LEFT JOIN res_company rc on rc.id = pt.company_id
LEFT JOIN product_review pr ON pr.product_template = pt.id 
WHERE
 rc.cps_enabled = true
AND COALESCE (
pt.name->>'en_US',
pt.name->>'en',
''
) ILIKE %s --'%lo%'
GROUP BY
pt.id,rc.id
ORDER BY pt.id DESC
OFFSET 0
LIMIT 10; 
```

## Endpoint 18 — GET /api/v1/categories/search?query={query:string}

```sql
SELECT pec.id,
       pec.name,
       pec.complete_name,
       pec.image_1_url AS image,
       COUNT(pt.id) AS items,
	   parent.id,
	   parent.name
FROM product_ecomerce_categories pec
    LEFT JOIN product_template pt ON pt.ecomerce_category_id = pec.id 
    LEFT JOIN res_company rc ON pt.company_id = rc.id
	LEFT JOIN product_ecomerce_categories parent ON pec.parent_id = parent.id
WHERE pec.name ILIKE %s --'%co%'
    AND pt.x_superapp_approval_status = 'approved'
    AND rc.cps_enabled = true
    AND rc.is_delivery = false
GROUP BY
pec.id,parent.id
OFFSET %s --0
LIMIT %s; --10;
```

## Endpoint 19 — GET /api/v1/total_products

```sql

-- WITH merchant_status_check AS (
--     SELECT
--         CASE
--             WHEN NULLIF(TRIM(COALESCE(NULL::text, NULL::text)), '') IS NULL THEN 'valid'  -- replace with actual merchant param
--             WHEN NOT EXISTS (
--                 SELECT 1 FROM res_company c
--                 WHERE c.merchant = NULL  -- bind :merchant here
--                   AND c.cps_enabled = true
--                   AND COALESCE(c.is_delivery, false) = false
--                   AND c.active = true
--             ) THEN 'not_found'
--             WHEN EXISTS (
--                 SELECT 1 FROM res_company c
--                 JOIN res_company parent ON parent.id = COALESCE(c.parent_id, c.id)
--                 WHERE c.merchant = NULL  -- bind :merchant here
--                   AND c.cps_enabled = true AND c.active = true
--                   AND COALESCE(c.is_delivery, false) = false
--                   AND c.merchant IS NOT NULL AND c.merchant != ''
--             ) THEN 'valid'
--             ELSE 'forbidden'
--         END AS status
-- )
-- SELECT status FROM merchant_status_check;
-- App layer: if status = 'forbidden' -> return 403 "Merchant not available"
--            if status = 'not_found' -> return 404 "Merchant not found"
--            if status = 'valid'     -> proceed to main query below
-- ============================================================================

WITH params AS (
    SELECT
        NULL::text AS path_merchant,
        NULL::text AS query_merchant,
        1::int AS page,
        10::int AS per_page,
        NULL::int AS fetch_limit,
        NULL::numeric AS min_price,
        NULL::numeric AS max_price,
        NULL::int AS category_id,
        NULL::text AS app_user_id,
        NULL::text AS order_param,
        NULL::text AS high_to_low_param,
        NULL::text AS is_featured_param,
        NULL::text AS is_halal_param,
        NULL::text AS is_arrival_param,
        NULL::text AS is_discount_param
),

request_params AS (
    SELECT
        p.*,
        COALESCE(NULLIF(TRIM(p.path_merchant), ''), NULLIF(TRIM(p.query_merchant), '')) AS merchant,
        CASE
            WHEN LOWER(COALESCE(p.is_featured_param, '')) IN ('1', 'true', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(p.is_featured_param, '')) IN ('0', 'false', 'no') THEN FALSE
            ELSE NULL
        END AS featured_filter,
        CASE
            WHEN LOWER(COALESCE(p.is_halal_param, '')) IN ('1', 'true', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(p.is_halal_param, '')) IN ('0', 'false', 'no') THEN FALSE
            ELSE NULL
        END AS halal_filter,
        CASE
            WHEN LOWER(COALESCE(p.is_arrival_param, '')) IN ('1', 'true', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(p.is_arrival_param, '')) IN ('0', 'false', 'no') THEN FALSE
            ELSE NULL
        END AS arrival_filter,
        CASE
            WHEN LOWER(COALESCE(p.is_discount_param, '')) IN ('1', 'true', 'yes') THEN TRUE
            ELSE FALSE
        END AS discount_only,
        CASE
            WHEN LOWER(COALESCE(p.high_to_low_param, '')) IN ('1', 'true', 'yes') THEN 'desc'
            WHEN LOWER(COALESCE(p.high_to_low_param, '')) IN ('0', 'false', 'no') THEN 'asc'
            WHEN LOWER(COALESCE(p.order_param, '')) = 'asc' THEN 'asc'
            WHEN LOWER(COALESCE(p.order_param, '')) = 'desc' THEN 'desc'
            ELSE NULL
        END AS price_sort_direction,
        (p.page - 1) * p.per_page AS requested_offset
    FROM params p
),

merchant_company_ids AS (
    SELECT c.id AS company_id
    FROM res_company c
    CROSS JOIN request_params r
    WHERE r.merchant IS NOT NULL
      AND r.merchant <> ''
      AND c.merchant = r.merchant
      AND c.active = TRUE
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
),

allowed_parent_companies AS (
    SELECT c.id
    FROM res_company c
    WHERE c.parent_id IS NULL
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND c.active = TRUE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
),

allowed_companies AS (
    SELECT id
    FROM allowed_parent_companies

    UNION ALL

    SELECT c.id
    FROM res_company c
    JOIN allowed_parent_companies p ON p.id = c.parent_id
    WHERE c.cps_enabled = TRUE
      AND c.active = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
),

active_discount_products AS (
    SELECT DISTINCT pd.product_tmpl_id
    FROM product_discount pd
    WHERE pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
),

active_loyalty_companies AS (
    SELECT DISTINCT lp.company_id
    FROM loyalty_program lp
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND lp.company_id IS NOT NULL
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),

candidate_products AS (
    SELECT
        pt.id,
        pt.company_id,
        pt.ecommerce_float_price
    FROM product_template pt
    CROSS JOIN request_params r
    WHERE pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.is_in_stock = TRUE
	  AND (
		r.min_price IS NULL
		OR pt.ecommerce_float_price >= r.min_price
	  )
	  AND (
		r.max_price IS NULL
		OR pt.ecommerce_float_price <= r.max_price
	  )
      AND (
          (
              r.merchant IS NOT NULL
              AND r.merchant <> ''
              AND EXISTS (
                  SELECT 1
                  FROM merchant_company_ids mc
                  WHERE mc.company_id = pt.company_id
              )
          )
          OR (
              (r.merchant IS NULL OR r.merchant = '')
              AND EXISTS (
                  SELECT 1
                  FROM allowed_companies ac
                  WHERE ac.id = pt.company_id
              )
          )
      )
      AND (
          r.category_id IS NULL
          OR r.category_id = 0
          OR pt.ecomerce_category_id = r.category_id
      )
      AND (
          r.featured_filter IS NULL
          OR COALESCE(pt.t_is_featured, FALSE) = r.featured_filter
      )
      AND (
          r.halal_filter IS NULL
          OR COALESCE(pt.is_halal, FALSE) = r.halal_filter
      )
      AND (
          r.arrival_filter IS NULL
          OR COALESCE(pt.is_arrival, FALSE) = r.arrival_filter
      )
      AND (
          r.discount_only = FALSE
          OR EXISTS (
              SELECT 1
              FROM active_discount_products adp
              WHERE adp.product_tmpl_id = pt.id
          )
          OR EXISTS (
              SELECT 1
              FROM active_loyalty_companies alc
              WHERE alc.company_id = pt.company_id
          )
      )
    ORDER BY
        CASE WHEN r.price_sort_direction = 'desc' THEN pt.ecommerce_float_price END DESC,
        CASE WHEN r.price_sort_direction = 'asc' THEN pt.ecommerce_float_price END ASC,
        pt.id DESC
    LIMIT (SELECT fetch_limit FROM request_params)
),

product_count AS (
    SELECT COUNT(*) AS total
    FROM candidate_products
),

paged_product_ids AS (
    SELECT
        cp.id,
        cp.company_id,
        cp.ecommerce_float_price
    FROM candidate_products cp
    CROSS JOIN request_params r
    CROSS JOIN product_count pc
    WHERE r.requested_offset < pc.total
    ORDER BY
        CASE WHEN r.price_sort_direction = 'desc' THEN cp.ecommerce_float_price END DESC,
        CASE WHEN r.price_sort_direction = 'asc' THEN cp.ecommerce_float_price END ASC,
        cp.id DESC
    LIMIT (SELECT per_page FROM request_params)
    OFFSET (SELECT requested_offset FROM request_params)
),

page_products AS (
    SELECT
        pt.id,
        pt.name,
        pt.description_sale,
        pt.ecommerce_float_price,
        pt.uom_id,
        pt.company_id,
        pt.t_is_featured,
        pt.is_halal,
        pt.is_arrival,
        pt.min_quantity,
        pt.max_quantity,
        pt.ecomerce_category_id,
        pt.image_1920_url,
        pt.has_image,
        pt.api_qty_available,
        pt.api_virtual_available,
        pt.is_in_stock,
        COALESCE(pt.product_variant_count, 0) AS total_variants,
        COALESCE(pt.total_reviews, 0) AS total_reviews,
        COALESCE(pt.average_rating, 0.0) AS average_rating,
        c.merchant,
        c.name AS company_name,
        c.has_logo,
        c.logo_url
    FROM paged_product_ids pp
    JOIN product_template pt ON pt.id = pp.id
    JOIN res_company c ON c.id = pt.company_id
),

product_discounts AS (
    SELECT
        pp.id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', NULLIF(TRIM(pd.name), ''),
                'discount_type', CASE WHEN pd.discount_type IS NOT NULL THEN INITCAP(pd.discount_type) ELSE NULL END,
                'discount_value', CASE WHEN pd.discount_value IS NULL THEN NULL ELSE pd.discount_value::text END,
                'start_date', CASE WHEN pd.start_date IS NOT NULL THEN TO_CHAR(pd.start_date, 'DD/MM/YY') ELSE NULL END,
                'end_date', CASE WHEN pd.end_date IS NOT NULL THEN TO_CHAR(pd.end_date, 'DD/MM/YY') ELSE NULL END
            )
            ORDER BY pd.id
        ) AS discount,
        SUM(
            CASE
                WHEN pd.discount_type = 'percentage' THEN
                    TRUNC(GREATEST(pp.ecommerce_float_price - (pp.ecommerce_float_price * pd.discount_value / 100), 0)::numeric, 2)
                ELSE
                    TRUNC(GREATEST(pp.ecommerce_float_price - pd.discount_value, 0)::numeric, 2)
            END
        ) AS product_discounts
    FROM page_products pp
    JOIN product_discount pd ON pd.product_tmpl_id = pp.id
    WHERE pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
    GROUP BY pp.id
),

active_loyalty_programs AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.company_id,
        lp.name,
        lp.date_from,
        lp.date_to
    FROM loyalty_program lp
    JOIN (
        SELECT DISTINCT company_id
        FROM page_products
    ) pc ON pc.company_id = lp.company_id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND lp.company_id IS NOT NULL
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.company_id, lp.id
),

loyalty_discount_data AS (
    SELECT
        pp.id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', NULLIF(lp.name ->> 'en_US', ''),
                'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
                'discount_value', CASE WHEN lr.discount IS NULL THEN NULL ELSE lr.discount::text END,
                'start_date', CASE WHEN lp.date_from IS NOT NULL THEN TO_CHAR(lp.date_from, 'DD/MM/YY') ELSE NULL END,
                'end_date', CASE WHEN lp.date_to IS NOT NULL THEN TO_CHAR(lp.date_to, 'DD/MM/YY') ELSE NULL END
            )
            ORDER BY lr.id
        ) AS loyalty_discount,
        SUM(
            CASE
                WHEN lr.discount_mode = 'percent' THEN
                    TRUNC(GREATEST(pp.ecommerce_float_price - (pp.ecommerce_float_price * lr.discount / 100), 0)::numeric, 2)
                ELSE
                    TRUNC(GREATEST(pp.ecommerce_float_price - lr.discount, 0)::numeric, 2)
            END
        ) AS loyalty_product_discounts
    FROM page_products pp
    JOIN active_loyalty_programs lp ON lp.company_id = pp.company_id
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    GROUP BY pp.id
),

product_attributes AS (
    SELECT
        product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', attribute_id,
                'attribute', attribute_name,
                'values', attribute_values
            )
            ORDER BY attribute_id
        ) AS variant_type
    FROM (
        SELECT
            pt.id AS product_tmpl_id,
            pa.id AS attribute_id,
            pa.name ->> 'en_US' AS attribute_name,
            JSONB_AGG(
                CASE
                    WHEN pa.display_type = 'color' THEN
                        JSONB_BUILD_OBJECT(
                            'id', pav.id,
                            'name', CASE WHEN jsonb_typeof(pav.name) = 'object' THEN pav.name ->> 'en_US' ELSE pav.name::text END,
                            'color', COALESCE(NULLIF(pav.html_color, ''), '#FFFFFF')
                        )
                    ELSE
                        JSONB_BUILD_OBJECT(
                            'id', pav.id,
                            'name', CASE WHEN jsonb_typeof(pav.name) = 'object' THEN pav.name ->> 'en_US' ELSE pav.name::text END
                        )
                END
                ORDER BY pav.id
            ) AS attribute_values
        FROM page_products pt
        JOIN product_template_attribute_line ptal ON ptal.product_tmpl_id = pt.id
        JOIN product_attribute pa ON pa.id = ptal.attribute_id
        JOIN product_attribute_value_product_template_attribute_line_rel rel
            ON rel.product_template_attribute_line_id = ptal.id
        JOIN product_attribute_value pav ON pav.id = rel.product_attribute_value_id
        GROUP BY pt.id, pa.id, pa.name, pa.display_type
    ) attribute_data
    GROUP BY product_tmpl_id
),

wishlist_products AS (
    SELECT DISTINCT pp.product_tmpl_id
    FROM wishlist wl
    JOIN product_product pp ON pp.id = wl.product_id
    JOIN res_partner rp ON rp.id = wl.user_id
    CROSS JOIN request_params r
    WHERE wl.is_active = TRUE
      AND r.app_user_id IS NOT NULL
      AND rp.app_user_id = TRIM(r.app_user_id)
),

final_products AS (
    SELECT
        pp.*,
        COALESCE(pd.discount, '[]'::jsonb) AS direct_discount,
        COALESCE(pd.product_discounts, 0) AS direct_product_discounts,
        COALESCE(ld.loyalty_discount, '[]'::jsonb) AS loyalty_discount,
        COALESCE(ld.loyalty_product_discounts, 0) AS loyalty_product_discounts,
        pa.variant_type,
        EXISTS (
            SELECT 1
            FROM wishlist_products wp
            WHERE wp.product_tmpl_id = pp.id
        ) AS is_wishlisted
    FROM page_products pp
    LEFT JOIN product_discounts pd ON pd.product_tmpl_id = pp.id
    LEFT JOIN loyalty_discount_data ld ON ld.product_tmpl_id = pp.id
    LEFT JOIN product_attributes pa ON pa.product_tmpl_id = pp.id
)

SELECT
    fp.id,
    fp.name ->> 'en_US' AS name,
    NULLIF(fp.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(fp.image_1920_url, '') AS product_image,
    fp.ecommerce_float_price AS list_price,
    u.name ->> 'en_US' AS "UoM",
    CASE WHEN fp.direct_discount <> '[]'::jsonb THEN fp.direct_discount ELSE fp.loyalty_discount END AS discount,
    CASE WHEN fp.direct_discount <> '[]'::jsonb THEN fp.direct_product_discounts ELSE fp.loyalty_product_discounts END AS product_discounts,
    COALESCE(fp.t_is_featured, FALSE) AS is_featured,
    COALESCE(fp.is_halal, FALSE) AS is_halal,
    COALESCE(fp.is_arrival, FALSE) AS is_arrival,
    COALESCE(fp.api_qty_available, 0.0) AS available_quantity,
    NULLIF(fp.min_quantity, 0) AS min_quantity,
    NULLIF(fp.max_quantity, 0) AS max_quantity,
    COALESCE(fp.total_reviews, 0) AS total_review_count,
    COALESCE(fp.average_rating, 0.0) AS average_rating,
    COALESCE(fp.total_variants, 0) AS total_variants,
    fp.variant_type,
    JSONB_BUILD_OBJECT(
        'merchant', fp.merchant,
        'name', fp.company_name,
        'logo', NULLIF(fp.logo_url, '')
    ) AS merchant,
    fp.is_wishlisted,
    COALESCE(fp.api_qty_available, 0.0) AS available_qty,
    COALESCE(fp.api_virtual_available, 0.0) AS virtual_available,
    pc.total
FROM final_products fp
CROSS JOIN product_count pc
LEFT JOIN uom_uom u ON u.id = fp.uom_id
ORDER BY
    CASE
        WHEN (SELECT price_sort_direction FROM request_params) = 'desc'
            THEN fp.ecommerce_float_price
    END DESC,
    CASE
        WHEN (SELECT price_sort_direction FROM request_params) = 'asc'
            THEN fp.ecommerce_float_price
    END ASC,
    fp.id DESC;



```

## Endpoint 20 — GET /api/v1/merchants/list_all

```sql
WITH params AS (
    SELECT
        1::int AS page,
        10::int AS per_page,
        NULL::text AS is_featured_param,
        NULL::text AS is_discount_param,
        NULL::text AS is_delivery_param,
        NULL::int AS limit_param
),

p AS (
    SELECT
        page,
        per_page,
        ((page - 1) * per_page) AS offset_value,
        CASE
            WHEN lower(trim(coalesce(is_featured_param, '')))
                IN ('true', 'yes', '1')
            THEN TRUE
            ELSE FALSE
        END AS featured_filter,
        CASE
            WHEN lower(trim(coalesce(is_discount_param, '')))
                IN ('true', 'yes', '1')
            THEN TRUE
            WHEN lower(trim(coalesce(is_discount_param, '')))
                IN ('false', 'no', '0')
            THEN FALSE
            ELSE NULL
        END AS discount_filter,
        CASE
            WHEN lower(trim(coalesce(is_delivery_param, '')))
                IN ('true', 'yes', '1')
            THEN TRUE
            WHEN lower(trim(coalesce(is_delivery_param, '')))
                IN ('false', 'no', '0')
            THEN FALSE
            ELSE FALSE
        END AS delivery_filter,
        limit_param
    FROM params
),

active_loyalty_companies AS (
    SELECT DISTINCT
        lp.company_id
    FROM loyalty_program lp
    CROSS JOIN p
    WHERE p.discount_filter IS NOT NULL
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (
          lp.date_from IS NULL
          OR lp.date_from <= CURRENT_DATE
      )
      AND (
          lp.date_to IS NULL
          OR lp.date_to >= CURRENT_DATE
      )
),

filtered_merchant_ids AS (
    SELECT
        c.id
    FROM res_company c
    CROSS JOIN p
    LEFT JOIN active_loyalty_companies alc
        ON alc.company_id = c.id
    WHERE c.parent_id IS NULL
      AND c.merchant IS NOT NULL
      AND c.merchant <> ''
      AND c.cps_enabled = TRUE
      AND c.active = TRUE
      AND c.is_delivery = p.delivery_filter
      AND (
          NOT p.featured_filter
          OR c.is_featured = TRUE
      )
      AND (
          p.discount_filter IS NULL
          OR (alc.company_id IS NOT NULL) = p.discount_filter
      )
),
numbered_merchant_ids AS (
    SELECT
        fmi.id,
        ROW_NUMBER() OVER (
            ORDER BY fmi.id DESC
        ) AS row_num
    FROM filtered_merchant_ids fmi
),
paginated_merchant_ids AS (
    SELECT
        nmi.id
    FROM numbered_merchant_ids nmi
    CROSS JOIN p
    WHERE nmi.row_num > p.offset_value
      AND nmi.row_num <=
          CASE
              WHEN p.limit_param IS NULL
              THEN p.offset_value + p.per_page
              ELSE LEAST(
                  p.offset_value + p.per_page,
                  p.limit_param
              )
          END
),
paginated_merchants AS (
    SELECT
        c.id,
        c.name,
        c.merchant,
        c.logo_url,
        c.banner_url,
        c.product_count,
        c.open_hour,
        c.open_moment,
        c.close_hour,
        c.close_moment,
        c.cps_account_number,
        c.business_type_id
    FROM paginated_merchant_ids pm
    INNER JOIN res_company c
        ON c.id = pm.id
),

page_loyalty_programs AS (
    SELECT
        lp.company_id,
        lp.id AS program_id,
        lp.name AS program_name,
        lp.sequence,
        ROW_NUMBER() OVER (
            PARTITION BY lp.company_id
            ORDER BY
                lp.sequence,
                lp.id
        ) AS loyalty_row_num
    FROM loyalty_program lp
    INNER JOIN paginated_merchant_ids pm
        ON pm.id = lp.company_id
    WHERE lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (
          lp.date_from IS NULL
          OR lp.date_from <= CURRENT_DATE
      )
      AND (
          lp.date_to IS NULL
          OR lp.date_to >= CURRENT_DATE
      )
),
page_loyalty AS (
    SELECT
        plp.company_id,
        TRUE AS is_discount,
        json_build_array(
            json_build_object(
                'id', plp.program_id,
                'name', plp.program_name ->> 'en_US',
                'rewards',
                COALESCE(
                    json_agg(
                        json_build_object(
                            'reward_type', lr.reward_type,
                            'discount', lr.discount,
                            'discount_mode', lr.discount_mode,
                            'discount_applicability', lr.discount_applicability,
                            'description', lr.description ->> 'en_US'
                        )
                        ORDER BY lr.id
                    )
                    FILTER (WHERE lr.id IS NOT NULL),
                    '[]'::json
                )
            )
        ) AS discount
    FROM page_loyalty_programs plp
    LEFT JOIN loyalty_reward lr
        ON lr.program_id = plp.program_id
    WHERE plp.loyalty_row_num = 1
    GROUP BY
        plp.company_id,
        plp.program_id,
        plp.program_name
)
SELECT
    pm.id AS company_id,
    pm.name,
    pm.merchant AS merchant_id,
    NULLIF(pm.logo_url, '') AS logo,
    NULLIF(pm.banner_url, '') AS banner,
    bt.code AS business_type,
    COALESCE(pm.product_count, 0) AS total_products,
    CASE
        WHEN pm.open_hour IS NOT NULL
         AND pm.open_moment IS NOT NULL
        THEN
            LPAD(FLOOR(pm.open_hour)::int::text, 2, '0')
            || ':' ||
            LPAD(
                LEAST(
                    FLOOR((pm.open_hour - FLOOR(pm.open_hour)) * 60)::numeric,
                    59
                )::int::text,
                2, '0'
            )
            || ' ' || UPPER(pm.open_moment)
        ELSE NULL
    END AS opening_time,
    CASE
        WHEN pm.close_hour IS NOT NULL
         AND pm.close_moment IS NOT NULL
        THEN
            LPAD(FLOOR(pm.close_hour)::int::text, 2, '0')
            || ':' ||
            LPAD(
                LEAST(
                    FLOOR((pm.close_hour - FLOOR(pm.close_hour)) * 60)::numeric,
                    59
                )::int::text,
                2, '0'
            )
            || ' ' || UPPER(pm.close_moment)
        ELSE NULL
    END AS closing_time,
    NULLIF(pm.cps_account_number, '') AS cps_account_number,
    COALESCE(pl.is_discount, FALSE) AS is_discount,
    COALESCE(pl.discount, '[]'::json) AS discount,
    (SELECT COUNT(*) FROM filtered_merchant_ids) AS total
FROM paginated_merchants pm
LEFT JOIN company_business_type bt
    ON bt.id = pm.business_type_id
LEFT JOIN page_loyalty pl
    ON pl.company_id = pm.id
ORDER BY
    pm.id DESC;

```

## Endpoint 21 — GET /api/v1/merchant/{merchant}

```sql

WITH params AS (
    SELECT
        NULL::text AS merchant
),
merchant_company AS (
    SELECT
        c.id, c.name, c.merchant,
        c.logo_url, c.banner_url, c.product_count, c.variant_count,
        c.open_hour, c.open_moment, c.close_hour, c.close_moment,
        c.cps_account_number, c.lat_location, c.lng_location,
        c.map_holder, c.description, c.is_featured,
        c.is_delivery, c.business_type_id, c.partner_id
    FROM params p
    JOIN res_company c
        ON c.merchant = p.merchant
    WHERE c.active IS TRUE
    LIMIT 1
),
branches AS (
    SELECT
        b.id, b.parent_id, b.name,
        b.merchant, b.logo_url, b.banner_url,
        b.product_count, b.variant_count, b.open_hour,
        b.open_moment, b.close_hour, b.close_moment,
        b.cps_account_number, b.lat_location, b.lng_location,
        b.map_holder, b.description, b.is_featured, b.is_delivery,
        b.business_type_id, b.partner_id
    FROM res_company b
    JOIN merchant_company mc
        ON mc.id = b.parent_id
    WHERE b.cps_enabled IS TRUE
      AND COALESCE(b.is_delivery, FALSE) IS FALSE
      AND b.active IS TRUE
      AND b.merchant IS NOT NULL
      AND b.merchant != ''
),
branch_payload AS (
    SELECT
        b.parent_id,
        jsonb_agg(
            jsonb_build_object(
                'id', b.id,
                'name', b.name,
                'branch_id', b.merchant,
                'logo', b.logo_url,
				'banner', b.banner_url,
                'is_featured',COALESCE(b.is_featured, FALSE),
                'business_type',bbt.code,
                'opening_time',
                CASE
                    WHEN b.open_hour IS NOT NULL
                     AND b.open_moment IS NOT NULL
                    THEN
                        LPAD(FLOOR(b.open_hour)::int::text,2,'0')
                        || ':'||
                        LPAD(
                            LEAST(
                                FLOOR( ( b.open_hour - FLOOR(b.open_hour) ) * 60 )::numeric, 59
                            )::int::text, 2,'0'
                        )
                        || ' ' || UPPER(b.open_moment)
                    ELSE NULL
                END,
                'closing_time',
                CASE
                    WHEN b.close_hour IS NOT NULL
                     AND b.close_moment IS NOT NULL
                    THEN
                        LPAD(FLOOR(b.close_hour)::int::text,2,'0')
                        || ':' ||
                        LPAD(
                            LEAST(
                                FLOOR((b.close_hour - FLOOR(b.close_hour) ) * 60)::numeric,59
                            )::int::text,2,'0'
                        )
                        || ' ' || UPPER(b.close_moment)
                    ELSE NULL
                END,
                'cps_account_number',NULLIF(b.cps_account_number,''),
                'email',NULLIF(brp.email,''),
                'phone',NULLIF(brp.phone,''),
                'lat_location',NULLIF(b.lat_location,0),
                'lng_location',NULLIF(b.lng_location,0),
                'map_holder',NULLIF(b.map_holder,''),
                'street',NULLIF(brp.street,''),
                'city',NULLIF(brp.city,''),
                'description',NULLIF(b.description,''),
                'product_template_count',COALESCE(b.product_count,0),
                'product_variant_count',COALESCE(b.variant_count,0),
                'is_delivery',COALESCE(b.is_delivery,FALSE),
                'is_ecommerce',NOT COALESCE(b.is_delivery,FALSE)
            )
            ORDER BY b.id
        ) AS branches
    FROM branches b
    LEFT JOIN company_business_type bbt
        ON bbt.id = b.business_type_id
    LEFT JOIN res_partner brp
        ON brp.id = b.partner_id
    GROUP BY
        b.parent_id
)
SELECT
    mc.id,
    mc.name,
    mc.merchant AS merchant_id,
    bt.code AS business_type,
    NULLIF( mc.logo_url,'') AS logo,
    COALESCE( mc.is_featured, FALSE ) AS is_featured,
    NULLIF( mc.banner_url, '' ) AS banner,
    CASE
        WHEN mc.open_hour IS NOT NULL
         AND mc.open_moment IS NOT NULL
        THEN
            LPAD( FLOOR(mc.open_hour)::int::text, 2, '0' )
            || ':' ||
            LPAD(
                LEAST(
                    FLOOR((mc.open_hour - FLOOR(mc.open_hour) ) * 60 )::numeric,59
                )::int::text,2,'0')
            || ' ' || UPPER(mc.open_moment)
        ELSE NULL
    END AS opening_time,
    CASE
        WHEN mc.close_hour IS NOT NULL
         AND mc.close_moment IS NOT NULL
        THEN
            LPAD( FLOOR(mc.close_hour)::int::text, 2,'0' )
            || ':' ||
            LPAD(
                LEAST(
                    FLOOR(
                        ( mc.close_hour - FLOOR(mc.close_hour) ) * 60
                    )::numeric, 59
                )::int::text, 2,'0'
            )
            || ' ' || UPPER(mc.close_moment)
        ELSE NULL
    END AS closing_time,
    NULLIF(mc.cps_account_number,'') AS cps_account_number,
    NULLIF(mc.lat_location,0) AS lat_location,
    NULLIF(mc.lng_location,0) AS lng_location,
    NULLIF(mc.map_holder,'') AS map_holder,
    NULLIF(rp.street,'') AS street,
    NULLIF(rp.city,'') AS city,
    NULLIF(mc.description,'') AS description,
    COALESCE(bp.branches,'[]'::jsonb) AS branches,
    COALESCE(mc.product_count,0) AS product_template_count,
    COALESCE(mc.variant_count,0) AS product_variant_count,
    COALESCE(mc.is_delivery,FALSE) AS is_delivery,
    NOT COALESCE(mc.is_delivery,FALSE) AS is_ecommerce
FROM merchant_company mc
LEFT JOIN company_business_type bt
    ON bt.id = mc.business_type_id
LEFT JOIN res_partner rp
    ON rp.id = mc.partner_id
LEFT JOIN branch_payload bp
    ON bp.parent_id = mc.id;


	

```

## Endpoint 22 — GET /api/v1/wishlist/{user_id}

Path: user_id
Query: page, per_page, min_price, max_price, category_id, high_to_low, order
$1=app_user_id $2=min_price $3=max_price [$4=category_id] $N=per_page $N+1=offset
Returns: partner_exists, total_count, item rows (one null row when empty)


```sql
WITH partner AS (
    SELECT id FROM res_partner WHERE app_user_id = $1 LIMIT 1
),
guard AS (
    SELECT EXISTS(SELECT 1 FROM partner) AS partner_exists
),
filtered AS (
    SELECT wl.id, pt.id AS product_id,
           COALESCE(pt.name->>'en_US', pt.name::text) AS name,
           wl.ecommerce_float_price AS price, pt.company_id,
           COALESCE(pt.image_1920_url, '') AS product_image
    FROM partner
    JOIN wishlist wl ON wl.user_id = partner.id
    JOIN product_template pt ON pt.id = wl.product_id
    LEFT JOIN res_company rc ON rc.id = pt.company_id
    WHERE wl.user_id = partner.id AND wl.is_active = TRUE AND rc.cps_enabled = TRUE
      AND wl.ecommerce_float_price >= $2 AND wl.ecommerce_float_price <= $3
      -- AND pt.ecomerce_category_id = $4
),
base AS (
    SELECT f.* FROM filtered f
    ORDER BY id DESC
    LIMIT $4 OFFSET $5
)
SELECT g.partner_exists,
       COALESCE((SELECT COUNT(*)::int FROM filtered), 0) AS total_count,
       b.id, b.product_id, b.name,
       COALESCE(rev.avg_rating, 0.0)::numeric AS avg_rating, rev.total_review,
       (SELECT COUNT(*) FROM product_product pp WHERE pp.product_tmpl_id = b.product_id AND pp.active = TRUE) AS total_variants,
       b.price, b.product_image,
       CASE WHEN disc_all.discount_sum IS NOT NULL
             OR (COALESCE(disc_listed.cnt, 0) = 0 AND loy.discount_sum IS NOT NULL)
           THEN COALESCE(disc_all.discount_sum, 0) + CASE WHEN COALESCE(disc_listed.cnt, 0) = 0
               THEN COALESCE(loy.discount_sum, 0) ELSE 0 END
           ELSE NULL END AS discounts,
       COALESCE(disc_listed.discount_json, loy.discount_json) AS loyalty_programs
FROM guard g
LEFT JOIN base b ON g.partner_exists
LEFT JOIN LATERAL (
    SELECT AVG(NULLIF(pr.rating, '')::numeric) AS avg_rating, COUNT(pr.id) AS total_review
    FROM product_review pr WHERE pr.product_template = b.product_id
) rev ON b.product_id IS NOT NULL
LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN d.discount_type = 'percentage'
        THEN ROUND((b.price - (b.price * d.discount_value / 100))::numeric, 2)
        ELSE ROUND((b.price - d.discount_value)::numeric, 2) END) AS discount_sum
    FROM product_discount d
    WHERE d.product_tmpl_id = b.product_id AND d.is_active = TRUE
      AND d.x_superapp_approval_status = 'approved'
      AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
      AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)
) disc_all ON b.product_id IS NOT NULL
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt,
           json_agg(json_build_object('name', d.name, 'discount_type', INITCAP(d.discount_type),
               'discount_value', d.discount_value::text,
               'start_date', TO_CHAR(d.start_date, 'DD/MM/YY'), 'end_date', TO_CHAR(d.end_date, 'DD/MM/YY'))) AS discount_json
    FROM product_discount d
    WHERE d.product_tmpl_id = b.product_id AND d.is_active = TRUE AND d.company_id IS NOT NULL
      AND d.x_superapp_approval_status = 'approved'
      AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
      AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)
) disc_listed ON b.product_id IS NOT NULL
LEFT JOIN LATERAL (
    SELECT SUM(ROUND((CASE WHEN lr.discount_mode = 'percent'
        THEN b.price - (b.price * lr.discount / 100) ELSE b.price - lr.discount END)::numeric, 2)) AS discount_sum,
           json_agg(json_build_object('name', lp.name->>'en_US',
               'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
               'discount_value', lr.discount::text,
               'start_date', TO_CHAR(lp.date_from, 'DD/MM/YY'), 'end_date', TO_CHAR(lp.date_to, 'DD/MM/YY'))) AS discount_json
    FROM loyalty_program lp
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    WHERE COALESCE(disc_listed.cnt, 0) = 0
      AND lp.id = (SELECT lp2.id FROM loyalty_program lp2
          WHERE lp2.company_id = b.company_id AND lp2.is_ecommerce = TRUE
            AND lp2.x_superapp_approval_status = 'approved'
            AND (lp2.date_from IS NULL OR lp2.date_from <= CURRENT_DATE)
            AND (lp2.date_to IS NULL OR lp2.date_to >= CURRENT_DATE)
          ORDER BY lp2.id LIMIT 1)
) loy ON b.product_id IS NOT NULL
ORDER BY b.id DESC;
```

## Endpoint 23 — GET /api/v1/driver/orders

**Driver Orders List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_id,
	iso.superapp_order_status AS status,
    order_comp.logo_url AS logo,
	dop_partner.name AS "from",
	COALESCE(order_partner.street, '') || ', ' || COALESCE(order_partner.city, '') || ' ' || COALESCE(rcs.name, '') AS pickup_location, 
    to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date,
json_build_object(
    'images', json_agg(pt.image_1920_url),
    'number',  COUNT(dol)
) AS items

FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id

LEFT JOIN res_country_state rcs
    ON order_partner.state_id = rcs.id

LEFT JOIN delivery_order_line dol
    ON dol.delivery_order_id = dop.id

LEFT JOIN product_template pt
    ON dol.product_id = pt.id
LEFT JOIN sale_order dso ON dso.id = dop.so_id
LEFT JOIN sale_order iso ON iso.id = dop.sale_order_id::integer


WHERE
    ru.token = %s --'112b196a55260038feae474675478dab'
	AND ru.token_expiration_time > NOW()
 AND dop.state IN ('driver', 'picked')
GROUP BY
    dop.id,
    dop.name,
    order_comp.logo_url,
    order_comp.name,
    order_partner.street,
    order_partner.city,
	dso.superapp_order_status,
    rcs.name,
    dop.delivery_date,
    dop_partner.name,
    iso.superapp_order_status

ORDER BY dop.id DESC
LIMIT %s -- 10
OFFSET %s -- 0;
```


## Endpoint 24 — GET /api/v1/driver/order/{order_id:int}

**Driver Order Detail**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS ref_no,
	iso.superapp_order_status AS status,
json_build_object(
    'id', order_comp.id,
    'name', order_comp.name,
    'logo', order_comp.logo_url,
    'phone', order_comp.phone
) AS pickup_from,
	COALESCE(order_partner.street, '') || ', ' || COALESCE(order_partner.city, '') || ' ' || COALESCE(rcs.name, '') AS pickup_location, 
   to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date,
	dop.delivery_pickup_code,
		json_build_object (
'lat',dop.delivery_lat,'lng',dop.delivery_long
	) AS coordinates,
	dop.customer_location AS customer_location,
	
	json_build_object(
'name',customer.name,'phone',customer.phone,'location',customer_state.name
	) customer_info,


dop.delivery_notes AS additional_note,
	json_agg(
json_build_object(
'id',dol.id,'name',pt.name->>'en_US','image',pt.image_1920_url,
'qunatity',dol.quantity,'uom',uom.name->>'en_US','description',dol.description
)
	) AS items

FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id

LEFT JOIN res_country_state rcs
    ON order_partner.state_id = rcs.id

LEFT JOIN delivery_order_line dol
    ON dol.delivery_order_id = dop.id
LEFT JOIN uom_uom uom ON dol.uom = uom.id

LEFT JOIN product_template pt
    ON dol.product_id = pt.id
LEFT JOIN sale_order dso ON dso.id = dop.so_id
LEFT JOIN sale_order iso ON iso.id = dop.sale_order_id::integer

LEFT JOIN res_partner customer ON dop.customer_id = customer.id
LEFT JOIN res_country_state customer_state ON customer.state_id = customer_state.id 

WHERE
     ru.token = %s --'112b196a55260038feae474675478dab'
	AND ru.token_expiration_time > NOW()
AND dop.state IN ('driver', 'picked')
 AND dop.id = %s --54

GROUP BY
    dop.id,
    dop.name,
	order_comp.id,
    order_comp.logo_url,
    order_comp.name,
    order_partner.street,
    order_partner.city,
	dso.superapp_order_status,
	customer.id,
	customer_state.name,
    rcs.name,
	iso.superapp_order_status,
    dop.delivery_date;
```


## Endpoint 25 — GET /api/v1/driver/history

**Driver History List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_no,
	json_build_object(
'name',order_comp.name,'branch',order_partner.street
	) AS pickup_from,
	to_char(dop.delivery_date, 'MM/DD/YYYY') AS date,
	dop.state AS status
   
FROM delivery_order dop

LEFT JOIN res_partner rp
    ON rp.id = dop.driver_assigned

LEFT JOIN res_users ru
    ON ru.partner_id = rp.id

LEFT JOIN res_company rc
    ON rc.id = dop.company_id

LEFT JOIN res_partner dop_partner
    ON dop_partner.id = dop.partner_id

LEFT JOIN res_company order_comp
    ON order_comp.name = dop_partner.name

LEFT JOIN res_partner order_partner
    ON order_partner.id = order_comp.partner_id



WHERE
    ru.token =%s --	 '112b196a55260038feae474675478dab'
AND ru.token_expiration_time > NOW()
AND dop.state IN ('delivered', 'canceled')

GROUP BY
    dop.id,
    dop.name,
    order_comp.name,
    order_partner.street
ORDER BY dop.id DESC
LIMIT %s -- 10
OFFSET %s -- 0;
```

## Endpoint 26 — GET /api/v1/categories

```sql


WITH params AS (
    SELECT
        NULL::int AS page,
        NULL::int AS per_page
),

request_params AS (
    SELECT
        p.*,
        CASE
            WHEN p.page IS NULL OR p.per_page IS NULL
                THEN NULL
            ELSE (p.page - 1) * p.per_page
        END AS requested_offset
    FROM params p
),

active_categories AS (
    SELECT
        c.id,
        c.name,
        c.image_1_url,
        c.category_banner_url,
        c.product_count,
        c.description
    FROM product_ecomerce_categories c
    WHERE c.parent_id IS NULL
      AND c.active IS TRUE
),

total_count AS (
    SELECT COUNT(*)::int AS total
    FROM active_categories
),

paged_categories AS (
    SELECT
        c.*
    FROM active_categories c
    ORDER BY c.id
    LIMIT (
        SELECT per_page
        FROM request_params
    )
    OFFSET (
        SELECT COALESCE(requested_offset, 0)
        FROM request_params
    )
)
SELECT
    c.id,
    c.name,
    NULLIF(c.image_1_url, '') AS image,
    NULLIF(c.category_banner_url, '') AS banner,
    COALESCE(c.product_count, 0) AS items,
    c.description,
    tc.total
FROM paged_categories c
CROSS JOIN total_count tc
ORDER BY c.id;

```


## Endpoint 27 — GET /api/v1/categories/{category_id:int}

```sql
WITH params AS (
    SELECT NULL::int AS category_id
),
target_category AS (
    SELECT
        c.id,
        c.name,
        c.complete_name,
        c.parent_id,
        c.image_1_url,
        c.category_banner_url,
        c.product_count
    FROM product_ecomerce_categories c
    JOIN params p ON p.category_id = c.id
    WHERE c.active IS TRUE
),
children AS (
    SELECT
        c.id,
        c.name,
        c.complete_name,
        c.image_1_url,
        c.category_banner_url
    FROM product_ecomerce_categories c
    JOIN target_category tc ON tc.id = c.parent_id
    WHERE c.active IS TRUE
),
children_json AS (
    SELECT
        COALESCE(
            JSONB_AGG(
                JSONB_BUILD_OBJECT(
                    'id', c.id,
                    'name', COALESCE(c.name, ''),
                    'complete_name', COALESCE(c.complete_name, ''),
                    'image', NULLIF(c.image_1_url, ''),
                    'banner', NULLIF(c.category_banner_url, '')
                )
                ORDER BY c.id
            ),
            '[]'::jsonb
        ) AS children
    FROM children c
)
SELECT
    tc.id,
    COALESCE(tc.name, '') AS name,
    NULLIF(tc.image_1_url, '') AS image,
    CASE
        WHEN tc.parent_id IS NOT NULL THEN
            JSONB_BUILD_OBJECT(
                'id', parent.id,
                'name', COALESCE(parent.name, ''),
                'complete_name', COALESCE(parent.complete_name, ''),
                'image', NULLIF(parent.image_1_url, ''),
                'banner', NULLIF(parent.category_banner_url, '')
            )
        ELSE NULL
    END AS parent_category,
    cj.children AS child_categories,
    (SELECT COUNT(*)::int FROM children) AS child_count,
    COALESCE(tc.product_count, 0) AS items
FROM target_category tc
LEFT JOIN product_ecomerce_categories parent
    ON parent.id = tc.parent_id
CROSS JOIN children_json cj;

```


## Endpoint 28 — GET /api/v1/product/{product_tmpl_id:int}

```sql

WITH RECURSIVE
params AS (
    SELECT NULL::int AS product_tmpl_id
),

allowed_parent_companies AS (
    SELECT c.id, c.parent_id
    FROM res_company c
    WHERE c.parent_id IS NULL
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND c.active = TRUE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
),

allowed_companies AS (
    SELECT apc.id, apc.parent_id, 1 AS depth
    FROM allowed_parent_companies apc
    UNION ALL
    SELECT c.id, c.parent_id, ac.depth + 1
    FROM res_company c
    JOIN allowed_companies ac ON ac.id = c.parent_id
    WHERE ac.depth < 10
      AND c.cps_enabled = TRUE
      AND c.active = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
),

product AS (
    SELECT
        pt.id,
        pt.name,
        pt.description_sale,
        pt.ecommerce_float_price,
        pt.api_qty_available,
        pt.api_virtual_available,
        pt.is_in_stock,
        pt.image_1920_url,
        pt.image_1_url,
        pt.image_2_url,
        pt.image_3_url,
        pt.image_4_url,
        pt.image_5_url,
        pt.image_6_url,
        pt.uom_id,
        pt.company_id,
        pt.t_is_featured,
        pt.is_halal,
        pt.is_arrival,
        pt.min_quantity,
        pt.max_quantity,
        pt.ecomerce_category_id,
        c.merchant,
        c.name AS merchant_name,
        c.has_logo,
        c.logo_url,
        c.currency_id AS cost_currency_id,
        c.lat_location,
        c.lng_location,
        rp.city,
        st.name AS state_name
    FROM product_template pt
    JOIN res_company c ON c.id = pt.company_id
    LEFT JOIN res_partner rp ON rp.id = c.partner_id
    LEFT JOIN res_country_state st ON st.id = rp.state_id
    CROSS JOIN params p
    WHERE pt.id = p.product_tmpl_id
      AND pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND EXISTS (
          SELECT 1
          FROM allowed_companies ac
          WHERE ac.id = pt.company_id
      )
),

active_product_discounts AS (
    SELECT
        pd.id,
        pd.product_tmpl_id,
        pd.name,
        pd.discount_type,
        pd.discount_value,
        pd.start_date,
        pd.end_date
    FROM product_discount pd
    JOIN product p ON p.id = pd.product_tmpl_id
    WHERE pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
),

discount_data AS (
    SELECT
        p.id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', NULLIF(TRIM(pd.name), ''),
                'discount_type', CASE
                    WHEN pd.discount_type IS NOT NULL THEN INITCAP(pd.discount_type)
                    ELSE NULL
                END,
                'discount_value', CASE
                    WHEN pd.discount_value IS NULL THEN NULL
                    WHEN pd.discount_value::numeric = TRUNC(pd.discount_value::numeric)
                        THEN TRUNC(pd.discount_value::numeric)::text || '.0'
                    ELSE RTRIM(
                        RTRIM(
                            TO_CHAR(
                                pd.discount_value::numeric,
                                'FM999999999999990.999999999999'
                            ),
                            '0'
                        ),
                        '.'
                    )
                END,
                'start_date', CASE
                    WHEN pd.start_date IS NOT NULL THEN TO_CHAR(pd.start_date, 'DD/MM/YY')
                    ELSE NULL
                END,
                'end_date', CASE
                    WHEN pd.end_date IS NOT NULL THEN TO_CHAR(pd.end_date, 'DD/MM/YY')
                    ELSE NULL
                END
            )
            ORDER BY pd.id
        ) AS discount,
        SUM(
            CASE
                WHEN pd.discount_type = 'percentage' THEN
                    TRUNC(
                        GREATEST(
                            p.ecommerce_float_price -
                            (p.ecommerce_float_price * pd.discount_value / 100),
                            0
                        )::numeric,
                        2
                    )
                ELSE
                    TRUNC(
                        GREATEST(
                            p.ecommerce_float_price - pd.discount_value,
                            0
                        )::numeric,
                        2
                    )
            END
        ) AS product_discounts
    FROM product p
    JOIN active_product_discounts pd ON pd.product_tmpl_id = p.id
    GROUP BY p.id
),

active_loyalty_program AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.name,
        lp.date_from,
        lp.date_to,
        lp.company_id
    FROM loyalty_program lp
    JOIN product p ON p.company_id = lp.company_id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.company_id, lp.sequence ASC, lp.id
),

loyalty_discount_data AS (
    SELECT
        p.id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', NULLIF(TRIM(lp.name ->> 'en_US'), ''),
                'discount_type', CASE
                    WHEN lr.discount_mode = 'percent' THEN 'Percentage'
                    ELSE INITCAP(lr.discount_mode)
                END,
                'discount_value', CASE
                    WHEN lr.discount IS NULL THEN NULL
                    WHEN lr.discount::numeric = TRUNC(lr.discount::numeric)
                        THEN TRUNC(lr.discount::numeric)::text || '.0'
                    ELSE RTRIM(
                        RTRIM(
                            TO_CHAR(
                                lr.discount::numeric,
                                'FM999999999999990.999999999999'
                            ),
                            '0'
                        ),
                        '.'
                    )
                END,
                'start_date', CASE
                    WHEN lp.date_from IS NOT NULL THEN TO_CHAR(lp.date_from, 'DD/MM/YY')
                    ELSE NULL
                END,
                'end_date', CASE
                    WHEN lp.date_to IS NOT NULL THEN TO_CHAR(lp.date_to, 'DD/MM/YY')
                    ELSE NULL
                END
            )
            ORDER BY lr.id
        ) AS discount,
        SUM(
            CASE
                WHEN lr.discount_mode = 'percent' THEN
                    TRUNC(
                        GREATEST(
                            p.ecommerce_float_price -
                            (p.ecommerce_float_price * lr.discount / 100),
                            0
                        )::numeric,
                        2
                    )
                ELSE
                    TRUNC(
                        GREATEST(
                            p.ecommerce_float_price - lr.discount,
                            0
                        )::numeric,
                        2
                    )
            END
        ) AS product_discounts
    FROM product p
    JOIN active_loyalty_program lp ON lp.company_id = p.company_id
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    GROUP BY p.id
),

final_discounts AS (
    SELECT
        p.id AS product_tmpl_id,
        CASE
            WHEN dd.discount IS NOT NULL
             AND JSONB_ARRAY_LENGTH(COALESCE(dd.discount, '[]'::jsonb)) > 0
                THEN dd.discount
            ELSE COALESCE(ld.discount, '[]'::jsonb)
        END AS discount,
        CASE
            WHEN dd.discount IS NOT NULL
             AND JSONB_ARRAY_LENGTH(COALESCE(dd.discount, '[]'::jsonb)) > 0
                THEN COALESCE(dd.product_discounts, 0)
            ELSE COALESCE(ld.product_discounts, 0)
        END AS product_discounts
    FROM product p
    LEFT JOIN discount_data dd ON dd.product_tmpl_id = p.id
    LEFT JOIN loyalty_discount_data ld ON ld.product_tmpl_id = p.id
),

review_data AS (
    SELECT
        pr.product_template,
        COUNT(*)::int AS total_reviews,
        ROUND(AVG(pr.rating::numeric), 2) AS average_rating
    FROM product_review pr
    JOIN product p ON p.id = pr.product_template
    GROUP BY pr.product_template
),

variant_stock AS (
    SELECT
        pp.id AS product_id,
        SUM(sq.quantity) AS qty_available,
        SUM(sq.quantity - COALESCE(sq.reserved_quantity, 0)) AS virtual_available
    FROM product_product pp
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN product p ON p.id = pt.id
    JOIN stock_quant sq ON sq.product_id = pp.id
    JOIN stock_location sl
        ON sl.id = sq.location_id
       AND sl.usage = 'internal'
       AND sl.company_id = pt.company_id
    GROUP BY pp.id
),

template_attribute_values AS (
    SELECT
        ptal.product_tmpl_id,
        pa.id AS attribute_id,
        pa.name ->> 'en_US' AS attribute_name,
        pa.display_type,
        pav.id AS value_id,
        pav.name ->> 'en_US' AS value_name
    FROM product_template_attribute_line ptal
    JOIN product p ON p.id = ptal.product_tmpl_id
    JOIN product_attribute pa ON pa.id = ptal.attribute_id
    JOIN product_attribute_value_product_template_attribute_line_rel rel
        ON rel.product_template_attribute_line_id = ptal.id
    JOIN product_attribute_value pav ON pav.id = rel.product_attribute_value_id
),

template_attributes AS (
    SELECT
        tav.product_tmpl_id,
        tav.attribute_id,
        tav.attribute_name,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', tav.value_id,
                'name', tav.value_name
            )
            ORDER BY tav.value_id
        ) AS values_json
    FROM template_attribute_values tav
    GROUP BY tav.product_tmpl_id, tav.attribute_id, tav.attribute_name
),

variant_type_data AS (
    SELECT
        ta.product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', ta.attribute_id,
                'attribute', ta.attribute_name,
                'values', ta.values_json
            )
            ORDER BY ta.attribute_id
        ) AS variant_type
    FROM template_attributes ta
    GROUP BY ta.product_tmpl_id
),

variant_attributes AS (
    SELECT
        pp.id AS product_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', pa.id,
                'attribute', pa.name ->> 'en_US',
                'value_id', pav.id,
                'value', pav.name ->> 'en_US'
            )
            ORDER BY pa.id, pav.id
        ) AS attributes
    FROM product_product pp
    JOIN product p ON p.id = pp.product_tmpl_id
    JOIN product_variant_combination pvc ON pvc.product_product_id = pp.id
    JOIN product_template_attribute_value ptav
        ON ptav.id = pvc.product_template_attribute_value_id
    JOIN product_attribute_value pav
        ON pav.id = ptav.product_attribute_value_id
    JOIN product_attribute pa ON pa.id = pav.attribute_id
    GROUP BY pp.id
),

variant_discounts AS (
    SELECT
        pp.id AS product_id,
        fd.discount,
        fd.product_discounts
    FROM product_product pp
    JOIN final_discounts fd ON fd.product_tmpl_id = pp.product_tmpl_id
    JOIN product p ON p.id = pp.product_tmpl_id
),

variant_delivery_types AS (
    SELECT
        rel.product_template_id,
        JSONB_AGG(dt.name ORDER BY dt.id) AS delivery_types,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', dt.name,
                'level', COALESCE(dt.priority_level, 0),
                'icon', NULLIF(dt.icon_url, '')
            )
            ORDER BY dt.id
        ) AS delivery_object
    FROM delivery_type_product_template_rel rel
    JOIN delivery_type dt ON dt.id = rel.delivery_type_id
    JOIN product p ON p.id = rel.product_template_id
    GROUP BY rel.product_template_id
),

variant_specifications AS (
    SELECT
        ep.product_id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', ep.id,
                'spec', es.name,
                'value', ep.value,
                'icon', NULLIF(es.icon_url, '')
            )
            ORDER BY ep.id
        ) AS specifications
    FROM ecomerce_product ep
    JOIN product p ON p.id = ep.product_id
    JOIN ecomerce_specs es ON es.id = ep.spec
    GROUP BY ep.product_id
),

product_specifications AS (
    SELECT
        ep.product_id AS product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', ep.id,
                'name', es.name,
                'value', ep.value,
                'icon', NULLIF(es.icon_url, '')
            )
            ORDER BY ep.id
        ) AS specifications
    FROM ecomerce_product ep
    JOIN product p ON p.id = ep.product_id
    JOIN ecomerce_specs es ON es.id = ep.spec
    GROUP BY ep.product_id
),

product_video_urls AS (
    SELECT
        pv.product_tmpl_id,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'video_url', pv.url,
                'thumbnail_url', NULLIF(pv.video_thumbnail_url, '')
            )
            ORDER BY pv.id
        ) AS videos
    FROM product_video_url pv
    JOIN product p ON p.id = pv.product_tmpl_id
    WHERE pv.url IS NOT NULL
      AND pv.url ILIKE '%m3u8%'
    GROUP BY pv.product_tmpl_id
),

template_delivery_types AS (
    SELECT
        rel.product_template_id,
        JSONB_AGG(dt.name ORDER BY dt.id) AS delivery_types,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'name', dt.name,
                'level', COALESCE(dt.priority_level, 0),
                'icon', NULLIF(dt.icon_url, '')
            )
            ORDER BY dt.id
        ) AS delivery_object
    FROM delivery_type_product_template_rel rel
    JOIN delivery_type dt ON dt.id = rel.delivery_type_id
    JOIN product p ON p.id = rel.product_template_id
    GROUP BY rel.product_template_id
),

variants AS (
    SELECT
        pp.product_tmpl_id,
        COUNT(*)::int AS total_variants,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', pp.id,
                'name', COALESCE(pt.name ->> 'en_US', ''),
                'product_category', CASE
                    WHEN pec.id IS NOT NULL THEN pec.name
                    ELSE 'General'
                END,
                'specifications', COALESCE(vspec.specifications, '[]'::jsonb),
                'delivery_types', COALESCE(vdt.delivery_types, '[]'::jsonb),
                'delivery_object', COALESCE(vdt.delivery_object, '[]'::jsonb),
                'product_description', COALESCE(pt.description_sale ->> 'en_US', ''),
                'cost_currency', CASE
                    WHEN rc.currency_id IS NOT NULL THEN JSONB_BUILD_OBJECT(
                        'id', rc.currency_id,
                        'name', currency.name
                    )
                    ELSE JSONB_BUILD_OBJECT('id', NULL, 'name', NULL)
                END,
                'list_price', pp.ecommerce_float_price,
                'UoM', CASE
                    WHEN pt.uom_id IS NOT NULL THEN JSONB_BUILD_OBJECT(
                        'id', pt.uom_id,
                        'name', uom.name ->> 'en_US'
                    )
                    ELSE JSONB_BUILD_OBJECT('id', NULL, 'name', NULL)
                END,
                'product_image', COALESCE(
                    NULLIF(pp.image_1920_url, ''),
                    NULLIF(pt.image_1920_url, '')
                ),
                'product_images', JSONB_BUILD_ARRAY(
                    JSONB_BUILD_OBJECT(
                        'field', 'image_1',
                        'url', COALESCE(NULLIF(pp.image_1_url, ''), NULLIF(pt.image_1_url, ''))
                    ),
                    JSONB_BUILD_OBJECT(
                        'field', 'image_2',
                        'url', COALESCE(NULLIF(pp.image_2_url, ''), NULLIF(pt.image_2_url, ''))
                    ),
                    JSONB_BUILD_OBJECT(
                        'field', 'image_3',
                        'url', COALESCE(NULLIF(pp.image_3_url, ''), NULLIF(pt.image_3_url, ''))
                    ),
                    JSONB_BUILD_OBJECT(
                        'field', 'image_4',
                        'url', COALESCE(NULLIF(pp.image_4_url, ''), NULLIF(pt.image_4_url, ''))
                    ),
                    JSONB_BUILD_OBJECT(
                        'field', 'image_5',
                        'url', COALESCE(NULLIF(pp.image_5_url, ''), NULLIF(pt.image_5_url, ''))
                    ),
                    JSONB_BUILD_OBJECT(
                        'field', 'image_6',
                        'url', COALESCE(NULLIF(pp.image_6_url, ''), NULLIF(pt.image_6_url, ''))
                    )
                ),
                'qty_available', COALESCE(vs.qty_available, 0),
                'virtual_available', COALESCE(vs.virtual_available, 0),
                'variants_types', COALESCE(va.attributes, '[]'::jsonb),
                'is_featured', COALESCE(pp.v_is_featured, FALSE),
                'discount', COALESCE(vd.discount, '[]'::jsonb),
                'product_discounts', COALESCE(vd.product_discounts, 0)
            )
            ORDER BY pp.id
        ) AS variants
    FROM product_product pp
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    JOIN product p ON p.id = pt.id
    JOIN res_company rc ON rc.id = pt.company_id
    LEFT JOIN res_currency currency ON currency.id = rc.currency_id
    LEFT JOIN uom_uom uom ON uom.id = pt.uom_id
    LEFT JOIN product_ecomerce_categories pec ON pec.id = pt.ecomerce_category_id
    LEFT JOIN variant_stock vs ON vs.product_id = pp.id
    LEFT JOIN variant_attributes va ON va.product_id = pp.id
    LEFT JOIN variant_discounts vd ON vd.product_id = pp.id
    LEFT JOIN variant_delivery_types vdt ON vdt.product_template_id = pt.id
    LEFT JOIN variant_specifications vspec ON vspec.product_tmpl_id = pt.id
    WHERE pp.active = TRUE
      AND pt.x_superapp_approval_status = 'approved'
    GROUP BY pp.product_tmpl_id
),

product_final AS (
    SELECT
        p.id,
        p.name,
        p.description_sale,
        p.ecommerce_float_price,
        p.cost_currency_id,
        p.uom_id,
        p.company_id,
        p.merchant,
        p.merchant_name,
        p.has_logo,
        p.logo_url,
        p.lat_location,
        p.lng_location,
        p.city,
        p.state_name,
        p.t_is_featured,
        p.is_halal,
        p.is_arrival,
        p.min_quantity,
        p.max_quantity,
        p.ecomerce_category_id,
        COALESCE(p.api_qty_available, 0.0) AS qty_available,
        COALESCE(p.api_virtual_available, 0.0) AS virtual_available,
        COALESCE(fd.discount, '[]'::jsonb) AS discount,
        COALESCE(fd.product_discounts, 0) AS product_discounts,
        rd.total_reviews,
        rd.average_rating,
        COALESCE(v.total_variants, 0) AS total_variants,
        COALESCE(v.variants, '[]'::jsonb) AS variants,
        COALESCE(vtd.variant_type, '[]'::jsonb) AS variant_type,
        COALESCE(ps.specifications, '[]'::jsonb) AS specifications,
        COALESCE(tdt.delivery_types, '[]'::jsonb) AS delivery_types,
        COALESCE(tdt.delivery_object, '[]'::jsonb) AS delivery_object,
        COALESCE(pv.videos, '[]'::jsonb) AS videos,
        p.image_1920_url,
        p.image_1_url,
        p.image_2_url,
        p.image_3_url,
        p.image_4_url,
        p.image_5_url,
        p.image_6_url
    FROM product p
    LEFT JOIN final_discounts fd ON fd.product_tmpl_id = p.id
    LEFT JOIN review_data rd ON rd.product_template = p.id
    LEFT JOIN variants v ON v.product_tmpl_id = p.id
    LEFT JOIN variant_type_data vtd ON vtd.product_tmpl_id = p.id
    LEFT JOIN product_specifications ps ON ps.product_tmpl_id = p.id
    LEFT JOIN template_delivery_types tdt ON tdt.product_template_id = p.id
    LEFT JOIN product_video_urls pv ON pv.product_tmpl_id = p.id
)

SELECT
    pf.id,
    pf.name ->> 'en_US' AS name,
    CASE
        WHEN cat.id IS NOT NULL THEN JSONB_BUILD_OBJECT('id', cat.id, 'name', cat.name)
        ELSE NULL
    END AS product_category,
    COALESCE(pf.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(pf.image_1920_url, '') AS product_image,
    pf.videos AS video_urls,
    JSONB_BUILD_ARRAY(
        JSONB_BUILD_OBJECT('field', 'image_1', 'url', NULLIF(pf.image_1_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_2', 'url', NULLIF(pf.image_2_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_3', 'url', NULLIF(pf.image_3_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_4', 'url', NULLIF(pf.image_4_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_5', 'url', NULLIF(pf.image_5_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_6', 'url', NULLIF(pf.image_6_url, ''))
    ) AS product_images,
    CASE
        WHEN pf.cost_currency_id IS NOT NULL THEN JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT('id', pf.cost_currency_id, 'name', currency.name)
        )
        ELSE '[]'::jsonb
    END AS cost_currency,
    ROUND(pf.ecommerce_float_price::numeric, 2) AS list_price,
    pf.qty_available,
    pf.virtual_available,
    pf.discount,
    pf.product_discounts,
    CASE
        WHEN u.id IS NOT NULL THEN JSONB_BUILD_OBJECT(
            'id', u.id,
            'name', u.name ->> 'en_US'
        )
        ELSE NULL
    END AS "UoM",
    COALESCE(pf.t_is_featured, FALSE) AS is_featured,
    COALESCE(pf.is_halal, FALSE) AS is_halal,
    COALESCE(pf.is_arrival, FALSE) AS is_arrival,
    COALESCE(pf.variant_type, '[]'::jsonb) AS variants_types,
    pf.total_variants,
    pf.variants,
    pf.specifications,
    pf.delivery_types,
    pf.delivery_object,
    JSONB_BUILD_OBJECT(
        'merchant', pf.merchant,
        'name', pf.merchant_name,
        'logo', NULLIF(pf.logo_url, ''),
        'lat_location', pf.lat_location,
        'lng_location', pf.lng_location,
        'city', pf.city,
        'state', pf.state_name
    ) AS merchant_info,
    NULLIF(pf.min_quantity, 0) AS min_quantity,
    NULLIF(pf.max_quantity, 0) AS max_quantity,
    pf.average_rating,
    COALESCE(pf.total_reviews, 0) AS total_reviews
FROM product_final pf
LEFT JOIN product_ecomerce_categories cat ON cat.id = pf.ecomerce_category_id
LEFT JOIN res_currency currency ON currency.id = pf.cost_currency_id
LEFT JOIN uom_uom u ON u.id = pf.uom_id
WHERE pf.id = (SELECT product_tmpl_id FROM params)
LIMIT 1;
 
```

## Endpoint 29 — GET api/v1/delivery_products


```sql
-------------------------------------------------------------------------------
-- GET /api/v1/delivery_products
-- Parm 
-- src_location = Addis Abeba
-- dest_location = Addis Abeba
-- medium = CAR | TRUCK | BIKE
-------------------------------------------------------------------------------
WITH params AS (
    SELECT
        NULLIF('Addis Abeba', '')::text AS dest_location,
        NULLIF('Addis Abeba', '')::text AS src_location,
        NULLIF('CAR', '')::text AS medium
),
dest_attributes AS (
    SELECT ptav.id
    FROM product_template_attribute_value ptav
    JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
    CROSS JOIN params p
    WHERE p.dest_location IS NOT NULL AND pav.name->>'en_US' ILIKE '%' || p.dest_location || '%'
),
src_attributes AS (
    SELECT ptav.id
    FROM product_template_attribute_value ptav
    JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
    CROSS JOIN params p
    WHERE p.src_location IS NOT NULL AND pav.name->>'en_US' ILIKE '%' || p.src_location || '%'
),
medium_attributes AS (
    SELECT ptav.id
    FROM product_template_attribute_value ptav
    JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
    CROSS JOIN params p
    WHERE p.medium IS NOT NULL AND pav.name->>'en_US' ILIKE '%' || p.medium || '%'
),
candidate_products AS (
    SELECT pp.id, pp.ecommerce_float_price, pt.name->>'en_US' AS name
    FROM product_product pp
    JOIN product_template pt ON pt.id = pp.product_tmpl_id
    CROSS JOIN params p

    WHERE
        pp.active = true
        AND pt.active = true
        AND pt.x_superapp_approval_status = 'approved'
        AND pt.is_for_ecommerce = true
        AND EXISTS (
            SELECT 1
            FROM res_company rc
            WHERE rc.id = pt.company_id
              AND rc.active = true
              AND rc.is_delivery = true
        )
        AND (
            p.dest_location IS NULL
            OR EXISTS (
                SELECT 1
                FROM product_variant_combination pvc
                WHERE pvc.product_product_id = pp.id
                  AND pvc.product_template_attribute_value_id
                      IN (SELECT id FROM dest_attributes)
            )
        )
        AND (
            p.src_location IS NULL
            OR EXISTS (
                SELECT 1
                FROM product_variant_combination pvc
                WHERE pvc.product_product_id = pp.id
                  AND pvc.product_template_attribute_value_id IN (SELECT id FROM src_attributes)
            )
        )
        AND (
            p.medium IS NULL
            OR EXISTS (
                SELECT 1
                FROM product_variant_combination pvc
                WHERE pvc.product_product_id = pp.id
                  AND pvc.product_template_attribute_value_id IN (SELECT id FROM medium_attributes)
            )
        )
)
SELECT id,ecommerce_float_price,name
FROM candidate_products ORDER BY id;



```

