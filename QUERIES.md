# SQL Queries Reference



## Endpoint 1 — GET /api/v1/orders





Bind params:  
 $1 = app_user_id
 $2 = merchant_filter       
 $3 = history
 $4 = limit
 $5 = cursor_id         



```sql
WITH input AS (
	    SELECT
	        $1::text AS app_user_id,
	        $2::text AS merchant_filter,
	        $3::text AS history,
	        $4::int  AS lim,
	        $5::int  AS cursor_id
	),
	partner AS (
	    SELECT p.id
	    FROM res_partner p
	    JOIN input i ON TRUE
	    WHERE p.app_user_id = i.app_user_id
	      AND p.active = TRUE
	    LIMIT 1
	),
	merchant_company AS (
	    SELECT c.id
	    FROM res_company c
	    JOIN input i ON TRUE
	    WHERE i.merchant_filter <> ''
	      AND c.merchant = i.merchant_filter
	      AND c.is_delivery = FALSE
	      AND c.merchant IS NOT NULL
	    LIMIT 1
	),
	filtered AS (
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
	        so.driver_email,
	        so.driver_delivery_medium,
	        rc.id                                          AS company_id,
	        rc.merchant,
	        rc.name                                        AS company_name,
	        NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
	        rc.lat_location,
	        rc.lng_location,
	        rc.phone                                       AS company_phone,
	        rp.street,
	        rp.city,
	        rcs.name                                       AS state_name,
	        rco.name->>'en_US'                             AS country_name,
	        rcp.name                                       AS parent_name
	    FROM input i
	    JOIN partner p ON TRUE
	    JOIN sale_order so ON so.partner_id = p.id
	                      AND so.is_superapp_order = TRUE
	    LEFT JOIN res_company         rc  ON rc.id  = so.company_id
	    LEFT JOIN res_partner         rp  ON rp.id  = rc.partner_id
	    LEFT JOIN res_country_state   rcs ON rcs.id = rp.state_id
	    LEFT JOIN res_country         rco ON rco.id = rp.country_id
	    LEFT JOIN res_company         rcp ON rcp.id = rc.parent_id
	    WHERE (i.merchant_filter = '' OR so.company_id = (SELECT id FROM merchant_company))
	      AND (
	          i.history = '' OR i.history = 'all'
	          OR (i.history = 'active'
	              AND so.superapp_order_status NOT IN ('cancelled', 'delivered'))
	          OR (i.history = 'inactive'
	              AND so.superapp_order_status IN ('delivered', 'cancelled'))
	      )
	),
	guard AS (
	    SELECT
	        EXISTS(SELECT 1 FROM partner) AS partner_exists,
	        CASE
	            WHEN (SELECT merchant_filter FROM input) = '' THEN TRUE
	            ELSE EXISTS(SELECT 1 FROM merchant_company)
	        END AS merchant_ok
	),
	paged AS (
	    SELECT f.*
	    FROM filtered f
	    JOIN guard g ON g.partner_exists AND g.merchant_ok
	    WHERE (SELECT cursor_id FROM input) = 0
	       OR f.id < (SELECT cursor_id FROM input)
	    ORDER BY f.id DESC
	    LIMIT (SELECT lim FROM input)
	),
	orders_data AS (
	    SELECT COALESCE(
	        json_agg(order_obj ORDER BY order_id DESC),
	        '[]'::json
	    ) AS orders_json
	    FROM (
	        SELECT
	            b.id AS order_id,
	            json_build_object(
	                'id', b.id,
	                'order_ref', b.name,
	                'state', b.state,
	                'delivery_status', NULLIF(b.superapp_order_status, ''),
	                'date_order', CASE
	                    WHEN b.date_order IS NULL THEN NULL
	                    ELSE TO_CHAR(b.date_order, 'YYYY-MM-DD HH24:MI:SS')
	                END,
	                'total_price', b.total_price,
	                'delivery_type', b."deliveryType",
	                'merchant', json_build_object(
	                    'merchant', b.merchant,
	                    'name', b.company_name,
	                    'logo', b.logo_url,
	                    'lat', b.lat_location,
	                    'lng', b.lng_location,
	                    'parent', CASE
	                        WHEN b.parent_name IS NOT NULL AND b.parent_name <> ''
	                            THEN b.parent_name
	                        ELSE b.company_name
	                    END,
	                    'branch', b.company_name,
	                    'phone', CASE
	                        WHEN b.company_phone IS NULL OR b.company_phone = '' THEN NULL
	                        ELSE REPLACE(REPLACE(b.company_phone, '+251', '0'), ' ', '')
	                    END,
	                    'location', CASE
	                        WHEN b.company_id IS NULL THEN NULL
	                        ELSE CONCAT_WS(
	                            ', ',
	                            NULLIF(b.street, ''),
	                            NULLIF(b.city, ''),
	                            COALESCE(NULLIF(b.state_name, ''), 'False'),
	                            NULLIF(b.country_name, '')
	                        )
	                    END
	                ),
	                'driver_info', CASE
	                    WHEN b."deliveryType" = 'delivery' THEN json_build_object(
	                        'driver_name', b.driver_name,
	                        'driver_mobile', b.driver_mobile,
	                        'driver_email', b.driver_email,
	                        'delivery_medium', b.driver_delivery_medium
	                    )
	                    ELSE '{}'::json
	                END,
	                'sale_order_lines', COALESCE(lines.lines_json, '[]'::json)
	            ) AS order_obj
	        FROM paged b
	        LEFT JOIN LATERAL (
	            SELECT json_agg(
	                json_build_object(
	                    'id', sol.id,
	                    'product_id', sol.product_id,
	                    'product_name', CASE
	                        WHEN sol.product_id IS NOT NULL THEN
	                            CASE
	                                WHEN attrs.attributes IS NOT NULL AND attrs.attributes <> ''
	                                    THEN CONCAT(
	                                        COALESCE(pt.name->>'en_US', pt.name::text),
	                                        ' (', attrs.attributes, ')'
	                                    )
	                                ELSE COALESCE(pt.name->>'en_US', pt.name::text, '')
	                            END
	                        ELSE COALESCE(NULLIF(sol.name, ''), '')
	                    END,
	                    'qty', sol.product_uom_qty,
	                    'uom', u.name->>'en_US',
	                    'price_unit', ROUND(sol.price_unit::numeric, 2),
	                    'line_amount', ROUND(sol.price_total::numeric, 2),
	                    'product_image', NULLIF(
	                        TRIM(COALESCE(pp.image_1920_url, pt.image_1920_url, '')),
	                        ''
	                    )
	                )
	            ) AS lines_json
	            FROM sale_order_line sol
	            LEFT JOIN product_product pp  ON pp.id  = sol.product_id
	            LEFT JOIN product_template pt ON pt.id  = pp.product_tmpl_id
	            LEFT JOIN uom_uom u           ON u.id   = sol.product_uom
	            LEFT JOIN (
	                SELECT
	                    pvc.product_product_id,
	                    string_agg(pav.name->>'en_US', ', ' ORDER BY pa.sequence) AS attributes
	                FROM product_variant_combination pvc
	                JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
	                JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
	                JOIN product_attribute pa ON pa.id = pav.attribute_id
	                WHERE pvc.product_product_id IN (
	                    SELECT DISTINCT product_id FROM sale_order_line WHERE order_id = b.id
	                )
	                GROUP BY pvc.product_product_id
	            ) attrs ON attrs.product_product_id = pp.id
	            WHERE sol.order_id = b.id
	        ) lines ON true
	    ) orders
	)
	SELECT
	    g.partner_exists,
	    g.merchant_ok,
	    od.orders_json
	FROM guard g
	CROSS JOIN orders_data od
```






## Endpoint 2 — GET /api/v1/{merchant}/orders/{order_id}/status



Path: merchant, order_id
$1 = order_id
$2 = merchant


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
        NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
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
        WHERE pvc.product_product_id IN (
            SELECT DISTINCT product_id FROM sale_order_line WHERE order_id = b.order_id
        )
        GROUP BY pvc.product_product_id
    ) attrs ON attrs.product_product_id = pp.id
    WHERE sol.order_id = b.order_id
) lines ON true;
```





## Endpoint 3 — GET /api/v1/product/{product_id}/reviews



Path: product_id   (product_template.id — not variant id)
Query: cursor, per_page (default 20)

Bind params:
  $1 = product_id
  $2 = fetch_limit       (per_page + 1)
  $3 = cursor_id         (0 on first page; else last review id)


**Cursor rule:** `pr.id < cursor_id`, sort `pr.id DESC`.

```sql
WITH input AS (
    SELECT
        $1::int AS product_id,
        $2::int AS lim,
        $3::int AS cursor_id
),
product_check AS (
    SELECT EXISTS(
        SELECT 1 FROM product_template pt
        JOIN input i ON pt.id = i.product_id
    ) AS exists
),
base AS (
    SELECT
        pr.id,
        COALESCE(rp.name, 'Anonymous') AS user_name,
        rp.app_user_id,
        pr.rating,
        COALESCE(pr.review, '') AS review,
        TO_CHAR(pr.create_date, 'DD TMMonth YYYY') AS create_date
    FROM input i
    JOIN product_review pr ON pr.product_template = i.product_id
    LEFT JOIN res_partner rp ON rp.id = pr.user_id
    WHERE i.cursor_id = 0 OR pr.id < i.cursor_id
    ORDER BY pr.id DESC
    LIMIT (SELECT lim FROM input)
),
aggregated_reviews AS (
    SELECT COALESCE(
        json_agg(
            json_build_object(
                'id', b.id,
                'user_name', b.user_name,
                'user_id', CASE
                    WHEN b.app_user_id IS NOT NULL AND b.app_user_id != ''
                    THEN to_jsonb(b.app_user_id)
                    ELSE to_jsonb(false)
                END,
                'rating', COALESCE(NULLIF(b.rating, ''), '0')::int,
                'review', b.review,
                'create_date', b.create_date,
                'replys', COALESCE(replies.replies_json, '[]'::json)
            )
            ORDER BY b.id DESC
        ),
        '[]'::json
    ) AS reviews_json
    FROM base b
    LEFT JOIN LATERAL (
        SELECT json_agg(
            json_build_object(
                'reply_from', COALESCE(rp2.name, 'Dev Team'),
                'reply', COALESCE(rr.reply, ''),
                'reply_date', TO_CHAR(rr.create_date, 'DD TMMonth YYYY')
            ) ORDER BY rr.id ASC
        ) AS replies_json
        FROM review_reply rr
        LEFT JOIN res_partner rp2 ON rp2.id = rr.user_id
        WHERE rr.review_id = b.id
    ) replies ON true
)
SELECT
    (SELECT exists FROM product_check),
    (SELECT reviews_json FROM aggregated_reviews);
```





## Endpoint 4 — GET /api/v1/product/purchase_status


Query: app_user_id, product_id
$1 = app_user_id
$2 = product_id   (product_product.id — variant id)

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



Query: app_user_id, lim, cursor_id



```sql
WITH input AS (
	    SELECT
	        $1::text AS app_user_id,
	        $2::int  AS lim,
	        $3::int  AS cursor_id
	),
	partner AS (
	    SELECT p.id
	    FROM res_partner p
	    JOIN input i ON TRUE
	    WHERE p.app_user_id = i.app_user_id
	      AND p.active = TRUE
	    LIMIT 1
	),
	base_companies AS (
	    SELECT
	        rc.id                            AS company_id,
	        rc.name                          AS company_name,
	        rc.merchant                      AS merchant,
	        NULLIF(TRIM(COALESCE(rc.logo_url, rp.image_1920_url, '')), '') AS logo_url,
	        COUNT(so.id)::int                AS order_count
	    FROM partner p
	    JOIN sale_order so ON so.partner_id = p.id
	                      AND so.is_superapp_order = TRUE
	    JOIN res_company rc ON rc.id = so.company_id
	    LEFT JOIN res_partner rp ON rp.id = rc.partner_id
	    GROUP BY rc.id, rc.name, rc.merchant, rc.logo_url, rp.image_1920_url
	),
	cursor_row AS (
	    SELECT b.order_count, b.company_name, b.company_id
	    FROM base_companies b
	    JOIN input i ON TRUE
	    WHERE i.cursor_id <> 0
	      AND b.company_id = i.cursor_id
	    LIMIT 1
	),
	paginated_companies AS (
	    SELECT b.*
	    FROM base_companies b
	    JOIN input i ON TRUE
	    WHERE i.cursor_id = 0
	       OR EXISTS (
	            SELECT 1
	            FROM cursor_row c
	            WHERE b.order_count < c.order_count
	               OR (b.order_count = c.order_count AND b.company_name > c.company_name)
	               OR (b.order_count = c.order_count
	                   AND b.company_name = c.company_name
	                   AND b.company_id > c.company_id)
	       )
	    ORDER BY b.order_count DESC, b.company_name ASC, b.company_id ASC
	    LIMIT (SELECT lim FROM input)
	),
	aggregated_results AS (
	    SELECT COALESCE(
	        json_agg(
	            json_build_object(
	                'company_id', pc.company_id,
	                'company_name', pc.company_name,
	                'merchant', pc.merchant,
	                'logo_url', pc.logo_url,
	                'order_count', pc.order_count,
	                'item_count', COALESCE(items.item_count, 0)
	            ) ORDER BY pc.order_count DESC, pc.company_name ASC, pc.company_id ASC
	        ),
	        '[]'::json
	    ) AS results_json
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
	SELECT
	    EXISTS(SELECT 1 FROM partner) AS partner_exists,
	    (SELECT results_json FROM aggregated_results)
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
    c.id
    c.name AS name,
    c.logo_url,
    c.merchant,
    c.superapp_orders
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.cps_enabled = true
  AND c.is_delivery = false
  AND c.active = true
  AND c.merchant IS NOT NULL
  AND c.superapp_orders > 0
  AND (c.id,c.superapp_orders) < (%cursor_id,%cursor_superapp_orders)
ORDER BY c.superapp_orders DESC
LIMIT %lim;
```


## Endpoint 8 — GET /api/v1/popular_categories

```sql
SELECT
    c.id AS category_id,
    c.name AS category_name,
    c.superapp_sale_count AS total_sold_qty,
    c.image_1_url AS image,
    c.superapp_sale_count,
    c.product_count AS product_count
FROM product_ecomerce_categories c

WHERE c.superapp_sale_count > 0 
AND (c.id,c.superapp_sale_count) < (%cursor_id,%cursor_super_app_sale_count)

ORDER BY c.superapp_sale_count DESC
LIMIT %lim; --10; 
```




## Endpoint 10 — GET /api/v1/popular_products

```sql
WITH normalized_params AS (
    SELECT
        NULLIF(TRIM(NULL), '')::bigint AS cursor_id,
        NULLIF(TRIM(NULL), '')::integer AS cursor_sold_count,
        NULLIF(TRIM(NULL), '')::text AS merchant,
        GREATEST(COALESCE(NULL::int, 10), 1) AS per_page,
        GREATEST(COALESCE(NULL::int, 500), 1) AS fetch_limit,
        COALESCE(NULL::double precision, 0) AS min_price,
        COALESCE(NULL::double precision, 10000000) AS max_price,
        COALESCE(NULL::int, 0) AS category_id,
        NULLIF(TRIM(%s), '')::text AS app_user_id, -- 'user_id'
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN 'sold_desc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'asc' THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'desc' THEN 'sold_desc'
            ELSE 'sold_desc'
        END AS sort_mode,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS halal_filter
),
eligible_products AS (
    SELECT
        pt.id AS product_id,
        pt.company_id,
        pt.sold_count,
        pt.ecommerce_float_price
    FROM product_template pt
    JOIN res_company c ON c.id = pt.company_id
    CROSS JOIN normalized_params r
    WHERE pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.is_in_stock = TRUE
      AND pt.sold_count > 0
      AND pt.x_superapp_approval_status = 'approved'
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND c.active = TRUE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
      AND (
          r.merchant IS NULL
          OR c.merchant = r.merchant
          OR (
              c.parent_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM res_company parent_c
                  WHERE parent_c.id = c.parent_id
                    AND parent_c.parent_id IS NULL
                    AND parent_c.cps_enabled = TRUE
                    AND COALESCE(parent_c.is_delivery, FALSE) = FALSE
                    AND parent_c.active = TRUE
                    AND NULLIF(TRIM(parent_c.merchant), '') IS NOT NULL
                    AND (r.merchant IS NULL OR parent_c.merchant = r.merchant)
              )
          )
      )
      AND pt.ecommerce_float_price >= r.min_price
      AND pt.ecommerce_float_price <= r.max_price
      AND (r.category_id = 0 OR pt.ecomerce_category_id = r.category_id)
      AND (r.halal_filter IS NULL OR COALESCE(pt.is_halal, FALSE) = r.halal_filter)
      AND (
          r.cursor_id IS NULL
          OR r.cursor_sold_count IS NULL
          OR (
              r.sort_mode = 'sold_desc'
              AND (
                  pt.sold_count < r.cursor_sold_count
                  OR (pt.sold_count = r.cursor_sold_count AND pt.id < r.cursor_id)
              )
          )
          OR (
              r.sort_mode = 'sold_asc'
              AND (
                  pt.sold_count > r.cursor_sold_count
                  OR (pt.sold_count = r.cursor_sold_count AND pt.id < r.cursor_id)
              )
          )
      )
),
page_products AS (
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
        c.name AS merchant_name
    FROM (
        SELECT ep.*
        FROM eligible_products ep
        CROSS JOIN normalized_params r
        ORDER BY
            CASE WHEN r.sort_mode = 'sold_asc' THEN ep.sold_count END ASC,
            CASE WHEN r.sort_mode = 'sold_desc' THEN ep.sold_count END DESC,
            ep.product_id DESC
        LIMIT (SELECT LEAST(per_page + 1, fetch_limit) FROM normalized_params)
    ) p
    JOIN product_template pt ON pt.id = p.product_id
    JOIN res_company c ON c.id = p.company_id
),
page_companies AS (
    SELECT DISTINCT company_id
    FROM page_products
),
direct_discounts AS (
    SELECT DISTINCT ON (pd.product_tmpl_id)
        pd.product_tmpl_id AS product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN pd.discount_type IS NOT NULL THEN INITCAP(pd.discount_type) ELSE NULL END,
                'discount_value', CASE
                    WHEN pd.discount_value IS NULL THEN NULL
                    WHEN pd.discount_value::numeric = TRUNC(pd.discount_value::numeric) THEN TRUNC(pd.discount_value::numeric)::text || '.0'
                    ELSE RTRIM(RTRIM(TO_CHAR(pd.discount_value::numeric, 'FM999999999999990.999999999999'), '0'), '.')
                END
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                pp.ecommerce_float_price::numeric / 1.15
                - CASE
                    WHEN pd.discount_type = 'percentage' THEN pp.ecommerce_float_price::numeric / 1.15 * pd.discount_value::numeric / 100
                    ELSE pd.discount_value::numeric
                  END,
                0
            ) + (pp.ecommerce_float_price::numeric - pp.ecommerce_float_price::numeric / 1.15),
            2
        ) AS product_discounts
    FROM page_products pp
    JOIN product_discount pd ON pd.product_tmpl_id = pp.product_id
    WHERE pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
    ORDER BY pd.product_tmpl_id, pd.id
),
active_loyalty_programs AS (
    SELECT DISTINCT ON (lp.company_id)
        lp.id,
        lp.company_id
    FROM loyalty_program lp
    JOIN page_companies pc ON pc.company_id = lp.company_id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.company_id, lp.sequence, lp.id
),
loyalty_discounts AS (
    SELECT DISTINCT ON (pp.product_id)
        pp.product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
                'discount_value', CASE
                    WHEN lr.discount IS NULL THEN NULL
                    WHEN lr.discount::numeric = TRUNC(lr.discount::numeric) THEN TRUNC(lr.discount::numeric)::text || '.0'
                    ELSE RTRIM(RTRIM(TO_CHAR(lr.discount::numeric, 'FM999999999999990.999999999999'), '0'), '.')
                END
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                pp.ecommerce_float_price::numeric / 1.15
                - CASE
                    WHEN lr.discount_mode = 'percent' THEN pp.ecommerce_float_price::numeric / 1.15 * lr.discount::numeric / 100
                    ELSE lr.discount::numeric
                  END,
                0
            ) + (pp.ecommerce_float_price::numeric - pp.ecommerce_float_price::numeric / 1.15),
            2
        ) AS product_discounts
    FROM page_products pp
    JOIN active_loyalty_programs alp ON alp.company_id = pp.company_id
    JOIN loyalty_reward lr ON lr.program_id = alp.id
    ORDER BY pp.product_id, lr.id
),
wishlist_products AS (
    SELECT DISTINCT wpp.product_tmpl_id AS product_id
    FROM normalized_params r
    JOIN res_partner rp ON rp.app_user_id = r.app_user_id
    JOIN wishlist wl ON wl.user_id = rp.id AND wl.is_active = TRUE
    JOIN product_product wpp ON wpp.id = wl.product_id
    JOIN page_products pp ON pp.product_id = wpp.product_tmpl_id
    WHERE r.app_user_id IS NOT NULL
),
final_products AS (
    SELECT
        pp.*,
        CASE WHEN dd.discount IS NOT NULL THEN dd.discount ELSE COALESCE(ld.discount, '[]'::jsonb) END AS discount,
        CASE WHEN dd.discount IS NOT NULL THEN COALESCE(dd.product_discounts, 0) ELSE COALESCE(ld.product_discounts, 0) END AS product_discounts,
        wp.product_id IS NOT NULL AS is_wishlisted
    FROM page_products pp
    LEFT JOIN direct_discounts dd ON dd.product_id = pp.product_id
    LEFT JOIN loyalty_discounts ld ON ld.product_id = pp.product_id
    LEFT JOIN wishlist_products wp ON wp.product_id = pp.product_id
)
SELECT
    fp.product_id,
    CASE
        WHEN fp.product_name_raw IS NULL THEN NULL
        WHEN jsonb_typeof(fp.product_name_raw::jsonb) = 'object' THEN COALESCE(fp.product_name_raw::jsonb ->> 'en_US', fp.product_name_raw::text)
        ELSE fp.product_name_raw::text
    END AS product_name,
    CASE
        WHEN fp.description_raw IS NULL THEN NULL
        WHEN jsonb_typeof(fp.description_raw::jsonb) = 'object' THEN fp.description_raw::jsonb ->> 'en_US'
        ELSE fp.description_raw::text
    END AS description,
    CONCAT(COALESCE(fp.sold_count, 0), ' Units') AS total_sold_qty,
    fp.ecommerce_float_price AS list_price,
    'ETB' AS currency,
    CASE WHEN fp.discount <> '[]'::jsonb THEN fp.product_discounts ELSE 0 END AS product_discounts,
    COALESCE(fp.discount, '[]'::jsonb) AS discount,
    NULLIF(fp.image_1920_url, '') AS image,
    COALESCE(fp.total_reviews, 0) AS total_review,
    COALESCE(fp.average_rating, 0.0) AS average_rating,
    COALESCE(fp.total_variants, 0) AS tototal_variants,
    COALESCE(fp.t_is_featured, FALSE) AS is_featured,
    COALESCE(fp.is_halal, FALSE) AS is_halal,
    COALESCE(fp.is_arrival, FALSE) AS is_arrival,
    fp.is_wishlisted
FROM final_products fp
CROSS JOIN normalized_params r
ORDER BY
    CASE WHEN r.sort_mode = 'sold_asc' THEN fp.sold_count END ASC,
    CASE WHEN r.sort_mode = 'sold_desc' THEN fp.sold_count END DESC,
    fp.product_id DESC;
```

## Endpoint 11 — GET /api/v1/{merchant:string}/popular_merchant_products

```sql
WITH normalized_params AS (
    SELECT
        NULLIF(TRIM(%s), '')::text AS merchant, --'MRT000052SPR'
        GREATEST(COALESCE(10::int, 10), 1) AS per_page,
        GREATEST(COALESCE(NULL::int, 500), 1) AS fetch_limit,
        COALESCE(NULL::double precision, 0) AS min_price,
        COALESCE(NULL::double precision, 10000000) AS max_price,
        COALESCE(NULL::int, 0) AS category_id,
        NULLIF(TRIM(%s), '')::text AS app_user_id, -- 'user_id'
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN 'sold_desc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'asc' THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'desc' THEN 'sold_desc'
            ELSE 'sold_desc'
        END AS sort_mode,
        NULLIF(TRIM(NULL), '')::bigint AS cursor_id,
        NULLIF(TRIM(NULL), '')::integer AS cursor_sold_count,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS halal_filter
),
merchant_company AS (
    SELECT c.id, c.merchant, c.name AS merchant_name
    FROM res_company c
    CROSS JOIN normalized_params r
    WHERE c.merchant = r.merchant
      AND c.active = TRUE
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
    LIMIT 1
),
page_products AS (
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
        mc.merchant,
        mc.merchant_name
    FROM merchant_company mc
    JOIN product_template pt ON pt.company_id = mc.id
    CROSS JOIN normalized_params r
    WHERE pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.sold_count > 0
      AND pt.is_in_stock = TRUE
      AND pt.ecommerce_float_price >= r.min_price
      AND pt.ecommerce_float_price <= r.max_price
      AND (r.category_id = 0 OR pt.ecomerce_category_id = r.category_id)
      AND (r.halal_filter IS NULL OR COALESCE(pt.is_halal, FALSE) = r.halal_filter)
      AND (
          r.cursor_id IS NULL
          OR r.cursor_sold_count IS NULL
          OR (
              r.sort_mode = 'sold_desc'
              AND (
                  pt.sold_count < r.cursor_sold_count
                  OR (pt.sold_count = r.cursor_sold_count AND pt.id < r.cursor_id)
              )
          )
          OR (
              r.sort_mode = 'sold_asc'
              AND (
                  pt.sold_count > r.cursor_sold_count
                  OR (pt.sold_count = r.cursor_sold_count AND pt.id < r.cursor_id)
              )
          )
      )
    ORDER BY
        CASE WHEN r.sort_mode = 'sold_asc' THEN pt.sold_count END ASC,
        CASE WHEN r.sort_mode = 'sold_desc' THEN pt.sold_count END DESC,
        pt.id DESC
    LIMIT (SELECT LEAST(per_page + 1, fetch_limit) FROM normalized_params)
),
direct_discount AS (
    SELECT
        x.product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN x.discount_type IS NOT NULL THEN INITCAP(x.discount_type) ELSE NULL END,
                'discount_value', CASE WHEN x.discount_value IS NULL THEN NULL ELSE x.discount_value::text END
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                x.ecommerce_float_price::numeric / 1.15::numeric
                - CASE
                    WHEN x.discount_type = 'percentage'
                        THEN (x.ecommerce_float_price::numeric / 1.15::numeric) * x.discount_value::numeric / 100::numeric
                    ELSE x.discount_value::numeric
                  END,
                0::numeric
            ) + (x.ecommerce_float_price::numeric - x.ecommerce_float_price::numeric / 1.15::numeric),
            2
        ) AS product_discounts
    FROM (
        SELECT DISTINCT ON (pd.product_tmpl_id)
            pp.product_id, pd.discount_type, pd.discount_value, pp.ecommerce_float_price
        FROM page_products pp
        JOIN product_discount pd ON pd.product_tmpl_id = pp.product_id
        WHERE pd.is_active = TRUE
          AND pd.x_superapp_approval_status = 'approved'
          AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
          AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
        ORDER BY pd.product_tmpl_id, pd.id
    ) x
),
active_loyalty_program AS (
    SELECT lp.id, lp.company_id
    FROM merchant_company mc
    JOIN loyalty_program lp ON lp.company_id = mc.id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.sequence, lp.id
    LIMIT 1
),
loyalty_discount AS (
    SELECT
        x.product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN x.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(x.discount_mode) END,
                'discount_value', CASE WHEN x.discount IS NULL THEN NULL ELSE x.discount::text END
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                x.ecommerce_float_price::numeric / 1.15::numeric
                - CASE
                    WHEN x.discount_mode = 'percent'
                        THEN (x.ecommerce_float_price::numeric / 1.15::numeric) * x.discount::numeric / 100::numeric
                    ELSE x.discount::numeric
                  END,
                0::numeric
            ) + (x.ecommerce_float_price::numeric - x.ecommerce_float_price::numeric / 1.15::numeric),
            2
        ) AS product_discounts
    FROM (
        SELECT DISTINCT ON (pp.product_id)
            pp.product_id, lr.discount_mode, lr.discount, pp.ecommerce_float_price
        FROM page_products pp
        JOIN active_loyalty_program alp ON alp.company_id = pp.company_id
        JOIN loyalty_reward lr ON lr.program_id = alp.id
        ORDER BY pp.product_id, lr.id
    ) x
),
wishlist_user AS (
    SELECT rp.id AS user_id
    FROM normalized_params r
    JOIN res_partner rp ON rp.app_user_id = r.app_user_id
    WHERE r.app_user_id IS NOT NULL
    LIMIT 1
),
wishlist_products AS (
    SELECT DISTINCT wpp.product_tmpl_id
    FROM wishlist_user wu
    JOIN wishlist wl ON wl.user_id = wu.user_id AND wl.is_active = TRUE
    JOIN product_product wpp ON wpp.id = wl.product_id
    JOIN page_products pp ON pp.product_id = wpp.product_tmpl_id
)
SELECT
    pp.product_id,
    CASE
        WHEN pp.product_name_raw IS NULL THEN NULL
        WHEN jsonb_typeof(pp.product_name_raw::jsonb) = 'object'
            THEN COALESCE(pp.product_name_raw::jsonb ->> 'en_US', pp.product_name_raw::text)
        ELSE pp.product_name_raw::text
    END AS product_name,
    CASE
        WHEN pp.description_raw IS NULL THEN NULL
        WHEN jsonb_typeof(pp.description_raw::jsonb) = 'object'
            THEN pp.description_raw::jsonb ->> 'en_US'
        ELSE pp.description_raw::text
    END AS description,
    CONCAT(COALESCE(pp.sold_count, 0), ' Units') AS total_sold_qty,
    pp.ecommerce_float_price AS list_price,
    'ETB' AS currency,
    CASE
        WHEN COALESCE(dd.discount, ld.discount, '[]'::jsonb) <> '[]'::jsonb
            THEN COALESCE(dd.product_discounts, ld.product_discounts, 0)
        ELSE 0
    END AS product_discounts,
    COALESCE(dd.discount, ld.discount, '[]'::jsonb) AS discount,
    NULLIF(pp.image_1920_url, '') AS image,
    COALESCE(pp.total_reviews, 0) AS total_review,
    COALESCE(pp.average_rating, 0.0) AS average_rating,
    COALESCE(pp.total_variants, 0) AS tototal_variants,
    COALESCE(pp.t_is_featured, FALSE) AS is_featured,
    COALESCE(pp.is_halal, FALSE) AS is_halal,
    COALESCE(pp.is_arrival, FALSE) AS is_arrival,
    EXISTS (
        SELECT 1
        FROM wishlist_products wp
        WHERE wp.product_tmpl_id = pp.product_id
    ) AS is_wishlisted
FROM page_products pp
LEFT JOIN direct_discount dd ON dd.product_id = pp.product_id
LEFT JOIN loyalty_discount ld ON ld.product_id = pp.product_id
CROSS JOIN normalized_params r
ORDER BY
    CASE WHEN r.sort_mode = 'sold_asc' THEN pp.sold_count END ASC,
    CASE WHEN r.sort_mode = 'sold_desc' THEN pp.sold_count END DESC,
    pp.product_id DESC;
```


## Endpoint 12 — GET /api/v1/{merchant:string}/popular_merchant_products/category/{category_id:int}

```sql

WITH normalized_params AS (
    SELECT
        NULLIF(TRIM(%s), '')::text AS merchant, --'MRT000052SPR'
        GREATEST(COALESCE(10::int, 10), 1) AS per_page,
        GREATEST(COALESCE(NULL::int, 500), 1) AS fetch_limit,
        COALESCE(NULL::double precision, 0) AS min_price,
        COALESCE(NULL::double precision, 10000000) AS max_price,
        %s::int AS category_id, -- 1 catgory id 
        NULLIF(TRIM(%s), '')::text AS app_user_id, --'user id'
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN 'sold_desc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'asc' THEN 'sold_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'desc' THEN 'sold_desc'
            ELSE 'sold_desc'
        END AS sort_mode,
        NULLIF(TRIM(NULL), '')::bigint AS cursor_id,
        NULLIF(TRIM(NULL), '')::integer AS cursor_sold_count,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS halal_filter
),
merchant_company AS (
    SELECT c.id, c.merchant, c.name AS merchant_name
    FROM res_company c
    CROSS JOIN normalized_params r
    WHERE c.merchant = r.merchant
      AND c.active = TRUE
      AND c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
    LIMIT 1
),
page_products AS (
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
        mc.merchant,
        mc.merchant_name
    FROM merchant_company mc
    JOIN product_template pt
      ON pt.company_id = mc.id
    CROSS JOIN normalized_params r
    WHERE pt.ecomerce_category_id = r.category_id
      AND pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND pt.sold_count > 0
      AND pt.is_in_stock = TRUE
      AND pt.ecommerce_float_price >= r.min_price
      AND pt.ecommerce_float_price <= r.max_price
      AND (r.halal_filter IS NULL OR COALESCE(pt.is_halal, FALSE) = r.halal_filter)
      AND (
          r.cursor_id IS NULL
          OR r.cursor_sold_count IS NULL
          OR (
              r.sort_mode = 'sold_desc'
              AND (
                  pt.sold_count < r.cursor_sold_count
                  OR (
                      pt.sold_count = r.cursor_sold_count
                      AND pt.id < r.cursor_id
                  )
              )
          )
          OR (
              r.sort_mode = 'sold_asc'
              AND (
                  pt.sold_count > r.cursor_sold_count
                  OR (
                      pt.sold_count = r.cursor_sold_count
                      AND pt.id < r.cursor_id
                  )
              )
          )
      )
    ORDER BY
        CASE WHEN r.sort_mode = 'sold_asc' THEN pt.sold_count END ASC,
        CASE WHEN r.sort_mode = 'sold_desc' THEN pt.sold_count END DESC,
        pt.id DESC
    LIMIT (
        SELECT LEAST(per_page + 1, fetch_limit)
        FROM normalized_params
    )
),
direct_discounts AS (
    SELECT
        pp.product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', INITCAP(pd.discount_type),
                'discount_value', pd.discount_value::text
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                pp.ecommerce_float_price::numeric / 1.15
                - CASE
                    WHEN pd.discount_type = 'percentage'
                    THEN (pp.ecommerce_float_price::numeric / 1.15) * pd.discount_value::numeric / 100
                    ELSE pd.discount_value::numeric
                  END,
                0
            )
            + (
                pp.ecommerce_float_price::numeric
                - pp.ecommerce_float_price::numeric / 1.15
            ),
            2
        ) AS product_discounts
    FROM page_products pp
    JOIN LATERAL (
        SELECT pd.discount_type, pd.discount_value
        FROM product_discount pd
        WHERE pd.product_tmpl_id = pp.product_id
          AND pd.is_active = TRUE
          AND pd.x_superapp_approval_status = 'approved'
          AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
          AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
        ORDER BY pd.id
        LIMIT 1
    ) pd ON TRUE
),
active_loyalty_program AS (
    SELECT lp.id, lp.company_id
    FROM merchant_company mc
    JOIN loyalty_program lp ON lp.company_id = mc.id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
    ORDER BY lp.sequence, lp.id
    LIMIT 1
),
loyalty_discounts AS (
    SELECT
        pp.product_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
                'discount_value', lr.discount::text
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                pp.ecommerce_float_price::numeric / 1.15
                - CASE
                    WHEN lr.discount_mode = 'percent'
                    THEN (pp.ecommerce_float_price::numeric / 1.15) * lr.discount::numeric / 100
                    ELSE lr.discount::numeric
                  END,
                0
            )
            + (
                pp.ecommerce_float_price::numeric
                - pp.ecommerce_float_price::numeric / 1.15
            ),
            2
        ) AS product_discounts
    FROM page_products pp
    JOIN active_loyalty_program alp ON alp.company_id = pp.company_id
    JOIN LATERAL (
        SELECT lr.discount_mode, lr.discount
        FROM loyalty_reward lr
        WHERE lr.program_id = alp.id
        ORDER BY lr.id
        LIMIT 1
    ) lr ON TRUE
),
wishlist_products AS (
    SELECT DISTINCT wpp.product_tmpl_id
    FROM normalized_params r
    JOIN res_partner rp ON rp.app_user_id = r.app_user_id
    JOIN wishlist wl ON wl.user_id = rp.id AND wl.is_active = TRUE
    JOIN product_product wpp ON wpp.id = wl.product_id
    JOIN page_products pp ON pp.product_id = wpp.product_tmpl_id
    WHERE r.app_user_id IS NOT NULL
),
final_products AS (
    SELECT
        pp.*,
        CASE
            WHEN dd.discount IS NOT NULL THEN dd.discount
            ELSE COALESCE(ld.discount, '[]'::jsonb)
        END AS discount,
        CASE
            WHEN dd.discount IS NOT NULL THEN COALESCE(dd.product_discounts, 0)
            ELSE COALESCE(ld.product_discounts, 0)
        END AS product_discounts,
        EXISTS (
            SELECT 1
            FROM wishlist_products wp
            WHERE wp.product_tmpl_id = pp.product_id
        ) AS is_wishlisted
    FROM page_products pp
    LEFT JOIN direct_discounts dd ON dd.product_id = pp.product_id
    LEFT JOIN loyalty_discounts ld ON ld.product_id = pp.product_id
)
SELECT
    fp.product_id,
    CASE
        WHEN fp.product_name_raw IS NULL THEN NULL
        WHEN jsonb_typeof(fp.product_name_raw::jsonb) = 'object'
            THEN COALESCE(fp.product_name_raw::jsonb ->> 'en_US', fp.product_name_raw::text)
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
    CASE WHEN fp.discount <> '[]'::jsonb THEN fp.product_discounts ELSE 0 END AS product_discounts,
    COALESCE(fp.discount, '[]'::jsonb) AS discount,
    NULLIF(fp.image_1920_url, '') AS image,
    COALESCE(fp.total_reviews, 0) AS total_review,
    COALESCE(fp.average_rating, 0.0) AS average_rating,
    COALESCE(fp.total_variants, 0) AS total_variants,
    COALESCE(fp.t_is_featured, FALSE) AS is_featured,
    COALESCE(fp.is_halal, FALSE) AS is_halal,
    COALESCE(fp.is_arrival, FALSE) AS is_arrival,
    fp.is_wishlisted
FROM final_products fp
CROSS JOIN normalized_params r
ORDER BY
    CASE WHEN r.sort_mode = 'sold_asc' THEN fp.sold_count END ASC,
    CASE WHEN r.sort_mode = 'sold_desc' THEN fp.sold_count END DESC,
    fp.product_id DESC;
```

## Endpoint 13 — GET /api/v1/popular_categories

```sql
SELECT 
    pec.id AS category_id,
    pec.name AS category_name,
    pec.superapp_sale_count AS total_sold_qty,
    pec.product_count AS product_count,
    pec.image_1_url
FROM product_ecomerce_categories pec
WHERE 
    pec.superapp_sale_count > 0 
    AND pec.superapp_sale_count < 1000
    AND (pec.superapp_sale_count, pec.id) < (%cursor_sale_count, %cursor_id)
ORDER BY 
    pec.superapp_sale_count DESC,
    pec.id DESC
LIMIT %lim;
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
                  SELECT id
                  FROM res_company
                  WHERE parent_id = rc.id
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
    rc.merchant = %s
    AND rc.cps_enabled = true
    AND so.superapp_order_status = 'delivered'
    AND so.is_superapp_order = true
    AND sol.category_id IS NOT NULL
GROUP BY
    pec.id,
    pec.name,
    pec.image_1_url,
    rc.id
HAVING
    %s IS NULL
    OR (
        COUNT(sol.id),
        pec.id
    ) < (
        %s,
        %s
    )
ORDER BY
    COUNT(sol.id) DESC,
    pec.id DESC
LIMIT %s;
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
            INNER JOIN product_template pt
                ON pp.product_tmpl_id = pt.id
            WHERE pt.company_id = rc.id
              AND pp.active = true
              AND pt.active = true
              AND pt.sale_ok = true
              AND pt.x_superapp_approval_status = 'approved'
        ) AS product_variant_count

    FROM res_company rc
    LEFT JOIN res_company prc
        ON rc.parent_id = prc.id
    LEFT JOIN company_business_type cbt
        ON cbt.id = rc.business_type_id

    WHERE (
        rc.name ILIKE '%a%'
        OR rc.merchant ILIKE '%a%'
    )
    AND rc.cps_enabled = true
    AND (
        
         rc.id > %(cursor_id)
    )

    ORDER BY rc.id ASC
    LIMIT %(lim)
)
SELECT
    json_build_object(
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
                ORDER BY ms.id ASC
            ),
            '[]'::json
        )
    ) AS response
FROM merchant_stats ms;
```

## Endpoint 16 — GET /api/v1/search/all/<query:string>

```sql
SELECT json_build_object(
    'query', %s,                
	
    'merchants_count', (
        SELECT COUNT(DISTINCT rc.id)
        FROM res_company rc
        JOIN product_template pt
            ON pt.company_id = rc.id
           AND pt.x_superapp_approval_status = 'approved'
        WHERE (rc.name ILIKE %s OR rc.merchant ILIKE %s)
          AND rc.cps_enabled = TRUE
          AND rc.is_delivery = FALSE
    ),

    'merchants', COALESCE((
        SELECT json_agg(company)
        FROM (
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
                COUNT(DISTINCT pt.id) AS product_template_count,
                COUNT(DISTINCT pp.id) AS product_variant_count
            FROM res_company rc
            LEFT JOIN product_template pt
                ON pt.company_id = rc.id
               AND pt.x_superapp_approval_status = 'approved'
            LEFT JOIN product_product pp
                ON pp.product_tmpl_id = pt.id
            LEFT JOIN res_company prc
                ON rc.parent_id = prc.id
            LEFT JOIN company_business_type cbt
                ON cbt.id = rc.business_type_id
            WHERE (rc.name ILIKE %s OR rc.merchant ILIKE %s)
              AND rc.cps_enabled = TRUE
              AND rc.is_delivery = FALSE
            GROUP BY
                rc.id, rc.name, rc.merchant, cbt.code,
                rc.logo_url, rc.banner_url, rc.is_featured,
                rc.email, rc.phone, rc.parent_id, prc.merchant
            ORDER BY rc.id ASC
            LIMIT %s
        ) company
    ), '[]'::json),
	
    'products_total', (
        SELECT COUNT(DISTINCT pt.id)
        FROM product_template pt
        JOIN res_company rc ON rc.id = pt.company_id
        WHERE COALESCE(pt.name->>'en_US', pt.name->>'en', '') ILIKE %s
          AND rc.cps_enabled = TRUE
          AND rc.is_delivery = FALSE
          AND pt.x_superapp_approval_status = 'approved'
    ),

    'products', COALESCE((
        SELECT json_agg(product)
        FROM (
            SELECT
                pt.id,
                COALESCE(pt.name->>'en_US', pt.name->>'en', '') AS name,
                pt.image_1920_url AS image_url,
                pt.ecommerce_float_price AS list_price,
                json_build_object(
                    'id',       rc.id,
                    'name',     rc.name,
                    'merchant', rc.merchant,
                    'logo',     rc.logo_url
                ) AS company,
                pt.average_rating,
                COUNT(pr.id) AS total_reviews
            FROM product_template pt
            JOIN res_company rc ON rc.id = pt.company_id
            LEFT JOIN product_review pr ON pr.product_template = pt.id
            WHERE COALESCE(pt.name->>'en_US', pt.name->>'en', '') ILIKE %s
              AND rc.cps_enabled = TRUE
              AND rc.is_delivery = FALSE
              AND pt.x_superapp_approval_status = 'approved'
            GROUP BY pt.id, rc.id
            ORDER BY pt.id ASC
            LIMIT %s
        ) product
    ), '[]'::json),

    'categories_count', (
        SELECT COUNT(*)
        FROM product_ecomerce_categories pec
        WHERE pec.name ILIKE %s
    ),

    'categories', COALESCE((
        SELECT json_agg(category)
        FROM (
            SELECT
                pec.id,
                pec.name,
                pec.complete_name,
                pec.image_1_url
            FROM product_ecomerce_categories pec
            WHERE pec.name ILIKE %s
            ORDER BY pec.id ASC
            LIMIT %s
        ) category
    ), '[]'::json)

) AS result;
```

## Endpoint 17 — GET /api/v1/products/search/{query:string}

```sql
SELECT
    pt.id,
    COALESCE(pt.name->>'en_US', pt.name->>'en', '') AS name,
    pt.ecommerce_float_price AS list_price,
    pt.image_1920_url AS image_url,
    pt.average_rating,
    COALESCE(pt.total_reviews, 0) AS total_reviews,
    json_build_object(
        'id', rc.id,
        'name', rc.name,
        'merchant', rc.merchant,
        'logo', rc.logo_url
    ) AS company
FROM product_template pt
JOIN res_company rc
    ON rc.id = pt.company_id
   AND rc.cps_enabled = true
WHERE COALESCE(
    pt.name->>'en_US',
    pt.name->>'en',
    ''
) ILIKE  %s --'%e%'
AND (
    COALESCE(pt.reviews_count, 0),
    pt.id
) < (%s, %s)
ORDER BY
    COALESCE(pt.reviews_count, 0) DESC,
    pt.id DESC
LIMIT %lim;
```

## Endpoint 18 — GET /api/v1/categories/search?query={query:string}

```sql
SELECT
    pec.id,
    pec.name,
    pec.complete_name,
    pec.image_1_url AS image,
    pec.product_count AS items,
    parent.id AS parent_id,
    parent.name AS parent_name
FROM product_ecomerce_categories pec
LEFT JOIN product_ecomerce_categories parent
    ON pec.parent_id = parent.id
WHERE
    pec.name ILIKE '%e%'
	AND pec.product_count > 0
   AND pec.id < %cursor_id
GROUP BY
    pec.id,
    parent.id
ORDER BY
    pec.id DESC
LIMIT %lim;
```

## Endpoint 19 — GET /api/v1/total_products

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
WITH normalized_params AS (
    SELECT
        NULLIF(TRIM(NULL), '')::bigint AS cursor_id,
        NULL::double precision AS cursor_price,
        NULLIF(TRIM(NULL), '')::text AS merchant,
        GREATEST(COALESCE(NULL::int, 10), 1) AS per_page,
        NULL::int AS fetch_limit,
        COALESCE(NULL::double precision, 0) AS min_price,
        COALESCE(NULL::double precision, 10000000) AS max_price,
        COALESCE(NULL::int, 0) AS category_id,
        NULLIF(TRIM(%s), '')::text AS app_user_id,  --'user_id'
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN 'price_desc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN 'price_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'asc' THEN 'price_asc'
            WHEN LOWER(COALESCE(TRIM(NULL), '')) = 'desc' THEN 'price_desc'
            ELSE 'id_desc'
        END AS sort_mode,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS featured_filter,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS halal_filter,
        CASE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('true', '1', 'yes') THEN TRUE
            WHEN LOWER(COALESCE(TRIM(NULL), '')) IN ('false', '0', 'no') THEN FALSE
            ELSE NULL
        END AS arrival_filter,
        COALESCE(NULLIF(LOWER(TRIM(NULL)), '') IN ('true', '1', 'yes'), FALSE) AS discount_only
),
allowed_companies AS (
    SELECT c.id
    FROM res_company c
    CROSS JOIN normalized_params r
    WHERE c.cps_enabled = TRUE
      AND COALESCE(c.is_delivery, FALSE) = FALSE
      AND c.active = TRUE
      AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
      AND (
          (
              r.merchant IS NULL
              AND (
                  c.parent_id IS NULL
                  OR EXISTS (
                      SELECT 1
                      FROM res_company p
                      WHERE p.id = c.parent_id
                        AND p.parent_id IS NULL
                        AND p.cps_enabled = TRUE
                        AND COALESCE(p.is_delivery, FALSE) = FALSE
                        AND p.active = TRUE
                        AND NULLIF(TRIM(p.merchant), '') IS NOT NULL
                  )
              )
          )
          OR (
              r.merchant IS NOT NULL
              AND (
                  c.merchant = r.merchant
                  OR EXISTS (
                      SELECT 1
                      FROM res_company p
                      WHERE p.id = c.parent_id
                        AND p.parent_id IS NULL
                        AND p.cps_enabled = TRUE
                        AND COALESCE(p.is_delivery, FALSE) = FALSE
                        AND p.active = TRUE
                        AND p.merchant = r.merchant
                  )
              )
          )
      )
),
active_discount_products AS (
    SELECT DISTINCT pd.product_tmpl_id
    FROM product_discount pd
    CROSS JOIN normalized_params r
    WHERE r.discount_only = TRUE
      AND pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
),
active_loyalty_companies AS (
    SELECT DISTINCT lp.company_id
    FROM loyalty_program lp
    CROSS JOIN normalized_params r
    WHERE r.discount_only = TRUE
      AND lp.company_id IS NOT NULL
      AND lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),
page_product_ids AS (
    SELECT
        pt.id,
        pt.company_id,
        pt.ecommerce_float_price
    FROM product_template pt
    CROSS JOIN normalized_params r
    WHERE pt.active = TRUE
      AND pt.is_for_ecommerce = TRUE
      AND pt.is_in_stock = TRUE
      AND pt.x_superapp_approval_status = 'approved'
      AND EXISTS (
          SELECT 1
          FROM allowed_companies ac
          WHERE ac.id = pt.company_id
      )
      AND pt.ecommerce_float_price >= r.min_price
      AND pt.ecommerce_float_price <= r.max_price
      AND (r.category_id = 0 OR pt.ecomerce_category_id = r.category_id)
      AND (r.featured_filter IS NULL OR COALESCE(pt.t_is_featured, FALSE) = r.featured_filter)
      AND (r.halal_filter IS NULL OR COALESCE(pt.is_halal, FALSE) = r.halal_filter)
      AND (r.arrival_filter IS NULL OR COALESCE(pt.is_arrival, FALSE) = r.arrival_filter)
      AND (
          r.cursor_id IS NULL
          OR (
              r.sort_mode = 'price_desc'
              AND r.cursor_price IS NOT NULL
              AND (
                  pt.ecommerce_float_price < r.cursor_price
                  OR (
                      pt.ecommerce_float_price = r.cursor_price
                      AND pt.id < r.cursor_id
                  )
              )
          )
          OR (
              r.sort_mode = 'price_asc'
              AND r.cursor_price IS NOT NULL
              AND (
                  pt.ecommerce_float_price > r.cursor_price
                  OR (
                      pt.ecommerce_float_price = r.cursor_price
                      AND pt.id < r.cursor_id
                  )
              )
          )
          OR (
              r.sort_mode = 'id_desc'
              AND pt.id < r.cursor_id
          )
      )
      AND (
          NOT r.discount_only
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
        CASE WHEN r.sort_mode = 'price_desc' THEN pt.ecommerce_float_price END DESC,
        CASE WHEN r.sort_mode = 'price_asc' THEN pt.ecommerce_float_price END ASC,
        pt.id DESC
    LIMIT (
        SELECT LEAST(
            COALESCE(fetch_limit, per_page + 1),
            1000
        )
        FROM normalized_params
    )
),
page_products AS (
    SELECT
        pt.id,
        pt.name,
        pt.description_sale,
        pt.ecommerce_float_price,
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
    FROM page_product_ids p
    JOIN product_template pt
        ON pt.id = p.id
    JOIN res_company c
        ON c.id = p.company_id
),
product_discounts AS (
    SELECT
        x.product_tmpl_id,
        JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
                'discount_type',
                CASE
                    WHEN x.discount_type IS NOT NULL THEN INITCAP(x.discount_type)
                    ELSE NULL
                END,
                'discount_value',
                CASE
                    WHEN x.discount_value IS NULL THEN NULL
                    ELSE x.discount_value::text
                END
            )
        ) AS discount,
        TRUNC(
            GREATEST(
                (x.ecommerce_float_price::numeric / 1.15::numeric)
                -
                CASE
                    WHEN x.discount_type = 'percentage'
                    THEN (x.ecommerce_float_price::numeric / 1.15::numeric) * x.discount_value::numeric / 100
                    ELSE x.discount_value::numeric
                END,
                0::numeric
            )
            +
            (
                x.ecommerce_float_price::numeric
                - x.ecommerce_float_price::numeric / 1.15::numeric
            ),
            2
        ) AS product_discounts
    FROM (
        SELECT DISTINCT ON (pd.product_tmpl_id)
            pd.product_tmpl_id,
            pd.discount_type,
            pd.discount_value,
            pp.ecommerce_float_price
        FROM product_discount pd
        JOIN page_products pp
            ON pp.id = pd.product_tmpl_id
        WHERE pd.is_active = TRUE
          AND pd.x_superapp_approval_status = 'approved'
          AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
          AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
        ORDER BY pd.product_tmpl_id, pd.id
    ) x
),
active_loyalty_rewards AS MATERIALIZED (
    SELECT DISTINCT ON (lp.company_id)
        lp.company_id,
        lr.discount_mode,
        lr.discount
    FROM loyalty_program lp
    JOIN loyalty_reward lr
        ON lr.program_id = lp.id
    WHERE lp.program_type = 'promotion'
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND lp.company_id IS NOT NULL
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
      AND EXISTS (
          SELECT 1
          FROM page_products pp
          WHERE pp.company_id = lp.company_id
      )
    ORDER BY lp.company_id, lp.id, lr.id
),
wishlist_products AS (
    SELECT DISTINCT pp.product_tmpl_id
    FROM wishlist wl
    JOIN product_product pp
        ON pp.id = wl.product_id
    JOIN res_partner rp
        ON rp.id = wl.user_id
    CROSS JOIN normalized_params r
    WHERE wl.is_active = TRUE
      AND r.app_user_id IS NOT NULL
      AND rp.app_user_id = TRIM(r.app_user_id)
      AND EXISTS (
          SELECT 1
          FROM page_products p
          WHERE p.id = pp.product_tmpl_id
      )
),
final_products AS (
    SELECT
        pp.*,
        COALESCE(pd.discount, '[]'::jsonb) AS direct_discount,
        COALESCE(pd.product_discounts, 0) AS direct_product_discounts,
        CASE
            WHEN alr.company_id IS NOT NULL THEN
                JSONB_BUILD_ARRAY(
                    JSONB_BUILD_OBJECT(
                        'discount_type',
                        CASE
                            WHEN alr.discount_mode = 'percent'
                            THEN 'Percentage'
                            ELSE INITCAP(alr.discount_mode)
                        END,
                        'discount_value',
                        CASE
                            WHEN alr.discount IS NULL
                            THEN NULL
                            ELSE alr.discount::text
                        END
                    )
                )
            ELSE '[]'::jsonb
        END AS loyalty_discount,
        CASE
            WHEN alr.company_id IS NULL OR alr.discount IS NULL THEN 0
            ELSE
                TRUNC(
                    GREATEST(
                        (pp.ecommerce_float_price::numeric / 1.15::numeric)
                        -
                        CASE
                            WHEN alr.discount_mode = 'percent'
                            THEN
                                (pp.ecommerce_float_price::numeric / 1.15::numeric)
                                * alr.discount::numeric / 100
                            ELSE
                                alr.discount::numeric
                        END,
                        0::numeric
                    )
                    +
                    (
                        pp.ecommerce_float_price::numeric
                        - pp.ecommerce_float_price::numeric / 1.15::numeric
                    ),
                    2
                )
        END AS loyalty_product_discounts,
        EXISTS (
            SELECT 1
            FROM wishlist_products wp
            WHERE wp.product_tmpl_id = pp.id
        ) AS is_wishlisted
    FROM page_products pp
    LEFT JOIN product_discounts pd
        ON pd.product_tmpl_id = pp.id
    LEFT JOIN active_loyalty_rewards alr
        ON alr.company_id = pp.company_id
)
SELECT
    fp.id,
    fp.name ->> 'en_US' AS name,
    NULLIF(fp.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(fp.image_1920_url, '') AS product_image,
    fp.ecommerce_float_price AS list_price,
    CASE
        WHEN fp.direct_discount <> '[]'::jsonb
        THEN fp.direct_discount
        ELSE fp.loyalty_discount
    END AS discount,
    CASE
        WHEN fp.direct_discount <> '[]'::jsonb
        THEN fp.direct_product_discounts
        ELSE fp.loyalty_product_discounts
    END AS product_discounts,
    COALESCE(fp.t_is_featured, FALSE) AS is_featured,
    COALESCE(fp.is_halal, FALSE) AS is_halal,
    COALESCE(fp.is_arrival, FALSE) AS is_arrival,
    NULLIF(fp.min_quantity, 0) AS min_quantity,
    NULLIF(fp.max_quantity, 0) AS max_quantity,
    COALESCE(fp.total_reviews, 0) AS total_review_count,
    COALESCE(fp.average_rating, 0.0) AS average_rating,
    COALESCE(fp.total_variants, 0) AS total_variants,
    JSONB_BUILD_OBJECT(
        'merchant', fp.merchant,
        'name', fp.company_name,
        'logo', NULLIF(fp.logo_url, '')
    ) AS merchant,
    fp.is_wishlisted
FROM final_products fp
CROSS JOIN normalized_params r
ORDER BY
    CASE WHEN r.sort_mode = 'price_desc' THEN fp.ecommerce_float_price END DESC,
    CASE WHEN r.sort_mode = 'price_asc' THEN fp.ecommerce_float_price END ASC,
    fp.id DESC;
```

## Endpoint 20 — GET /api/v1/merchants/list_all
```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
WITH params AS (
    SELECT
        NULL::int AS cursor_id,
        10::int AS per_page,
        NULL::int AS fetch_limit,
        NULL::text AS is_featured_param,
        NULL::text AS is_discount_param,
        NULL::text AS is_delivery_param
),
p AS (
    SELECT
        cursor_id,
        LEAST(GREATEST(per_page, 1), 100) AS per_page,
        LEAST(GREATEST(COALESCE(fetch_limit, per_page + 1), 1), 1000) AS fetch_limit,
        CASE
            WHEN lower(trim(coalesce(is_featured_param, ''))) IN ('true', 'yes', '1') THEN TRUE
            ELSE FALSE
        END AS featured_filter,
        CASE
            WHEN lower(trim(coalesce(is_discount_param, ''))) IN ('true', 'yes', '1') THEN TRUE
            WHEN lower(trim(coalesce(is_discount_param, ''))) IN ('false', 'no', '0') THEN FALSE
            ELSE NULL
        END AS discount_filter,
        CASE
            WHEN lower(trim(coalesce(is_delivery_param, ''))) IN ('true', 'yes', '1') THEN TRUE
            WHEN lower(trim(coalesce(is_delivery_param, ''))) IN ('false', 'no', '0') THEN FALSE
            ELSE FALSE
        END AS delivery_filter
    FROM params
),
active_loyalty_companies AS (
    SELECT DISTINCT lp.company_id
    FROM loyalty_program lp
    CROSS JOIN p
    WHERE p.discount_filter IS NOT NULL
      AND lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),
paginated_merchant_ids AS (
    SELECT c.id
    FROM res_company c
    CROSS JOIN p
    LEFT JOIN active_loyalty_companies alc ON alc.company_id = c.id
    WHERE c.parent_id IS NULL
      AND c.merchant IS NOT NULL
      AND c.merchant <> ''
      AND c.cps_enabled = TRUE
      AND c.active = TRUE
      AND c.is_delivery = p.delivery_filter
      AND (NOT p.featured_filter OR c.is_featured = TRUE)
      AND (p.discount_filter IS NULL OR (alc.company_id IS NOT NULL) = p.discount_filter)
      AND (p.cursor_id IS NULL OR c.id < p.cursor_id)
    ORDER BY c.id DESC
    LIMIT (SELECT fetch_limit FROM p)
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
    JOIN res_company c ON c.id = pm.id
),
page_loyalty_programs AS (
    SELECT
        lp.company_id,
        lp.id AS program_id,
        lp.name AS program_name,
        lp.sequence,
        ROW_NUMBER() OVER (
            PARTITION BY lp.company_id
            ORDER BY lp.sequence, lp.id
        ) AS loyalty_row_num
    FROM loyalty_program lp
    JOIN paginated_merchant_ids pm ON pm.id = lp.company_id
    WHERE lp.is_ecommerce = TRUE
      AND lp.x_superapp_approval_status = 'approved'
      AND (lp.date_from IS NULL OR lp.date_from <= CURRENT_DATE)
      AND (lp.date_to IS NULL OR lp.date_to >= CURRENT_DATE)
),
page_loyalty AS (
    SELECT
        plp.company_id,
        TRUE AS is_discount,
        json_build_array(
            json_build_object(
                'id', plp.program_id,
                'name', plp.program_name ->> 'en_US',
                'rewards', COALESCE(
                    json_agg(
                        json_build_object(
                            'discount', lr.discount,
                            'discount_mode', lr.discount_mode
                        ) ORDER BY lr.id
                    ) FILTER (WHERE lr.id IS NOT NULL),
                    '[]'::json
                )
            )
        ) AS discount
    FROM page_loyalty_programs plp
    LEFT JOIN loyalty_reward lr ON lr.program_id = plp.program_id
    WHERE plp.loyalty_row_num = 1
    GROUP BY plp.company_id, plp.program_id, plp.program_name
)
SELECT
    pm.merchant AS merchant_id,
    pm.name,
    NULLIF(pm.logo_url, '') AS logo,
    NULLIF(pm.banner_url, '') AS banner,
    bt.code AS business_type,
    COALESCE(pm.product_count, 0) AS total_products,
    CASE
        WHEN pm.open_hour IS NOT NULL AND pm.open_moment IS NOT NULL THEN
            LPAD(FLOOR(pm.open_hour)::int::text, 2, '0') || ':' ||
            LPAD(LEAST(FLOOR((pm.open_hour - FLOOR(pm.open_hour)) * 60)::numeric, 59)::int::text, 2, '0') ||
            ' ' || UPPER(pm.open_moment)
        ELSE NULL
    END AS opening_time,
    CASE
        WHEN pm.close_hour IS NOT NULL AND pm.close_moment IS NOT NULL THEN
            LPAD(FLOOR(pm.close_hour)::int::text, 2, '0') || ':' ||
            LPAD(LEAST(FLOOR((pm.close_hour - FLOOR(pm.close_hour)) * 60)::numeric, 59)::int::text, 2, '0') ||
            ' ' || UPPER(pm.close_moment)
        ELSE NULL
    END AS closing_time,
    NULLIF(pm.cps_account_number, '') AS cps_account_number,
    COALESCE(pl.is_discount, FALSE) AS is_discount,
    COALESCE(pl.discount, '[]'::json) AS discount
FROM paginated_merchants pm
LEFT JOIN company_business_type bt ON bt.id = pm.business_type_id
LEFT JOIN page_loyalty pl ON pl.company_id = pm.id
ORDER BY pm.id DESC;
```

## Endpoint 21 — GET /api/v1/merchant/{merchant}

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
-- query merchant 
SELECT
    c.id,
    c.name,
    c.merchant AS merchant_id,
    c.business_type,
    c.logo_url AS logo,
    COALESCE(c.is_featured, FALSE) AS is_featured,
    c.banner_url AS banner,
    c.opening_time,
    c.closing_time,
    c.cps_account_number,
    c.lat_location,
    c.lng_location,
    c.map_holder,
    c.street,
    c.city,
    c.description,
    c.product_count AS product_template_count,
    c.variant_count AS product_variant_count
FROM res_company c
WHERE c.merchant = %s::text  --'MRT000016SPR'  -- 'MRT000016SPR' merchant id
  AND c.cps_enabled IS TRUE
  AND c.is_delivery IS NOT TRUE
  AND c.active IS TRUE
LIMIT 1;

-- query branch for mercant  branches : [{}]
SELECT
    b.id,
    b.name,
    b.merchant AS branch_id,
    b.logo_url AS logo,
    b.banner_url AS banner,
    COALESCE(b.is_featured, FALSE) AS is_featured,
    b.business_type AS business_type,
    b.opening_time AS opening_time,
    b.closing_time AS closing_time,
    b.cps_account_number AS cps_account_number,
    b.email AS email,
    b.phone AS phone,
    b.lat_location AS lat_location,
    b.lng_location AS lng_location,
    b.map_holder AS map_holder,
    b.street AS street,
    b.city AS city,
    b.description AS description,
    b.product_count AS product_template_count,
    b.variant_count AS product_variant_count
FROM res_company b
WHERE b.parent_id = $2 -- Primary Key - Id from the first query merchant 
  AND b.cps_enabled IS TRUE
  AND b.active IS TRUE
  AND b.merchant IS NOT NULL;


```

## Endpoint 22 — GET /api/v1/wishlist/{user_id}


Path: user_id          (res_partner.app_user_id)
Query: cursor, per_page, min_price, max_price, category_id, high_to_low, order

Defaults: per_page=10, min_price=0, max_price=10000000


 **Sort modes**

| Condition | Sort | Cursor predicate |
|---|---|---|
| Default (no `high_to_low`, no `order`) | `wishlist.id DESC` | `cursor_id = 0 OR f.id < cursor_id` |
| `high_to_low=true/1/yes` or `order` present | `price DESC, id DESC` | keyset on `(price, id)` — see below |
| `high_to_low=false/0/no` | `price ASC, id ASC` | keyset on `(price, id)` |
| `order=asc` (without high_to_low) | `price ASC, id ASC` | keyset on `(price, id)` |
| other `order` value | `price DESC, id DESC` | keyset on `(price, id)` |

**Important:** `cursor` is always the last **`wishlist.id`** from the previous page, even when sorting by price. Do not change sort/filter between pages.

Bind params (no category)

$1 = app_user_id
$2 = min_price
$3 = max_price
$4 = fetch_limit       (per_page + 1)
$5 = cursor_id         (0 on first page)


**Bind params (with category_id)**


$1 = app_user_id
$2 = min_price
$3 = max_price
$4 = category_id
$5 = fetch_limit
$6 = cursor_id


Add to `filtered` WHERE: `AND pt.ecomerce_category_id = $4`

Price-sort cursor predicates

After resolving `cursor_row` (`SELECT id, price FROM filtered WHERE id = cursor_id`):

**DESC:** `(price < cursor.price) OR (price = cursor.price AND id < cursor.id)`  
**ASC:** `(price > cursor.price) OR (price = cursor.price AND id > cursor.id)`

SQL template (default sort: id DESC)

Replace `$4`/`$5` with `$5`/`$6` when using `category_id`.

```sql
WITH input AS (
    SELECT
        $1::text AS app_user_id,
        $2::float8 AS min_price,
        $3::float8 AS max_price,
        $4::int AS lim,
        $5::int AS cursor_id
),
partner AS (
    SELECT id FROM res_partner WHERE app_user_id = (SELECT app_user_id FROM input) LIMIT 1
),
guard AS (
    SELECT EXISTS(SELECT 1 FROM partner) AS partner_exists
),
filtered AS (
    SELECT
        wl.id,
        pt.id AS product_id,
        COALESCE(pt.name->>'en_US', pt.name::text) AS name,
        wl.ecommerce_float_price AS price,
        pt.company_id,
        COALESCE(pt.image_1920_url, '') AS product_image
    FROM partner
    JOIN wishlist wl ON wl.user_id = partner.id
    JOIN product_template pt ON pt.id = wl.product_id
    LEFT JOIN res_company rc ON rc.id = pt.company_id
    WHERE wl.user_id = partner.id
      AND wl.is_active = TRUE
      AND rc.cps_enabled = TRUE
      AND wl.ecommerce_float_price >= $2
      AND wl.ecommerce_float_price <= $3
      -- optional: AND pt.ecomerce_category_id = $4
),
cursor_row AS (
    SELECT f.id, f.price
    FROM filtered f
    JOIN input i ON TRUE
    WHERE i.cursor_id <> 0 AND f.id = i.cursor_id
    LIMIT 1
),
base AS (
    SELECT f.*
    FROM filtered f
    JOIN input i ON TRUE
    WHERE i.cursor_id = 0 OR f.id < i.cursor_id   -- replace when price sorting
    ORDER BY f.id DESC                             -- replace when price sorting
    LIMIT (SELECT lim FROM input)
)
SELECT
    g.partner_exists,
    b.id,
    b.product_id,
    b.name,
    COALESCE(rev.avg_rating, 0.0)::numeric AS avg_rating,
    rev.total_review,
    (SELECT COUNT(*) FROM product_product pp
     WHERE pp.product_tmpl_id = b.product_id AND pp.active = TRUE) AS total_variants,
    b.price,
    b.product_image,
    CASE
        WHEN disc_all.discount_sum IS NOT NULL
          OR (COALESCE(disc_listed.cnt, 0) = 0 AND loy.discount_sum IS NOT NULL)
        THEN COALESCE(disc_all.discount_sum, 0)
           + CASE WHEN COALESCE(disc_listed.cnt, 0) = 0
                  THEN COALESCE(loy.discount_sum, 0) ELSE 0 END
        ELSE NULL
    END AS discounts,
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
           json_agg(json_build_object(
               'name', d.name, 'discount_type', INITCAP(d.discount_type),
               'discount_value', d.discount_value::text,
               'start_date', TO_CHAR(d.start_date, 'DD/MM/YY'),
               'end_date', TO_CHAR(d.end_date, 'DD/MM/YY')
           )) AS discount_json
    FROM product_discount d
    WHERE d.product_tmpl_id = b.product_id AND d.is_active = TRUE AND d.company_id IS NOT NULL
      AND d.x_superapp_approval_status = 'approved'
      AND (d.start_date IS NULL OR d.start_date <= CURRENT_DATE)
      AND (d.end_date IS NULL OR d.end_date >= CURRENT_DATE)
) disc_listed ON b.product_id IS NOT NULL
LEFT JOIN LATERAL (
    SELECT SUM(ROUND((CASE WHEN lr.discount_mode = 'percent'
        THEN b.price - (b.price * lr.discount / 100) ELSE b.price - lr.discount END)::numeric, 2)) AS discount_sum,
           json_agg(json_build_object(
               'name', lp.name->>'en_US',
               'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage'
                   ELSE INITCAP(lr.discount_mode) END,
               'discount_value', lr.discount::text,
               'start_date', TO_CHAR(lp.date_from, 'DD/MM/YY'),
               'end_date', TO_CHAR(lp.date_to, 'DD/MM/YY')
           )) AS discount_json
    FROM loyalty_program lp
    JOIN loyalty_reward lr ON lr.program_id = lp.id
    WHERE COALESCE(disc_listed.cnt, 0) = 0
      AND lp.id = (
          SELECT lp2.id FROM loyalty_program lp2
          WHERE lp2.company_id = b.company_id AND lp2.is_ecommerce = TRUE
            AND lp2.x_superapp_approval_status = 'approved'
            AND (lp2.date_from IS NULL OR lp2.date_from <= CURRENT_DATE)
            AND (lp2.date_to IS NULL OR lp2.date_to >= CURRENT_DATE)
          ORDER BY lp2.id LIMIT 1
      )
) loy ON b.product_id IS NOT NULL
ORDER BY b.id DESC;   -- match base sort
```

## Endpoint 23 — GET /api/v1/driver/orders

**Driver Orders List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_id,
    iso.superapp_order_status AS status,
    dop.order_company_id AS order_from,
    to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date
    
FROM delivery_order dop
INNER JOIN res_partner rp
    ON rp.id = dop.driver_assigned
INNER JOIN res_users ru
    ON ru.partner_id = rp.id
	
LEFT JOIN sale_order iso
    ON iso.id = dop.sale_order_id::integer
WHERE
    ru.token = %s --'98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
    AND dop.state IN ('driver', 'picked')
     dop.id < %cursor_id

ORDER BY dop.id DESC
LIMIT %lim;
```


## 23.2 - GET ordered company info 

** use `order_from` from orders

```
SELECT 
c.name,
c.logo_url as logo,
rp.street,
rp.city,
rcs.name AS pickup_location
FROM res_company c 
LEFT JOIN res_partner rp ON rp.id = c.partner_id
LEFT JOIN res_country_state rcs ON rp.state_id = rcs.id
WHERE c.id = %order_from; --26;
```


## 23.3  Get Ordered Products images

** use `id` from orders **

```
SELECT 
pp.image_1920_url
FROM delivery_order_line dol
INNER JOIN delivery_order dop ON dop.id = dol.delivery_order_id
LEFT JOIN product_product pp ON dol.product_variant_id = pp.id
WHERE dop.id = %id; --59;
```

## Endpoint 24 — GET /api/v1/driver/order/{order_id:int}

**Driver Order Detail**

token: from request header `x-token`

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT 
dop.id,
dop.name AS ref_no,
dop.state AS status,
dop.order_company_id AS pickup_from,
to_char(dop.delivery_date, 'MM/DD/YYYY') AS delivery_date,
dop.delivery_pickup_code,
dop.delivery_lat AS lat,
dop.delivery_long AS lng,
dop.customer_location,
dop.customer_id AS custoemr_id,
dop.delivery_notes AS additional_note

FROM delivery_order dop
INNER JOIN res_users ru ON dop.driver_assigned = ru.partner_id
WHERE 
 ru.token = %s --'98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
   AND dop.state IN ('driver', 'picked')
   AND dop.id = %s; --50;
```

## Endpint 24.2 - GET DELIVEY ORDER LINES

** Delivery order lines query by the delivery order id **

do_id = delivery order id

```sql
SELECT 
dol.id AS id,
pt.name->>'en_US' AS name,
pp.image_1920_url AS image,
dol.quantity AS quantity,
dol.uom_name->>'en_US' AS uom,
dol.description
FROM delivery_order_line dol
INNER JOIN delivery_order dop ON dol.delivery_order_id = dop.id
LEFT JOIN uom_uom uom 
        ON dol.uom = uom.id
LEFT JOIN product_product pp 
	ON dol.product_variant_id = pp.id
LEFT JOIN product_template pt 
	ON pp.product_tmpl_id = pt.id
WHERE dop.id = %do_id; --50;
```

## 24.3 Get Order Company 

** USE `pickup_from` data from delivery_order response **


```
SELECT 
c.id,
c.name,
c.logo_url AS logo,
c.phone,
rp.street,
rp.city,
rcs.name
FROM res_company c 
LEFT JOIN res_partner rp ON rp.id = c.partner_id
LEFT JOIN res_country_state rcs ON rcs.id = rp.state_id
WHERE c.id = %pickup_from;


```

## 24.4 Customer Info

** use `customer_id` from derivery_order response **
```
SELECT 
c.name,
c.phone,
cs.name AS location
FROM res_partner c
LEFT JOIN res_country_state cs ON c.state_id = cs.id
WHERE c.id = %customer_id; --280;

```



## 25 — GET /api/v1/driver/history

**Driver History List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_no,
   dop.order_company_id AS pickup_from,
    to_char(dop.delivery_date, 'MM/DD/YYYY') AS date,
    iso.superapp_order_status AS status
FROM delivery_order dop
LEFT JOIN sale_order iso
    ON iso.id = dop.sale_order_id::integer
INNER JOIN res_partner rp
    ON rp.id = dop.driver_assigned
INNER JOIN res_users ru
    ON ru.partner_id = rp.id       
WHERE 
    ru.token = %token -- '98db652e5c1d9e6e0c1a8eb4abb669fa'
    AND ru.token_expiration_time > NOW()
    AND dop.state IN ('delivered', 'canceled')
    AND dop.id < %cursor_id --1000
ORDER BY dop.id DESC
LIMIT %lim; --10;
```

## 25.2 Ordered Company info

** use `pickup_from` from order ** 

```
SELECT 
c.name,
rp.street 
FROM res_company c 
LEFT JOIN res_partner rp ON rp.id = c.partner_id
WHERE c.id = %pickup_from; -- 26;

```

## Endpoint 26 — GET /api/v1/categories

```sql
SELECT
    c.id,
    c.name,
    NULLIF(c.image_1_url, '') AS image,
    NULLIF(c.category_banner_url, '') AS banner,
    COALESCE(c.product_count, 0) AS items,
    c.description
FROM product_ecomerce_categories c
WHERE c.parent_id IS NULL
  AND c.active IS TRUE
  AND ($1::int IS NULL OR c.id > $1::int)
ORDER BY c.id ASC
LIMIT LEAST(GREATEST(COALESCE($2::int, 10), 1), 100) + 1;
```


## Endpoint 27 — GET /api/v1/categories/{category_id:int}

```sql
SELECT
    c.id,
    c.name AS name,
    c.image_1_url AS image,
    c.product_count AS items,
    p.id AS parent_id,
    p.name AS parent_name,
    p.complete_name AS parent_complete_name,
    p.image_1_url AS parent_image
FROM product_ecomerce_categories c
LEFT JOIN product_ecomerce_categories p
    ON p.id = c.parent_id
WHERE c.id = %s -- catgoryid 1
  AND c.active IS TRUE;

-- get catagory with the catgory id 
-- "child_categories" : [{}]
SELECT
    child.id,
    child.name AS name,
    child.complete_name AS complete_name,
    child.image_1_url AS image,
    child.category_banner_url AS banner
FROM product_ecomerce_categories child
WHERE child.parent_id = 12 -- catgoryid 1
  AND child.active IS TRUE;
```


## Endpoint 28 — GET /api/v1/product/{product_tmpl_id:int}

```sql
-- EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
    pt.id,
    pt.name ->> 'en_US' AS name,
    CASE WHEN cat.id IS NOT NULL THEN JSONB_BUILD_OBJECT('id', cat.id, 'name', cat.name) ELSE NULL END AS product_category,
    COALESCE(pt.description_sale ->> 'en_US', '') AS product_description,
    NULLIF(pt.image_1920_url, '') AS product_image,
    COALESCE(videos.videos, '[]'::jsonb) AS video_urls,
    JSONB_BUILD_ARRAY(
        JSONB_BUILD_OBJECT('field', 'image_1', 'url', NULLIF(pt.image_1_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_2', 'url', NULLIF(pt.image_2_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_3', 'url', NULLIF(pt.image_3_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_4', 'url', NULLIF(pt.image_4_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_5', 'url', NULLIF(pt.image_5_url, '')),
        JSONB_BUILD_OBJECT('field', 'image_6', 'url', NULLIF(pt.image_6_url, ''))
    ) AS product_images,
    ROUND(pt.ecommerce_float_price::numeric, 2) AS list_price,
    CASE WHEN direct_discount.discount IS NOT NULL THEN direct_discount.discount ELSE COALESCE(loyalty_discount.discount, '[]'::jsonb) END AS discount,
    CASE WHEN direct_discount.discount IS NOT NULL THEN COALESCE(direct_discount.product_discounts, 0) ELSE COALESCE(loyalty_discount.product_discounts, 0) END AS product_discounts,
    COALESCE(pt.t_is_featured, FALSE) AS is_featured,
    COALESCE(pt.is_halal, FALSE) AS is_halal,
    COALESCE(pt.is_arrival, FALSE) AS is_arrival,
    COALESCE(variant_types.variant_type, '[]'::jsonb) AS variants_types,
    COALESCE(variants.total_variants, 0) AS total_variants,
    COALESCE(variants.variants, '[]'::jsonb) AS variants,
    COALESCE(specifications.specifications, '[]'::jsonb) AS specifications,
    JSONB_BUILD_OBJECT(
        'merchant', c.merchant,
        'name', c.name,
        'logo', NULLIF(c.logo_url, ''),
        'lat_location', c.lat_location,
        'lng_location', c.lng_location,
        'city', rp.city,
        'state', st.name
    ) AS merchant_info,
    NULLIF(pt.min_quantity, 0) AS min_quantity,
    NULLIF(pt.max_quantity, 0) AS max_quantity,
    reviews.average_rating,
    COALESCE(reviews.total_reviews, 0) AS total_reviews
FROM product_template pt
JOIN res_company c ON c.id = pt.company_id
LEFT JOIN res_partner rp ON rp.id = c.partner_id
LEFT JOIN res_country_state st ON st.id = rp.state_id
LEFT JOIN product_ecomerce_categories cat ON cat.id = pt.ecomerce_category_id
LEFT JOIN LATERAL (
    SELECT
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN pd.discount_type IS NOT NULL THEN INITCAP(pd.discount_type) ELSE NULL END,
                'discount_value', CASE
                    WHEN pd.discount_value IS NULL THEN NULL
                    WHEN pd.discount_value::numeric = TRUNC(pd.discount_value::numeric) THEN TRUNC(pd.discount_value::numeric)::text || '.0'
                    ELSE RTRIM(RTRIM(TO_CHAR(pd.discount_value::numeric, 'FM999999999999990.999999999999'), '0'), '.')
                END
            ) ORDER BY pd.id
        ) AS discount,
        TRUNC(
            SUM(
                GREATEST(
                    (pt.ecommerce_float_price::numeric / 1.15::numeric)
                    - CASE
                        WHEN pd.discount_type = 'percentage' THEN (pt.ecommerce_float_price::numeric / 1.15::numeric) * pd.discount_value::numeric / 100
                        ELSE pd.discount_value::numeric
                    END,
                    0::numeric
                ) + (pt.ecommerce_float_price::numeric - pt.ecommerce_float_price::numeric / 1.15::numeric)
            ),
            2
        ) AS product_discounts
    FROM product_discount pd
    WHERE pd.product_tmpl_id = pt.id
      AND pd.is_active = TRUE
      AND pd.x_superapp_approval_status = 'approved'
      AND (pd.start_date IS NULL OR pd.start_date <= CURRENT_DATE)
      AND (pd.end_date IS NULL OR pd.end_date >= CURRENT_DATE)
) direct_discount ON TRUE
LEFT JOIN LATERAL (
    SELECT
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'discount_type', CASE WHEN lr.discount_mode = 'percent' THEN 'Percentage' ELSE INITCAP(lr.discount_mode) END,
                'discount_value', CASE
                    WHEN lr.discount IS NULL THEN NULL
                    WHEN lr.discount::numeric = TRUNC(lr.discount::numeric) THEN TRUNC(lr.discount::numeric)::text || '.0'
                    ELSE RTRIM(RTRIM(TO_CHAR(lr.discount::numeric, 'FM999999999999990.999999999999'), '0'), '.')
                END
            ) ORDER BY lr.id
        ) AS discount,
        TRUNC(
            SUM(
                GREATEST(
                    (pt.ecommerce_float_price::numeric / 1.15::numeric)
                    - CASE
                        WHEN lr.discount_mode = 'percent' THEN (pt.ecommerce_float_price::numeric / 1.15::numeric) * lr.discount::numeric / 100
                        ELSE lr.discount::numeric
                    END,
                    0::numeric
                ) + (pt.ecommerce_float_price::numeric - pt.ecommerce_float_price::numeric / 1.15::numeric)
            ),
            2
        ) AS product_discounts
    FROM loyalty_reward lr
    JOIN loyalty_program lp ON lp.id = lr.program_id
    WHERE lp.id = (
        SELECT lp2.id
        FROM loyalty_program lp2
        WHERE lp2.company_id = pt.company_id
          AND lp2.program_type = 'promotion'
          AND lp2.is_ecommerce = TRUE
          AND lp2.x_superapp_approval_status = 'approved'
          AND (lp2.date_from IS NULL OR lp2.date_from <= CURRENT_DATE)
          AND (lp2.date_to IS NULL OR lp2.date_to >= CURRENT_DATE)
        ORDER BY lp2.sequence, lp2.id
        LIMIT 1
    )
) loyalty_discount ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS total_reviews, ROUND(AVG(pr.rating::numeric), 2) AS average_rating
    FROM product_review pr
    WHERE pr.product_template = pt.id
) reviews ON TRUE
LEFT JOIN LATERAL (
    SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT(
            'id', ep.id,
            'spec', es.name,
            'value', ep.value,
            'icon', NULLIF(es.icon_url, '')
        ) ORDER BY ep.id
    ) AS specifications
    FROM ecomerce_product ep
    JOIN ecomerce_specs es ON es.id = ep.spec
    WHERE ep.product_id = pt.id
) specifications ON TRUE
LEFT JOIN LATERAL (
    SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT(
            'id', a.attribute_id,
            'attribute', a.attribute_name,
            'values', a.values_json
        ) ORDER BY a.attribute_id
    ) AS variant_type
    FROM (
        SELECT
            pa.id AS attribute_id,
            pa.name ->> 'en_US' AS attribute_name,
            JSONB_AGG(
                JSONB_BUILD_OBJECT('id', pav.id, 'name', pav.name ->> 'en_US')
                ORDER BY pav.id
            ) AS values_json
        FROM product_template_attribute_line ptal
        JOIN product_attribute pa ON pa.id = ptal.attribute_id
        JOIN product_attribute_value_product_template_attribute_line_rel rel ON rel.product_template_attribute_line_id = ptal.id
        JOIN product_attribute_value pav ON pav.id = rel.product_attribute_value_id
        WHERE ptal.product_tmpl_id = pt.id
        GROUP BY pa.id, pa.name ->> 'en_US'
    ) a
) variant_types ON TRUE
LEFT JOIN LATERAL (
    SELECT
        COUNT(v.id)::int AS total_variants,
        JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', v.id,
                'name', COALESCE(vt.name ->> 'en_US', ''),
                'product_category', CASE WHEN cat_v.id IS NOT NULL THEN cat_v.name ELSE 'General' END,
                'product_description', COALESCE(vt.description_sale ->> 'en_US', ''),
                'list_price', v.ecommerce_float_price,
                'product_image', COALESCE(NULLIF(v.image_1920_url, ''), NULLIF(pt.image_1920_url, '')),
                'product_images', JSONB_BUILD_ARRAY(
                    JSONB_BUILD_OBJECT('field', 'image_1', 'url', COALESCE(NULLIF(v.image_1_url, ''), NULLIF(pt.image_1_url, ''))),
                    JSONB_BUILD_OBJECT('field', 'image_2', 'url', COALESCE(NULLIF(v.image_2_url, ''), NULLIF(pt.image_2_url, ''))),
                    JSONB_BUILD_OBJECT('field', 'image_3', 'url', COALESCE(NULLIF(v.image_3_url, ''), NULLIF(pt.image_3_url, ''))),
                    JSONB_BUILD_OBJECT('field', 'image_4', 'url', COALESCE(NULLIF(v.image_4_url, ''), NULLIF(pt.image_4_url, ''))),
                    JSONB_BUILD_OBJECT('field', 'image_5', 'url', COALESCE(NULLIF(v.image_5_url, ''), NULLIF(pt.image_5_url, ''))),
                    JSONB_BUILD_OBJECT('field', 'image_6', 'url', COALESCE(NULLIF(v.image_6_url, ''), NULLIF(pt.image_6_url, '')))
                ),
                'qty_available', COALESCE(v.api_qty_available, 0),
                'virtual_available', COALESCE(v.api_virtual_available, 0),
                'variants_types', COALESCE(attrs.attributes, '[]'::jsonb),
                'is_featured', COALESCE(v.v_is_featured, FALSE),
                'discount', CASE WHEN direct_discount.discount IS NOT NULL THEN direct_discount.discount ELSE COALESCE(loyalty_discount.discount, '[]'::jsonb) END,
                'product_discounts', CASE WHEN direct_discount.discount IS NOT NULL THEN COALESCE(direct_discount.product_discounts, 0) ELSE COALESCE(loyalty_discount.product_discounts, 0) END
            ) ORDER BY v.id
        ) AS variants
    FROM product_product v
    JOIN product_template vt ON vt.id = v.product_tmpl_id AND vt.x_superapp_approval_status = 'approved'
    LEFT JOIN product_ecomerce_categories cat_v ON cat_v.id = vt.ecomerce_category_id
    LEFT JOIN LATERAL (
        SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
                'id', pa.id,
                'attribute', pa.name ->> 'en_US',
                'value_id', pav.id,
                'value', pav.name ->> 'en_US'
            ) ORDER BY pa.id, pav.id
        ) AS attributes
        FROM product_variant_combination pvc
        JOIN product_template_attribute_value ptav ON ptav.id = pvc.product_template_attribute_value_id
        JOIN product_attribute_value pav ON pav.id = ptav.product_attribute_value_id
        JOIN product_attribute pa ON pa.id = pav.attribute_id
        WHERE pvc.product_product_id = v.id
    ) attrs ON TRUE
    WHERE v.product_tmpl_id = pt.id
      AND v.active = TRUE
    GROUP BY pt.id
) variants ON TRUE
LEFT JOIN LATERAL (
    SELECT JSONB_AGG(
        JSONB_BUILD_OBJECT(
            'video_url', pv.url,
            'thumbnail_url', NULLIF(pv.video_thumbnail_url, '')
        ) ORDER BY pv.id
    ) AS videos
    FROM product_video_url pv
    WHERE pv.product_tmpl_id = pt.id
      AND pv.url IS NOT NULL
      AND pv.url ILIKE '%m3u8%'
) videos ON TRUE
WHERE pt.id = %s --Productid
  AND pt.active = TRUE
  AND pt.is_for_ecommerce = TRUE
  AND pt.x_superapp_approval_status = 'approved'
  AND c.cps_enabled = TRUE
  AND COALESCE(c.is_delivery, FALSE) = FALSE
  AND c.active = TRUE
  AND NULLIF(TRIM(c.merchant), '') IS NOT NULL
  AND (
      c.parent_id IS NULL
      OR EXISTS (
          SELECT 1
          FROM res_company parent_c
          WHERE parent_c.id = c.parent_id
            AND parent_c.parent_id IS NULL
            AND parent_c.cps_enabled = TRUE
            AND COALESCE(parent_c.is_delivery, FALSE) = FALSE
            AND parent_c.active = TRUE
            AND NULLIF(TRIM(parent_c.merchant), '') IS NOT NULL
      )
  )
LIMIT 1; 
```

## Endpoint 29 — GET /api/v1/delivery/service_providers


```sql
SELECT
    c.id,
    c.name,
    c.logo_url AS logo
FROM res_company c
WHERE c.parent_id IS NULL
  AND c.is_delivery = TRUE
  AND c.cps_enabled = TRUE
  AND c.active = TRUE
  AND c.merchant IS NOT NULL;
```
