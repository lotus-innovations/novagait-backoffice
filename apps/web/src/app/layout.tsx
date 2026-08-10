import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Novagait Back Office | Lotus Innovations demo",
  description:
    "Production-grade AP invoice agent demo: evals, audit trail, approval gates.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer>
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
