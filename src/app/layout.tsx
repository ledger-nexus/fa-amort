import "./globals.css";
import type { Metadata } from "next";
import { Sidebar } from "@/components/nav/sidebar";

export const metadata: Metadata = {
  title: "fa-amort — fixed assets",
  description:
    "Fixed-asset & amortization engine for the ledger-nexus portfolio. Generates depreciation schedules and posts month-end JEs via the ledger-core HTTP bridge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
