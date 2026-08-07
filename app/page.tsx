import React from "react"
import fs from "fs"
import path from "path"
import { CopyInit } from "@/components/copy-init"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
}

// ---------------------------------------------------------------------------
// SQL syntax highlighter — uses inline styles so colour survives any CSS
// ---------------------------------------------------------------------------
function highlightSql(escaped: string): string {
  return escaped
    // Multi-word keywords (violet)
    .replace(
      /\b(ORDER\s+BY|GROUP\s+BY|LEFT\s+JOIN|INNER\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|STRING_AGG|JSON_AGG|JSON_BUILD_OBJECT|TO_CHAR|NULLIF|INITCAP|REGEXP_REPLACE|CURRENT_DATE|CURRENT_TIMESTAMP)\b/gi,
      '<span style="color:#a78bfa;font-weight:600">$1</span>'
    )
    // Single-word SQL keywords (blue)
    .replace(
      /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|AS|LIMIT|OFFSET|HAVING|CASE|WHEN|THEN|ELSE|END|COUNT|SUM|AVG|ROUND|COALESCE|CONCAT|EXISTS|DISTINCT|TRUE|FALSE|NULL|IS|INTO|VALUES|WITH|UNION|ASC|DESC|BY)\b/gi,
      '<span style="color:#60a5fa;font-weight:600">$1</span>'
    )
    // String literals (emerald)
    .replace(/('(?:[^'\\]|\\.)*')/g, '<span style="color:#34d399">$1</span>')
    // Line comments (muted italic)
    .replace(/(--[^\n]*)/g, '<span style="color:#6b7280;font-style:italic">$1</span>')
    // Parameters $1 $2 (amber bold)
    .replace(/(\$\d+)/g, '<span style="color:#fbbf24;font-weight:700">$1</span>')
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------
function renderTable(block: string): string {
  const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return block

  const parseRow = (line: string) =>
    line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim())

  const headers = parseRow(lines[0])
  const rows = lines.slice(2).map(parseRow)

  const thCells = headers.map(h =>
    `<th style="padding:10px 16px;text-align:left;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;white-space:nowrap;color:#71717a;border-bottom:1px solid rgba(0,0,0,0.08)">${h}</th>`
  ).join("")

  const trRows = rows.map((cells, ri) =>
    `<tr style="background:${ri % 2 !== 0 ? "rgba(0,0,0,0.02)" : "transparent"}">
      ${cells.map((c, ci) =>
        `<td style="padding:9px 16px;font-size:13px;border-top:1px solid rgba(0,0,0,0.06);${ci === 0 ? "font-family:ui-monospace,monospace;font-weight:500;color:#6d28d9" : "color:#52525b"}">${c}</td>`
      ).join("")}
    </tr>`
  ).join("")

  return `<div style="margin:28px 0;overflow-x:auto;border-radius:10px;border:1px solid rgba(0,0,0,0.1);box-shadow:0 1px 3px rgba(0,0,0,0.06)">
  <table style="width:100%;border-collapse:collapse">
    <thead style="background:rgba(0,0,0,0.025)"><tr>${thCells}</tr></thead>
    <tbody>${trRows}</tbody>
  </table>
</div>`
}

// ---------------------------------------------------------------------------
// Render one code block → HTML string
// Also returns the raw code to store in the copy map
// ---------------------------------------------------------------------------
function renderCodeBlock(lang: string, code: string, copyId: string): string {
  const escaped = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  const isSql = !lang || lang === "sql"
  const highlighted = isSql ? highlightSql(escaped) : escaped
  const langLabel = (lang || "sql").toUpperCase()

  // Copy button — no inline event handlers (React strips them).
  // Hover is handled by CopyInit via JS event listeners.
  const copyBtn = `<button
    data-copy-id="${copyId}"
    title="Copy to clipboard"
    style="display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:#9ca3af;font-size:11px;font-weight:500;cursor:pointer"
  >
    <span data-copy-state="idle" style="display:flex;align-items:center;gap:5px">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      Copy
    </span>
    <span data-copy-state="check" style="display:none;align-items:center;gap:5px;color:#4ade80">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied!
    </span>
  </button>`

  return `<div style="margin:28px 0;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);box-shadow:0 4px 24px rgba(0,0,0,0.4)">
  <div style="background:#1a1a2e;border-bottom:1px solid rgba(255,255,255,0.07);padding:8px 16px;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:#ff5f57;display:inline-block;flex-shrink:0"></span>
      <span style="width:10px;height:10px;border-radius:50%;background:#febc2e;display:inline-block;flex-shrink:0"></span>
      <span style="width:10px;height:10px;border-radius:50%;background:#28c840;display:inline-block;flex-shrink:0"></span>
      <span style="font-size:10px;font-weight:700;letter-spacing:.14em;color:#6b7280;margin-left:4px">${langLabel}</span>
    </div>
    ${copyBtn}
  </div>
  <pre style="margin:0;padding:20px 24px;overflow-x:auto;font-size:13px;line-height:1.85;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#d4d4d8;background:#0f0f1a"><code>${highlighted}</code></pre>
</div>`
}

// ---------------------------------------------------------------------------
// Main markdown → HTML
// Uses a placeholder strategy: extract code blocks first, process everything
// else, then substitute rendered blocks back in. Prevents any double-processing.
// ---------------------------------------------------------------------------
function mdToHtml(md: string): { html: string; copyMap: Record<string, string> } {
  const copyMap: Record<string, string> = {}
  const codeBlocks: string[] = []

  // Step 1 — extract all fenced code blocks → placeholders
  let html = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const id = `cb${codeBlocks.length}`
    copyMap[id] = code.replace(/\n$/, "") // raw text for clipboard
    codeBlocks.push(renderCodeBlock(lang, code, id))
    return `\x00CODE_${codeBlocks.length - 1}\x00`
  })

  // Step 2 — tables
  html = html.replace(/((?:^\|.+\|\s*\n?)+)/gm, (block) => {
    const lines = block.trim().split("\n").map(l => l.trim())
    if (lines.length >= 2 && /^\|[-| :]+\|/.test(lines[1])) return renderTable(block)
    return block
  })

  // Step 3 — inline code
  html = html.replace(/`([^`\n]+)`/g,
    '<code style="padding:2px 6px;border-radius:5px;background:rgba(109,40,217,0.1);color:#7c3aed;font-family:ui-monospace,monospace;font-size:12.5px;border:1px solid rgba(109,40,217,0.15)">$1</code>'
  )

  // Step 4 — headings (### before ## before #)
  html = html.replace(/^### (.+)$/gm, (_, t) => {
    const id = slugify(t)
    const numMatch = t.match(/^(\d+\.\d+)\s+(.+)/)
    if (numMatch) {
      return `<h3 id="${id}" style="margin:36px 0 12px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;scroll-margin-top:112px">
        <span style="display:inline-flex;align-items:center;justify-content:center;min-width:36px;padding:0 6px;height:20px;border-radius:5px;background:rgba(109,40,217,0.12);color:#7c3aed;font-size:10.5px;font-weight:800;font-family:ui-monospace,monospace;border:1px solid rgba(109,40,217,0.18);flex-shrink:0">${numMatch[1]}</span>
        <span style="color:#27272a">${numMatch[2]}</span>
      </h3>`
    }
    return `<h3 id="${id}" style="margin:36px 0 12px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;color:#27272a;scroll-margin-top:112px">
      <span style="display:block;width:20px;height:1px;background:rgba(109,40,217,0.35);flex-shrink:0"></span>
      ${t}
    </h3>`
  })

  html = html.replace(/^## (.+)$/gm, (_, t) => {
    const id = slugify(t)
    const epMatch = t.match(/^Endpoint\s+(\w+)\s+[—–-]\s+(.+)$/)
    if (epMatch) {
      return `<div id="${id}" style="margin-top:56px;margin-bottom:20px;scroll-margin-top:112px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px">
          <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;background:#dcfce7;border:1px solid #bbf7d0;font-size:11px;font-weight:700;color:#15803d;letter-spacing:.05em">
            <span style="width:6px;height:6px;border-radius:50%;background:#16a34a;flex-shrink:0"></span>GET
          </span>
          <code style="font-size:13px;font-family:ui-monospace,monospace;font-weight:600;color:#3f3f46;background:#f4f4f5;padding:3px 10px;border-radius:6px;border:1px solid #e4e4e7">${epMatch[2]}</code>
          <span style="font-size:11px;font-weight:600;color:#a1a1aa;background:#f4f4f5;padding:2px 8px;border-radius:20px;border:1px solid #e4e4e7">EP ${epMatch[1]}</span>
        </div>
        <div style="height:1px;background:linear-gradient(to right,rgba(109,40,217,0.25),rgba(228,228,231,0.4),transparent)"></div>
      </div>`
    }
    return `<h2 id="${id}" style="margin-top:52px;margin-bottom:20px;font-size:22px;font-weight:800;color:#18181b;padding-bottom:12px;border-bottom:1px solid #e4e4e7;scroll-margin-top:112px">${t}</h2>`
  })

  html = html.replace(/^# (.+)$/gm, (_, t) => {
    const id = slugify(t)
    return `<h1 id="${id}" style="font-size:32px;font-weight:900;letter-spacing:-0.03em;margin-bottom:12px;scroll-margin-top:112px;background:linear-gradient(135deg,#6d28d9,#8b5cf6,#4f46e5);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${t}</h1>`
  })

  // Step 5 — bold
  html = html.replace(/\*\*(.+?)\*\*/g,
    '<strong style="font-weight:700;color:#18181b">$1</strong>'
  )

  // Step 6 — horizontal rules → thin gradient line
  html = html.replace(/^---$/gm,
    '<div style="margin:36px 0;height:1px;background:linear-gradient(to right,transparent,rgba(228,228,231,0.8),transparent)"></div>'
  )

  // Step 7 — lists
  html = html.replace(/^  - (.+)$/gm,
    '<li style="margin-left:32px;list-style-type:circle;margin-top:4px;margin-bottom:4px;font-size:14.5px;color:#52525b">$1</li>'
  )
  html = html.replace(/^- (.+)$/gm,
    '<li style="margin-left:20px;list-style-type:disc;margin-top:6px;margin-bottom:6px;font-size:15px;color:#3f3f46">$1</li>'
  )

  // Step 8 — paragraphs (only plain text lines, not starting with markup)
  html = html.replace(/^([^<\n#\-|].*)$/gm, (line) => {
    if (!line.trim()) return ""
    if (/^\x00CODE_/.test(line)) return line
    if (/^</.test(line)) return line
    return `<p style="margin:14px 0;font-size:15px;line-height:1.7;color:#52525b;font-weight:300">${line}</p>`
  })

  // Step 9 — substitute code block placeholders back
  html = html.replace(/\x00CODE_(\d+)\x00/g, (_, i) => codeBlocks[Number(i)] ?? "")

  return { html, copyMap }
}

// ---------------------------------------------------------------------------
// Navigation — IDs match slugify() output on QUERIES.md ## headings exactly
// ---------------------------------------------------------------------------
type NavItem =
  | { kind: "link"; id: string; label: string }
  | { kind: "section"; label: string }

const NAV: NavItem[] = [
  // { kind: "link",    id: "authentication",                                          label: "Authentication"        },
  { kind: "section", label: "API Endpoints"                                                                        },
  { kind: "link",    id: "endpoint-1-get-apiv1orders",                              label: "1. List Orders"        },
  { kind: "link",    id: "endpoint-2-get-apiv1merchantordersorder_idstatus",        label: "2. Order Status"       },
  { kind: "link",    id: "endpoint-3-get-apiv1productproduct_idreviews",            label: "3. Product Reviews"    },
  { kind: "link",    id: "endpoint-4-get-apiv1driverhistory",                       label: "4. Driver History"     },
  { kind: "link",    id: "endpoint-5-get-apiv1productpurchase_status",              label: "5. Purchase Status"    },
  { kind: "link",    id: "endpoint-6-get-apiv1orderslist",                          label: "6. Orders List"        },
  { kind: "link",    id: "endpoint-7-get-apiv1categoryads",                         label: "7. Category Ads"       },
  { kind: "link",    id: "endpoint-8-get-apiv1populars",                            label: "8. Popular Merchants"  },
  { kind: "link",    id: "endpoint-9-get-apiv1popular_categories",                  label: "9. Popular Categories" },
  { kind: "link",    id: "endpoint-10-get-apiv1popular_categoriesmerchant_idstring",label: "10. Merch Categories"  },
  { kind: "link",    id: "endpoint-11-get-apiv1popular_products",                   label: "11. Popular Products"  },
  { kind: "link",    id: "endpoint-12-get-apiv1merchantstringpopular_merchant_products", label: "12. Merch Products"},
  { kind: "link",    id: "endpoint-13-get-apiv1merchantstringpopular_merchant_productscategorycategory_idint", label: "13. Merch Cat Prods"},
  { kind: "link",    id: "endpoint-14-get-apiv1popular_categories",                 label: "14. Popular Categories"},
  { kind: "link",    id: "endpoint-15-get-apiv1popular_categoriesmerchant_idstring",label: "15. Merch Categories"  },
  { kind: "link",    id: "endpoint-16-get-apiv1searchquerystring",                  label: "16. Search Merchant"   },
  { kind: "link",    id: "endpoint-17-get-apiv1searchallquerystring",               label: "17. Search All"        },
  { kind: "link",    id: "endpoint-18-get-apiv1productssearchquerystring",          label: "18. Product Search"    },
  { kind: "link",    id: "endpoint-19-get-apiv1categoriessearchqueryquerystring",   label: "19. Category Search"   },
]

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function DocsPage() {
  // 1. Explicit override (any environment)
  // 2. Bundled copy inside the project (production build — copied by prebuild script)
  // 3. Relative sibling path (local monorepo dev)
  const mdPath =
    process.env.QUERIES_MD_PATH ??
    (() => {
      const bundled = path.resolve(process.cwd(), "QUERIES.md")
      if (require("fs").existsSync(bundled)) return bundled
      return path.resolve(process.cwd(), /*turbopackIgnore: true*/ "../../wishlist-service/QUERIES.md")
    })()

  let raw = ""
  try {
    raw = fs.readFileSync(mdPath, "utf-8")
  } catch {
    raw = `# Error loading QUERIES.md\n\nFile not found at: \`${mdPath}\`\n\nIn deployment, run \`npm run build\` from inside \`doc/sql-doc\` (the prebuild script copies QUERIES.md automatically). Or set the \`QUERIES_MD_PATH\` environment variable to the absolute path of QUERIES.md.`
  }

  const { html, copyMap } = mdToHtml(raw)

  return (
    <div className="min-h-screen bg-zinc-50 font-sans overflow-x-hidden">

      {/* Copy data store */}
      <script
        id="__copy_map__"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(copyMap) }}
      />
      <CopyInit />

      {/* Ambient background */}
      <div className="fixed inset-0 -z-10 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full bg-primary/[0.06] blur-[120px]" />
        <div className="absolute top-1/2 -right-40 w-[400px] h-[400px] rounded-full bg-purple-500/[0.04] blur-[130px]" />
      </div>

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-zinc-200/70 bg-white/90 backdrop-blur-xl shadow-sm">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2">
            <p className="font-bold text-[15px] tracking-tight text-zinc-900">Documentation</p>
            <span className="text-zinc-300 mx-1">/</span>
            <p className="text-[13px] font-medium text-zinc-400">SQL Reference</p>
          </div>
          {/* <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200/60 text-[11px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            PostgreSQL · Odoo 18
          </span> */}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="mx-auto max-w-screen-2xl px-6 py-10 lg:py-14">
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-8 items-start">

          {/* ── Sidebar ── */}
          <aside className="sticky top-20 hidden lg:flex flex-col gap-3 max-h-[calc(100vh-5rem)] overflow-y-auto pr-1">
            <nav className="rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm">
              <p className="mb-3 px-2 text-[9.5px] font-bold uppercase tracking-widest text-zinc-400 flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                On this page
              </p>
              <div className="flex flex-col gap-px">
                {NAV.map((item, i) =>
                  item.kind === "section" ? (
                    <div key={i} className="pt-3 pb-1 px-2">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-400">{item.label}</span>
                    </div>
                  ) : (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      className="group flex items-center gap-2 px-2.5 py-[6px] rounded-lg text-[12px] font-medium text-zinc-500 hover:text-primary hover:bg-primary/[0.06] transition-all duration-150"
                    >
                      <span className="w-1 h-1 rounded-full bg-zinc-300 group-hover:bg-primary group-hover:scale-[1.8] transition-all shrink-0" />
                      <span className="truncate leading-none">{item.label}</span>
                    </a>
                  )
                )}
              </div>
            </nav>

            {/* <div className="rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-sm">
              <p className="text-[9.5px] font-bold uppercase tracking-widest text-zinc-400 mb-3">Database</p>
              <div className="space-y-2">
                {[
                  { k: "host", v: "localhost:2415" },
                  { k: "db",   v: "ecommers"       },
                  { k: "user", v: "odoo"            },
                ].map(({ k, v }) => (
                  <div key={k} className="flex items-center justify-between text-[11.5px]">
                    <span className="font-mono text-primary/70">{k}</span>
                    <span className="font-mono text-zinc-600">{v}</span>
                  </div>
                ))}
              </div>
            </div> */}
          </aside>

          {/* ── Content ── */}
          <main className="min-w-0">
            <article
              className="prose prose-zinc max-w-none prose-headings:scroll-mt-28 prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:before:content-none prose-code:after:content-none"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </main>

        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="border-t border-zinc-200/70 bg-white/60 backdrop-blur-md py-6 mt-10">
        <div className="mx-auto max-w-screen-2xl px-6 flex items-center justify-between gap-3">
          <span className="text-[11.5px] font-medium text-zinc-400">CBE Super App · Wishlist Service</span>
          <span className="text-[11px] text-zinc-400">&copy; {new Date().getFullYear()}</span>
        </div>
      </footer>
    </div>
  )
}
