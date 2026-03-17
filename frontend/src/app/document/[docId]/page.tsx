"use client";

import { use, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import Header from "@/components/layout/Header";
import DocumentViewer from "@/components/document/DocumentViewer";

function DocumentContent({ docId }: { docId: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const query = searchParams.get("q") || "";

  return (
    <div className="min-h-svh bg-bg-primary">
      <Header compact />

      {/* Toolbar */}
      <div className="sticky top-[53px] z-30 border-b border-border-subtle bg-bg-primary/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-2.5">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-border-subtle hover:text-text-primary"
          >
            <ArrowRight size={16} />
            <span className="font-arabic">العودة للنتائج</span>
          </button>
          <div className="h-4 w-px bg-border-subtle" />
          <span className="text-[12px] text-text-muted" dir="ltr">
            {docId}
          </span>
          {query && (
            <>
              <div className="h-4 w-px bg-border-subtle" />
              <span className="font-arabic text-[12px] text-text-muted">
                بحث: <span className="text-accent font-medium">{query}</span>
              </span>
            </>
          )}
        </div>
      </div>

      {/* Document viewer */}
      <main className="mx-auto max-w-5xl px-5 pb-10">
        <DocumentViewer docId={docId} query={query} />
      </main>
    </div>
  );
}

export default function DocumentPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);

  return (
    <Suspense>
      <DocumentContent docId={docId} />
    </Suspense>
  );
}
