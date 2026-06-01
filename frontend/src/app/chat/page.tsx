import { Suspense } from "react";
import ChatWorkspace from "@/components/chat/ChatWorkspace";

export default function ChatPage() {
  return (
    <Suspense>
      <ChatWorkspace />
    </Suspense>
  );
}
