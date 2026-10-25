import Nav from "../components/Nav";
import ChatLauncher from "../components/ChatLauncher";

/** The light operations workspace: sidebar navigation around the existing pages, Ask StockLens as a chat bubble. */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <Nav />
      <main className="main">{children}</main>
      <ChatLauncher />
    </div>
  );
}
