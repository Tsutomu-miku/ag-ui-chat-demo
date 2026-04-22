import React from "react";

interface Thread {
  id: string;
  title: string;
  updatedAt?: string;
}

interface SidebarProps {
  threads: Thread[];
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
          \u2715
        </button>
      </div>

      <button className="new-chat-btn" onClick={onNewChat}>
        + New Chat
      </button>

      <div className="thread-list">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`thread-item ${
              thread.id === activeThreadId ? "active" : ""
            }`}
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
              \u{1F5D1}
            </button>
          </div>
        ))}

        {threads.length === 0 && (
          <div className="empty-threads">
            <p>No conversations yet</p>
            <p>Start a new chat!</p>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="protocol-badge">
          <span>Powered by AG-UI Protocol</span>
        </div>
      </div>
    </aside>
  );
}
