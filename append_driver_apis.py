new_endpoints = """

## Endpoint 23 — GET /api/v1/driver/orders

**Driver Orders List**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS order_id,
    order_comp.logo_url AS logo,
    order_comp.name AS "from",

    json_build_object(
        'street', order_partner.street,
        'city', order_partner.city,
        'state', rcs.name
    ) AS pickup_location,

    json_build_object(
        'images',
        COALESCE(
            json_agg(
                DISTINCT
                icp.value
                || '/api/v1/image/product.template/'
                || pt.id
                || '/image_1920'
            ) FILTER (WHERE pt.id IS NOT NULL),
            '[]'::json
        ),
        'number',
        COUNT(pt.id)
    ) AS items,

    dop.delivery_date AS "date",
	dso.superapp_order_status AS status

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
CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token =  %s    --'760e9d74bdc5ed81107e62aa4f589c99'
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
    dop.delivery_date
LIMIT %s --10
OFFSET %s --0;
```


## Endpoint 24 — GET /api/v1/driver/order/{order_id:int}

**Driver Order Detail**

token: from request header `x-token`

```sql
SELECT
    dop.id,
    dop.name AS ref_no,
	dso.superapp_order_status AS status,
    order_comp.logo_url AS logo,
	COALESCE(order_partner.street, '') || ', ' || COALESCE(order_partner.city, '') || ' ' || COALESCE(rcs.name, '') AS pickup_from, 
    dop.delivery_date,
	dop.delivery_pickup_code,
	customer.name AS customer_info,
	json_build_object (
'lat',dop.delivery_lat,'lng',dop.delivery_long
	) AS coordinates,

dop.delivery_notes AS additional_note,
	json_agg(
json_build_object(
'id',pt.id,'name',pt.name->>'en_US','image',icp.value || '/api/v1/image/product.template/' || pt.id || '/image_1920',
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
LEFT JOIN res_partner customer ON dop.customer_id = customer.id
CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token = %s --'760e9d74bdc5ed81107e62aa4f589c99'
	AND ru.token_expiration_time > NOW()
AND dop.state IN ('driver', 'picked')
 AND dop.id = %s --4

GROUP BY
    dop.id,
    dop.name,
    order_comp.logo_url,
    order_comp.name,
    order_partner.street,
    order_partner.city,
	dso.superapp_order_status,
	customer.id,
    rcs.name,
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
	dop.delivery_date AS date,
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


CROSS JOIN ir_config_parameter icp

WHERE
    icp.key = 'image.base.url'
    AND ru.token = %s --'760e9d74bdc5ed81107e62aa4f589c99'
	AND ru.token_expiration_time > NOW()
AND dop.state IN ('delivered', 'canceled')

GROUP BY
    dop.id,
    dop.name,
    order_comp.name,
    order_partner.street

LIMIT %s --10
OFFSET %s --0;
```
"""

with open("QUERIES.md", "a") as f:
    f.write(new_endpoints)
