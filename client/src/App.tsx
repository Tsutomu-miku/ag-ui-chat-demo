import { useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { useThreads } from "./hooks/useThreads";

export default function App() {
  const threads = useThreads();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="app">
      <Sidebar
        threads={threads.list}
        activeThreadId={threads.activeId}
        onNewChat={threads.create}
        onSelectThread={threads.select}
        onDeleteThread={threads.remove}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />
      <ChatPanel
        thread={threads.active}
        threadActions={threads}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />
    </div>
  );
}
