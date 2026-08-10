import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Novagait Back Office | Lotus Innovations demo",
  description:
    "Production-grade AP invoice agent demo: evals, audit trail, approval gates.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <span className="brand">Novagait Back Office</span>
          <nav aria-label="Main">
            <a href="/">Home</a>
            <a href="/runs">Runs</a>
          </nav>
        </header>
        {children}
        <footer className="site">
          <p>
            Demonstration project by Lotus Innovations. &quot;Novagait&quot; is
            a fictional brand; all data is synthetic. Not affiliated with any
            real clinic or entity.
          </p>
        </footer>
      </body>
    </html>
  );
}
