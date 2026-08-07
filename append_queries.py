import re

def fix_time_logic(sql_text):
    # The buggy logic in query 3 uses ROUND(((COALESCE(field, 0) - FLOOR(COALESCE(field, 0))) * 60)::numeric)::int::text
    # We want to replace it with LEAST(FLOOR(((field - FLOOR(field)) * 60)::numeric), 59)
    # The exact buggy patterns are:
    # LPAD(ROUND(((COALESCE(b.open_hour, 0) - FLOOR(COALESCE(b.open_hour, 0))) * 60)::numeric)::int::text, 2, '0')
    # Let's just do a regex replace for the ROUND parts.
    
    # Replace open_hour rounding
    sql_text = re.sub(
        r"ROUND\(\(\(COALESCE\(([^,]+),\s*0\) - FLOOR\(COALESCE\(\1,\s*0\)\)\)\s*\*\s*60\)::numeric\)",
        r"LEAST(FLOOR(((COALESCE(\1, 0) - FLOOR(COALESCE(\1, 0))) * 60)::numeric), 59)",
        sql_text
    )
    return sql_text

with open("done", "r") as f:
    done_content = f.read()

# Split by the separator lines
# Query 1 ends around line 650
# Query 2 starts around 653
# Query 3 starts around 897

sections = re.split(r"-{10,}\n-{2,}\n", done_content)
# sections might be tricky. Let's find specific markers.

q1_start = done_content.find("WITH merchant_status_check AS")
q1_end = done_content.find("-------------------------------------------------------------------------------", q1_start)
q1_sql = done_content[q1_start:q1_end].strip()

q2_start = done_content.find("WITH params AS (", q1_end)
q2_end = done_content.find("----------------------------------------------------------------", q2_start)
q2_sql = done_content[q2_start:q2_end].strip()

q3_start = done_content.find("WITH params AS (", q2_end)
q3_end = len(done_content)
q3_sql = done_content[q3_start:q3_end].strip()

# Fix Q3 time logic
q3_sql = fix_time_logic(q3_sql)

markdown_to_append = f"""

## Endpoint 20 — GET /api/v1/total_products

```sql
{q1_sql}
```

## Endpoint 21 — GET /api/v1/merchants/list_all

```sql
{q2_sql}
```

## Endpoint 22 — GET /api/v1/merchant/{{merchant}}

```sql
{q3_sql}
```
"""

with open("QUERIES.md", "a") as f:
    f.write(markdown_to_append)
