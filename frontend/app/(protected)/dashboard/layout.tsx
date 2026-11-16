import SideBar from "@/Components/SidBar/SideBar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-[#060b1f]">
      <SideBar />
      <main className="flex-1 w-full sm:ml-64">
        {children}
      </main>
    </div>
  );
}