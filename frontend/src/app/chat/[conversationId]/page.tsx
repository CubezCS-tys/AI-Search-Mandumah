import { Suspense } from "react";
import ChatWorkspace from "@/components/chat/ChatWorkspace";

export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return (
    <Suspense>
      <ChatWorkspace initialConversationId={conversationId} />
    </Suspense>
  );
}
