"use client";

import { MotionConfig, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

// Wraps the app so framer-motion transform/layout animations auto-disable when
// the user prefers reduced motion (opacity/colour still animate, per Motion's
// accessibility guidance). Raw CSS @keyframes animations are handled separately
// by the reduced-motion net in globals.css.
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export { useReducedMotion };
