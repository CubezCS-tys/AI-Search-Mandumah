import type { Metadata } from "next";
import { Inter, Tajawal, Amiri, El_Messiri, Playfair_Display } from "next/font/google";
import "./globals.css";
import "./variants/editorial.css";
import "./variants/saas.css";
import "./variants/luxe.css";
import VariantSwitcher from "@/components/layout/VariantSwitcher";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const tajawal = Tajawal({
  variable: "--font-tajawal",
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "700", "800"],
  display: "swap",
});

/* Arabic serif (Naskh) — classic, journal-like headings. */
const amiri = Amiri({
  variable: "--font-amiri",
  subsets: ["arabic", "latin"],
  weight: ["400", "700"],
  display: "swap",
});

/* Elegant modern Arabic display face — refined yet contemporary. */
const elMessiri = El_Messiri({
  variable: "--font-elmessiri",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

/* Latin editorial serif for numerals/Latin headings. */
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "المنظومة — بحث أكاديمي ذكي",
  description: "محرك بحث أكاديمي هجين للمقالات العربية",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme + design variant before paint to avoid a flash
            of the wrong skin. Theme defaults to light; variant defaults to
            "editorial". Both are opt-in/persisted via the on-screen controls. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document.documentElement;if(localStorage.getItem("theme")==="dark")d.classList.add("dark");var v=localStorage.getItem("ui-variant")||"editorial";d.classList.add("variant-"+v);}catch(e){d.classList.add("variant-editorial");}})();`,
          }}
        />
      </head>
      <body
        className={`${inter.variable} ${tajawal.variable} ${amiri.variable} ${elMessiri.variable} ${playfair.variable} antialiased`}
      >
        {children}
        <VariantSwitcher />
      </body>
    </html>
  );
}
