# Roadmap

Prioritized backlog. Top of each section = do first. Check items off as done.
See `.github/copilot-instructions.md` for the autonomy + verification contract.

## Pass 3 — UX depth (next up)

- [x] **Search ↔ Chat handoffs**: "اسأل في المحادثة" button on search results that opens Chat seeded with the query + selected results; and a "ابحث عن هذا" action from a chat answer.
- [ ] **Faceted filters on search**: journal and section facets with result counts, driven by the existing filter params.
- [ ] **Mobile responsive**: chat sidebar collapses to a drawer; document split-view stacks; composer and result cards adapt to small screens.
- [ ] **In-PDF find**: a find-in-document box in `DocumentViewer` reusing the OCR word index + existing highlight overlay.
- [ ] **Conversation management**: rename inline + delete confirmation in `ChatSidebar` (wire to existing PATCH/DELETE routes), plus "تصدير المحادثة" (export as markdown).

## Pass 4 — Retrieval quality

- [ ] Show which retrieved chunks were actually cited vs. merely retrieved.
- [ ] Per-answer "regenerate" and "more sources" controls in chat.
- [ ] Query suggestions / "هل تقصد" when results are low-confidence.
- [ ] Streaming partial sources (show sources as soon as retrieval finishes, before the answer completes).

## Pass 5 — Production & multi-user

- [ ] Per-user session/cookie scoping for conversation history (see deferred work).
- [ ] Rate limiting + request size guards on chat/synthesis endpoints.
- [ ] Health/readiness endpoints surfaced in the UI; graceful degraded states.
- [ ] Deployment: ensure rsync excludes `storage/conversations.db*`.

## Icebox

- [ ] Citation accuracy eval harness (extend `eval/`).
- [ ] Keyboard shortcuts (new chat, focus search, send).
- [ ] Dark mode.
