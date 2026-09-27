export default function ResultSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-border-subtle bg-bg-elevated p-5"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          {/* Badge + title */}
          <div className="mb-3 flex items-start gap-3">
            <div className="skeleton h-6 w-16 rounded-lg" />
            <div className="skeleton h-5 flex-1 rounded-md" />
          </div>

          {/* Text lines */}
          <div className="mb-4 space-y-2">
            <div className="skeleton h-4 w-full rounded-md" />
            <div className="skeleton h-4 w-11/12 rounded-md" />
            <div className="skeleton h-4 w-3/4 rounded-md" />
          </div>

          {/* Score bar */}
          <div className="mb-3">
            <div className="skeleton h-1.5 w-full rounded-full" />
          </div>

          {/* Meta row */}
          <div className="flex gap-4">
            <div className="skeleton h-3 w-28 rounded-md" />
            <div className="skeleton h-3 w-16 rounded-md" />
            <div className="skeleton h-3 w-20 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
