import "./globals.css";
import { Navbar } from "@/components/layout/Navbar.jsx";
import { ToastProvider } from "@/components/layout/ToastProvider.jsx";

export const metadata = {
  title: "Voting Platform",
  description: "Secure on-chain voting platform",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 antialiased">
        <Navbar />
        <main className="py-8">{children}</main>
        <ToastProvider />
      </body>
    </html>
  );
}
