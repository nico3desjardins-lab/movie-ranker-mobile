import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Classement familial de films",
  description: "Prototype mobile-first pour classer des films en famille",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
