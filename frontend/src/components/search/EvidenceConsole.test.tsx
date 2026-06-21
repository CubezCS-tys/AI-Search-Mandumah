import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidenceConsole } from "./EvidenceConsole";
import { synthesisEvidence } from "@/mocks/sse";
import type { EvidenceDoc } from "@/types/search";

const ev = synthesisEvidence as EvidenceDoc[];

describe("EvidenceConsole", () => {
  it("renders the consensus meter, signals, methodology table + honest framing", () => {
    render(<EvidenceConsole evidence={ev} />);
    expect(screen.getByText("ميزان التوافق")).toBeInTheDocument();
    expect(screen.getByText("الإشارات البحثية")).toBeInTheDocument();
    expect(screen.getByText("مقارنة المناهج")).toBeInTheDocument();
    expect(screen.getByText(/إشارات مُستخرَجة من/)).toBeInTheDocument();
  });

  it("surfaces a derived signal (contested finding)", () => {
    render(<EvidenceConsole evidence={ev} />);
    expect(screen.getByText("نتيجة متنازَع عليها")).toBeInTheDocument();
  });

  it("renders the empty state when there is no evidence", () => {
    render(<EvidenceConsole evidence={[]} />);
    expect(screen.getByText(/لا توجد أدلة مهيكلة/)).toBeInTheDocument();
  });
});
