import type { Metadata } from "next"
import { Outfit, Geist_Mono } from "next/font/google"
import "./globals.css"
import { cn } from "@/lib/utils"

const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

export const metadata: Metadata = {
  title: "Wishlist Service — SQL Query Reference",
  description:
    "Complete PostgreSQL query reference for the CBE Super App Wishlist microservice (Go + Odoo 17).",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("antialiased", outfit.variable, fontMono.variable, "font-sans")}
    >
      <body>{children}</body>
    </html>
  )
}
