"use client";

import { use, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Header from "@/components/layout/Header";
import DocumentViewer from "@/components/document/DocumentViewer";

function DocumentContent({ docId }: { docId: string }) {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";

  return (
    <div className="min-h-svh bg-white">
      <Header compact />
      <DocumentViewer docId={docId} query={query} />
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
