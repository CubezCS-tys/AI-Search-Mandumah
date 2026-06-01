"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Plus,
  MessageSquare,
  Trash2,
  Pencil,
  Check,
  X,
  Search as SearchIcon,
  PanelLeftClose,
} from "lucide-react";
import type { ConversationSummary } from "@/types/chat";

interface ChatSidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;
}

export default function ChatSidebar({
  conversations,
  activeId,
  loading,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [filter, setFilter] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  const startEdit = (c: ConversationSummary) => {
    setEditingId(c.id);
    setDraftTitle(c.title);
  };

  const commitEdit = () => {
    if (editingId && draftTitle.trim()) {
      onRename(editingId, draftTitle.trim());
    }
    setEditingId(null);
  };

  const showFilter = conversations.length > 5;

  const filteredConversations = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      (c.title || "محادثة").toLowerCase().includes(q),
    );
  }, [conversations, filter]);

  return (
    <aside className="flex h-full w-full flex-col bg-bg-secondary">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3">
        <Link href="/" className="flex items-center gap-1.5">
          <Image
            src="/logo_ar.svg"
            alt="المنظومة"
            width={90}
            height={46}
            className="h-6 w-auto"
            priority
          />
        </Link>
        <div className="flex items-center gap-1">
          <Link
            href="/search"
            title="بحث"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-primary hover:text-text-primary"
          >
            <SearchIcon size={16} />
          </Link>
          {onClose && (
            <button
              onClick={onClose}
              title="إخفاء"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition hover:bg-bg-primary hover:text-text-primary lg:hidden"
            >
              <PanelLeftClose size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable region with a sticky action header */}
      <div className="flex-1 overflow-y-auto">
        {/* Sticky: new chat + conversations header + filter */}
        <div className="sticky top-0 z-10 bg-bg-secondary px-3 pb-2 pt-1">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-xl border border-border bg-bg-elevated px-3 py-2.5 font-arabic text-[13.5px] font-medium text-text-primary transition hover:border-accent/40 hover:bg-accent-subtle"
          >
            <Plus size={16} className="text-accent" />
            محادثة جديدة
          </button>

          <div className="mt-3 flex items-center gap-2 px-1">
            <span className="font-arabic text-[12px] font-semibold text-text-muted">
              المحادثات
            </span>
            {conversations.length > 0 && (
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-bg-elevated px-1.5 font-arabic text-[11px] font-medium text-text-secondary">
                {conversations.length}
              </span>
            )}
          </div>

          {showFilter && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-border bg-bg-primary px-2.5 py-1.5">
              <SearchIcon size={13} className="shrink-0 text-text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                dir="rtl"
                placeholder="ابحث في المحادثات"
                className="min-w-0 flex-1 bg-transparent font-arabic text-[12.5px] text-text-primary outline-none placeholder:text-text-muted"
              />
              {filter && (
                <button
                  onClick={() => setFilter("")}
                  aria-label="مسح"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:text-text-primary"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* List */}
        <nav className="px-2 py-1">
          {loading ? (
            <div className="space-y-1.5 px-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton h-9 rounded-lg" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-elevated">
                <MessageSquare size={18} className="text-text-muted" />
              </div>
              <p className="font-arabic text-[12.5px] font-medium text-text-secondary">
                لا توجد محادثات بعد
              </p>
              <p className="font-arabic text-[11.5px] leading-relaxed text-text-muted">
                ابدأ محادثة جديدة لطرح أسئلتك على مجموعة المقالات.
              </p>
            </div>
          ) : filteredConversations.length === 0 ? (
            <p className="px-3 py-6 text-center font-arabic text-[12.5px] text-text-muted">
              لا توجد نتائج مطابقة
            </p>
          ) : (
            <ul className="space-y-0.5">
              {filteredConversations.map((c) => {
                const active = c.id === activeId;
                const editing = editingId === c.id;
                return (
                  <li key={c.id} className="group relative">
                    {editing ? (
                      <div className="flex items-center gap-1 rounded-lg bg-bg-primary px-2 py-1.5">
                        <input
                          ref={editInputRef}
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          dir="rtl"
                          className="min-w-0 flex-1 bg-transparent font-arabic text-[13px] text-text-primary outline-none"
                        />
                        <button
                          onClick={commitEdit}
                          className="flex h-6 w-6 items-center justify-center rounded text-accent hover:bg-bg-elevated"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:bg-bg-elevated"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => onSelect(c.id)}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-right transition ${
                          active
                            ? "bg-accent-subtle text-accent"
                            : "text-text-secondary hover:bg-bg-primary"
                        }`}
                      >
                        <MessageSquare
                          size={14}
                          className={active ? "text-accent" : "text-text-muted"}
                        />
                        <span className="min-w-0 flex-1 truncate font-arabic text-[13px]">
                          {c.title || "محادثة"}
                        </span>
                      </button>
                    )}

                    {!editing && (
                      <div className="absolute inset-y-0 left-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(c);
                          }}
                          title="إعادة تسمية"
                          className="flex h-6 w-6 items-center justify-center rounded bg-bg-secondary/90 text-text-muted hover:text-text-primary"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(c.id);
                          }}
                          title="حذف"
                          className="flex h-6 w-6 items-center justify-center rounded bg-bg-secondary/90 text-text-muted hover:text-red-600"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>
    </aside>
  );
}
