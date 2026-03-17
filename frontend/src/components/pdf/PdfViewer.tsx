"use client";

import { Download } from "lucide-react";

interface PdfViewerProps {
  url: string;
  highlightTerms?: string[];
}

export default function PdfViewer({ url, highlightTerms = [] }: PdfViewerProps) {
  // Use first search term for browser's built-in PDF find & highlight
  // Chrome/Edge highlight via #search=, needs toolbar visible
  const searchTerm = highlightTerms.filter((t) => t.length > 1)[0] || "";
  const iframeSrc = searchTerm
    ? `${url}#search=${encodeURIComponent(searchTerm)}&phrase=true`
    : url;

  return (
    <div className="flex flex-col">
      {/* Minimal toolbar */}
      <div className="sticky top-[100px] z-20 mb-3 flex items-center justify-between rounded-xl border border-border-subtle bg-bg-elevated px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          {searchTerm && (
            <span className="font-arabic text-[12px] text-accent">
              يتم تمييز: <span className="font-medium">{searchTerm}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <a
            href={url}
            download
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
            title="تحميل PDF"
          >
            <Download size={15} />
          </a>
        </div>
      </div>

      {/* Native PDF viewer — toolbar visible for search highlighting */}
      <div className="overflow-hidden rounded-xl border border-border-subtle shadow-sm">
        <iframe
          src={iframeSrc}
          className="w-full bg-[#525659]"
          style={{ height: "calc(100vh - 160px)", border: "none" }}
          title="PDF Viewer"
        />
      </div>
    </div>
  );
}
