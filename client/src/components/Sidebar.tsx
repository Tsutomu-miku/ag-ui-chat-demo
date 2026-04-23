import type { ThreadSummary } from "ag-ui-react";

interface SidebarProps {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onNewChat: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

export function Sidebar({
  threads,
  activeThreadId,
  onNewChat,
  onSelectThread,
  onDeleteThread,
  isOpen,
  onToggle,
}: SidebarProps) {
  if (!isOpen) return null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>AG-UI Chat</h2>
        <button className="icon-btn" onClick={onToggle} title="Close sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg>
        </button>
      </div>

      <button className="new-chat-btn" onClick={onNewChat}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Chat
      </button>

      <div className="thread-list">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`thread-item ${thread.id === activeThreadId ? "active" : ""}`}
            onClick={() => onSelectThread(thread.id)}
          >
            <span className="thread-title">{thread.title}</span>
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteThread(thread.id);
              }}
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>
          </div>
        ))}

        {threads.length === 0 && (
          <div className="empty-threads">
            <p>No conversations yet</p>
            <p className="muted">Start a new chat to begin</p>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="protocol-badge">
          ⚡ Powered by <strong>AG-UI Protocol</strong>
        </div>
      </div>
    </aside>
  );
}
