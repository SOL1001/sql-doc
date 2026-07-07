"use client"

import { useEffect } from "react"

// Reads copy text from the __COPY_MAP__ script tag injected by the server renderer,
// then wires click handlers on all [data-copy-id] buttons.
export function CopyInit() {
  useEffect(() => {
    // Parse the copy map injected by the server
    const mapEl = document.getElementById("__copy_map__")
    const copyMap: Record<string, string> = mapEl ? JSON.parse(mapEl.textContent ?? "{}") : {}

    function handleClick(e: MouseEvent) {
      const btn = (e.target as Element).closest("[data-copy-id]") as HTMLElement | null
      if (!btn) return
      const id = btn.dataset.copyId ?? ""
      const text = copyMap[id] ?? ""
      if (!text) return

      navigator.clipboard.writeText(text).then(() => {
        const icons = btn.querySelectorAll<HTMLElement>("[data-copy-state]")
        icons.forEach(el => {
          el.style.display = el.dataset.copyState === "check" ? "flex" : "none"
        })
        setTimeout(() => {
          icons.forEach(el => {
            el.style.display = el.dataset.copyState === "idle" ? "flex" : "none"
          })
        }, 2000)
      })
    }

    document.addEventListener("click", handleClick)

    // Hover effect via JS (React strips onmouseover from dangerouslySetInnerHTML)
    document.querySelectorAll<HTMLElement>("[data-copy-id]").forEach(btn => {
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255,255,255,0.12)"
        btn.style.borderColor = "rgba(255,255,255,0.2)"
        btn.style.color = "#f4f4f5"
      })
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "rgba(255,255,255,0.06)"
        btn.style.borderColor = "rgba(255,255,255,0.1)"
        btn.style.color = "#9ca3af"
      })
    })

    return () => document.removeEventListener("click", handleClick)
  }, [])

  return null
}
